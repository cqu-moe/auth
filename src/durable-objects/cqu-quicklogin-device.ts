import { DeviceV3Store, V3Error, settleV3Operation, sessionTuple } from "../services/quicklogin/device-v3-store";
import { sameTuple, type VersionTuple, type ReasonCode } from "../services/quicklogin/protocol-v3";
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import {
  CQU_PROACTIVE_RELOGIN_MS,
  sampleCquReloginAt,
} from "../services/cqu-maintenance-policy";
import { QuickloginAccountClient } from "../services/quicklogin/account-client";
import {
  digestSsoCookies,
  extractSsoCookies,
} from "../services/quicklogin/cookie-envelope";
import type {
  CookieEnvelope,
  DeviceAuthority,
  ErrorCode,
  StoredDeviceSession,
} from "../services/quicklogin/contracts";
import { INACTIVE_MS } from "../services/quicklogin/contracts";
import { QuickloginLoginBrokerClient } from "../services/quicklogin/login-broker-client";
import { quickloginDeviceModeEnabled } from "../services/quicklogin/mode";
import {
  nextDeviceAction,
  nextQuickloginRetryDelayMs,
  QUICKLOGIN_RETRY_CAP_MS,
} from "../services/quicklogin/maintenance";
import { BROWSER_CLEANUP_MARGIN_MS } from "../services/cqu-browser-budget";

const SESSION_KEY = "session";
const OWNER_KEY = "owner";
const PENDING_KEEPALIVE_STATE_KEY = "pendingKeepaliveState";

interface DeviceOwner {
  userId: string;
  deviceId: string;
}

class DeviceDoError extends Error {
  constructor(public readonly code: ErrorCode) {
    super(code);
    this.name = "DeviceDoError";
  }
}

function emptySession(authority: DeviceAuthority): StoredDeviceSession {
  return {
    schemaVersion: 1,
    ownerUserId: authority.ownerUserId,
    deviceId: authority.deviceId,
    generation: authority.generation,
    bindingEpoch: 0,
    sessionVersion: 0,
    state: authority.enabled ? "preparing" : "disabled",
    loginAt: null,
    lastKeepAliveAt: null,
    storageState: null,
    exportDigest: null,
    transientFailures: 0,
    transientStartedAt: null,
    fastRetries: 0,
    nextAttemptAt: null,
  };
}

export class CquQuickloginDeviceDO extends DurableObject<Env> {
  private owner: DeviceOwner | null = null;
  private loginInFlight: Promise<void> | null = null;

  private nextMaintenanceAt(session: StoredDeviceSession, authority: DeviceAuthority): number {
    const now = Date.now();
    const renewalAt = session.loginAt !== null && session.state !== "needs_reauth"
      ? Math.min(
          session.reloginAt ?? session.loginAt + CQU_PROACTIVE_RELOGIN_MS,
          session.loginAt + CQU_PROACTIVE_RELOGIN_MS
        )
      : (authority.lastSeenAt ?? now) + INACTIVE_MS;
    return Math.max(now + 1_000, Math.min(
      session.nextAttemptAt !== null && session.nextAttemptAt > now ? session.nextAttemptAt : renewalAt,
      authority.lastSeenAt === null ? Infinity : authority.lastSeenAt + INACTIVE_MS
    ));
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.owner = (await ctx.storage.get<DeviceOwner>(OWNER_KEY)) ?? null;
    });
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const body = await request.json<{
        operation: string;
        ownerUserId: string;
        deviceId: string;
        payload?: {
          authority?: DeviceAuthority;
          kind?: "status" | "export" | "refresh";
          limit?: number;
          now?: number;
          input?: unknown;
          expected?: VersionTuple;
          operationId?: string;
        };
      }>();
      await this.ensureOwner(body.ownerUserId, body.deviceId);
      let result: unknown;
      const v3 = new DeviceV3Store(this.ctx.storage, this.env, a => this.notify(a));
      if (body.operation.startsWith("v3_")) {
        if (!body.payload?.authority) throw new V3Error("INVALID_REQUEST");
        const a = body.payload.authority;
        switch (body.operation) {
          case "v3_read": result = await v3.read(a); break;
          case "v3_operation": result = await v3.operation(a, body.payload.input); break;
          case "v3_operation_read": result = await v3.getOperation(a, body.payload.operationId ?? ""); break;
          case "v3_export": if (!body.payload.expected) throw new V3Error("INVALID_REQUEST"); result = await v3.export(a, body.payload.expected); break;
          case "v3_receipt": result = await v3.receipt(a, body.payload.input); break;
          case "v3_report": result = await v3.report(a, body.payload.input); break;
          default: throw new V3Error("INVALID_REQUEST");
        }
        return Response.json({ result });
      }
      switch (body.operation) {
        case "notify":
          if (!body.payload?.authority) throw new DeviceDoError("INVALID_REQUEST");
          result = await this.notify(body.payload.authority);
          break;
        case "read":
          result = await this.readSession();
          break;
        case "refresh":
          if (!body.payload?.authority) throw new DeviceDoError("INVALID_REQUEST");
          await this.requestRefresh(body.payload.authority);
          break;
        case "export":
          if (!body.payload?.authority) throw new DeviceDoError("INVALID_REQUEST");
          result = await this.exportCookies(body.payload.authority);
          break;
        case "rate":
          if (!body.payload?.kind ||
              !Number.isSafeInteger(body.payload.limit) ||
              !Number.isSafeInteger(body.payload.now)) {
            throw new DeviceDoError("INVALID_REQUEST");
          }
          await this.consumeRateLimit(
            body.payload.kind,
            body.payload.limit as number,
            body.payload.now as number
          );
          break;
        default:
          throw new DeviceDoError("INVALID_REQUEST");
      }
      return Response.json({ result });
    } catch (error) {
      const code = error instanceof DeviceDoError || error instanceof V3Error
        ? error.code
        : "TEMPORARY_UNAVAILABLE";
      const status = code === "RATE_LIMITED" ? 429 :
        code === "PREPARING" ? 409 :
        code === "INVALID_REQUEST" ? 422 : 403;
      return Response.json({ error: { code, message: code, ...(error instanceof V3Error ? { retryAt: error.retryAt } : {}) } }, { status });
    }
  }

  async alarm(): Promise<void> {
    if (!quickloginDeviceModeEnabled(this.env)) {
      await this.ctx.storage.transaction(async (tx) => {
        const session = await tx.get<StoredDeviceSession>(SESSION_KEY);
        if (session?.pendingKeepaliveMint) {
          delete session.pendingKeepaliveMint;
          await tx.put(SESSION_KEY, session);
        }
        await tx.delete(PENDING_KEEPALIVE_STATE_KEY);
      });
      await this.ctx.storage.deleteAlarm();
      return;
    }
    if (!this.owner) return;
    let session = await this.ctx.storage.get<StoredDeviceSession>(SESSION_KEY);
    if (!session) return;
    if (session.operationId) {
      const a = await new QuickloginAccountClient(this.env).getDeviceAuthority(this.owner.userId, this.owner.deviceId);
      const read = await new DeviceV3Store(this.ctx.storage, this.env, value => this.notify(value)).read(a);
      session = read.session;
      if (read.operation?.state === "running" && read.operation.deadlineAt !== null && read.operation.deadlineAt + BROWSER_CLEANUP_MARGIN_MS > Date.now()) {
        await this.ctx.storage.setAlarm(read.operation.deadlineAt + BROWSER_CLEANUP_MARGIN_MS);
        return;
      }
    }
    await this.recoverPendingKeepalive(session, Date.now());
    const authority = await new QuickloginAccountClient(this.env)
      .getDeviceAuthority(this.owner.userId, this.owner.deviceId);
    if (authority.allowed && authority.generation === session.generation) {
      session = await this.ensureReloginAt(session);
    }
    const action = nextDeviceAction(session, authority, Date.now());
    if (action === "stop") {
      await this.notify(authority);
      return;
    }
    if (action === "pause_inactive") {
      await this.ctx.storage.transaction(async (tx) => {
        const current = await tx.get<StoredDeviceSession>(SESSION_KEY);
        if (!current || current.state === "disabled" || current.state === "revoked") return;
        current.state = "paused";
        await tx.put(SESSION_KEY, current);
      });
      await this.ctx.storage.deleteAlarm();
      return;
    }
    if (session.pendingKeepaliveMint && action !== "login") {
      // Keep renewal scheduled even if the legacy receipt RPC exhausts alarm retries.
      await this.ctx.storage.transaction(async (tx) => {
        const current = await tx.get<StoredDeviceSession>(SESSION_KEY);
        if (!current || !sameTuple(sessionTuple(current), sessionTuple(session)) ||
            current.state !== session.state || current.state === "paused" ||
            current.state === "disabled" || current.state === "revoked" ||
            !quickloginDeviceModeEnabled(this.env)) return;
        await tx.setAlarm(this.nextMaintenanceAt(current, authority));
      });
      await this.confirmKeepaliveMint(session, authority);
      return;
    }
    if (action === "wait") {
      await this.ctx.storage.setAlarm(this.nextMaintenanceAt(session, authority));
      return;
    }
    if (action === "login") {
      await this.performLogin(session, authority);
      return;
    }
  }

  private async ensureOwner(userId: string, deviceId: string): Promise<void> {
    if (this.owner) {
      if (this.owner.userId !== userId || this.owner.deviceId !== deviceId) {
        throw new DeviceDoError("FORBIDDEN");
      }
      return;
    }
    this.owner = { userId, deviceId };
    await this.ctx.storage.put(OWNER_KEY, this.owner);
  }

  private async ensureReloginAt(session: StoredDeviceSession): Promise<StoredDeviceSession> {
    if (session.loginAt === null || session.reloginAt !== undefined) return session;
    return this.ctx.storage.transaction(async (tx) => {
      const current = await tx.get<StoredDeviceSession>(SESSION_KEY);
      if (!current || current.loginAt === null || current.reloginAt !== undefined ||
          current.state === "disabled" || current.state === "revoked") {
        return current ?? session;
      }
      const next = { ...current, reloginAt: sampleCquReloginAt(current.loginAt) };
      await tx.put(SESSION_KEY, next);
      return next;
    });
  }

  private async readSession(): Promise<StoredDeviceSession> {
    const session = await this.ctx.storage.get<StoredDeviceSession>(SESSION_KEY);
    if (!session) throw new DeviceDoError("PREPARING");
    const now = Date.now();
    await this.recoverPendingKeepalive(session, now);
    if (
      session.state === "temporary_unavailable" &&
      session.nextAttemptAt !== null &&
      session.nextAttemptAt - now > QUICKLOGIN_RETRY_CAP_MS
    ) {
      session.nextAttemptAt = null;
      await this.ctx.storage.put(SESSION_KEY, session);
      await this.ctx.storage.setAlarm(now);
    }
    return session;
  }

  private async consumeRateLimit(
    kind: "status" | "export" | "refresh",
    limit: number,
    now: number
  ): Promise<void> {
    if (limit <= 0 || now < 0) throw new DeviceDoError("INVALID_REQUEST");
    const key = `rate:${kind}`;
    const bucket = Math.floor(now / 60_000);
    const current =
      (await this.ctx.storage.get<{ bucket: number; count: number }>(key)) ??
      null;
    const count = current?.bucket === bucket ? current.count : 0;
    if (count >= limit) throw new DeviceDoError("RATE_LIMITED");
    await this.ctx.storage.put(key, { bucket, count: count + 1 });
  }

  private async recordTransient(session: StoredDeviceSession, reasonCode: ReasonCode = "SCHOOL_UNREACHABLE", retryAfterMs = 0): Promise<void> {
    const now = Date.now();
    await this.ctx.storage.transaction(async (tx) => {
      const current = await tx.get<StoredDeviceSession>(SESSION_KEY);
      if (!current || !sameTuple(sessionTuple(current), sessionTuple(session)) ||
          current.operationId !== session.operationId || current.leaseToken !== session.leaseToken ||
          current.state === "disabled" || current.state === "revoked" ||
          !quickloginDeviceModeEnabled(this.env)) return;
      const next = { ...current };
      next.state = "temporary_unavailable";
      next.transientFailures += 1;
      next.transientStartedAt ??= now;
      const delay = nextQuickloginRetryDelayMs(next.transientStartedAt, now);
      next.nextAttemptAt = now + Math.max(delay, retryAfterMs);
      next.reasonCode = reasonCode;
      next.deviceRevision = (next.deviceRevision ?? 0) + 1;
      await tx.put(SESSION_KEY, next);
      await settleV3Operation(tx, next);
      await tx.setAlarm(next.nextAttemptAt);
    });
  }

  private async requestRefresh(authority: DeviceAuthority): Promise<void> {
    await this.notify(authority);
    if (!authority.allowed) return;
    let scheduled = false;
    await this.ctx.storage.transaction(async (tx) => {
      const current = await tx.get<StoredDeviceSession>(SESSION_KEY);
      if (!current || current.generation !== authority.generation ||
          current.state === "disabled" || current.state === "revoked" ||
          !quickloginDeviceModeEnabled(this.env)) return;
      current.state = current.storageState ? "refreshing" : "preparing";
      current.nextAttemptAt = null;
      await tx.put(SESSION_KEY, current);
      scheduled = true;
    });
    if (scheduled) await this.ctx.storage.setAlarm(Date.now());
  }

  private async confirmKeepaliveMint(
    session: StoredDeviceSession,
    authority: DeviceAuthority
  ): Promise<void> {
    const pending = session.pendingKeepaliveMint;
    if (!pending) return;
    const pendingStorageState = pending.hasStorageState
      ? await this.ctx.storage.get<string>(PENDING_KEEPALIVE_STATE_KEY)
      : undefined;
    await new QuickloginLoginBrokerClient(this.env)
      .recordQuickloginKeepaliveMint(authority.ownerUserId, {
        deviceId: authority.deviceId,
        operationId: pending.operationId,
        mintedAt: pending.mintedAt,
      });
    if (pendingStorageState !== undefined) {
      const serialized = pendingStorageState;
      const cookies = extractSsoCookies(serialized, Date.now());
      const digest = await digestSsoCookies(cookies);
      session.storageState = serialized;
      session.exportDigest = digest;
    }
    let committed = false;
    await this.ctx.storage.transaction(async (tx) => {
      const current = await tx.get<StoredDeviceSession>(SESSION_KEY);
      if (!current || !sameTuple(sessionTuple(current), sessionTuple(session)) ||
          current.operationId !== session.operationId || current.leaseToken !== session.leaseToken ||
          current.state !== session.state ||
          current.pendingKeepaliveMint?.operationId !== pending.operationId ||
          current.state === "disabled" || current.state === "revoked" ||
          !quickloginDeviceModeEnabled(this.env)) return;
      const next = { ...current };
      if (pendingStorageState !== undefined) {
        if (session.exportDigest !== current.exportDigest) next.sessionVersion += 1;
        next.storageState = session.storageState;
        next.exportDigest = session.exportDigest;
      }
      next.reasonCode = null;
      if (next.loginAt !== null && next.reloginAt === undefined) {
        next.reloginAt = sampleCquReloginAt(next.loginAt);
      }
      next.deviceRevision = (next.deviceRevision ?? 0) + 1;
      next.lastKeepAliveAt = pending.mintedAt;
      next.state = "ready";
      next.transientFailures = 0;
      next.transientStartedAt = null;
      next.fastRetries = 0;
      next.nextAttemptAt = null;
      delete next.pendingKeepaliveMint;
      await tx.put(SESSION_KEY, next);
      await tx.delete(PENDING_KEEPALIVE_STATE_KEY);
      session = next;
      committed = true;
    });
    if (committed) {
      await this.ctx.storage.setAlarm(this.nextMaintenanceAt(session, authority));
    }
  }

  private async recoverPendingKeepalive(
    session: StoredDeviceSession,
    now: number
  ): Promise<void> {
    const pending = session.pendingKeepaliveMint;
    if (pending && pending.expiresAt > now) return;
    await this.ctx.storage.transaction(async (tx) => {
      const current = await tx.get<StoredDeviceSession>(SESSION_KEY);
      if (current?.pendingKeepaliveMint && current.pendingKeepaliveMint.expiresAt > now) return;
      if (current?.pendingKeepaliveMint) {
        delete current.pendingKeepaliveMint;
        await tx.put(SESSION_KEY, current);
      }
      await tx.delete(PENDING_KEEPALIVE_STATE_KEY);
      if (pending) delete session.pendingKeepaliveMint;
    });
  }

  private async performLogin(
    session: StoredDeviceSession,
    authority: DeviceAuthority
  ): Promise<void> {
    if (this.loginInFlight) return this.loginInFlight;
    const operation = this.performLoginOnce(session, authority);
    this.loginInFlight = operation;
    try {
      await operation;
    } finally {
      if (this.loginInFlight === operation) this.loginInFlight = null;
    }
  }

  private async performLoginOnce(
    session: StoredDeviceSession,
    authority: DeviceAuthority
  ): Promise<void> {
    let started = false;
    await this.ctx.storage.transaction(async (tx) => {
      const current = await tx.get<StoredDeviceSession>(SESSION_KEY);
      if (!current || !sameTuple(sessionTuple(current), sessionTuple(session)) ||
          current.operationId !== session.operationId || current.leaseToken !== session.leaseToken ||
          current.state === "disabled" || current.state === "revoked" ||
          !quickloginDeviceModeEnabled(this.env)) return;
      await tx.put(SESSION_KEY, {
        ...current,
        state: current.storageState ? "refreshing" : "preparing",
        reasonCode: null,
      });
      started = true;
    });
    if (!started) return;
    const v3 = new DeviceV3Store(this.ctx.storage, this.env, a => this.notify(a));
    const running = await v3.markRunning(session, authority);
    if (!running) return;
    session = running;
    try {
      const result = await new QuickloginLoginBrokerClient(this.env)
        .quickloginLogin({
          ownerUserId: authority.ownerUserId,
          deviceId: authority.deviceId,
          generation: authority.generation,
          seedState: session.storageState,
          operationId: session.operationId,
        });
      const current = await new QuickloginAccountClient(this.env)
        .getDeviceAuthority(authority.ownerUserId, authority.deviceId);
      if (!current.allowed || current.generation !== authority.generation) {
        await this.notify(current);
        return;
      }
      if (result.kind === "needs_reauth") {
        let committed = false;
        await this.ctx.storage.transaction(async (tx) => {
          const currentSession = await tx.get<StoredDeviceSession>(SESSION_KEY);
          if (!currentSession || currentSession.generation !== session.generation ||
              (session.operationId !== undefined && (currentSession.operationId !== session.operationId || currentSession.leaseToken !== session.leaseToken)) ||
              currentSession.state === "disabled" || currentSession.state === "revoked" ||
              !quickloginDeviceModeEnabled(this.env)) return;
          const next: StoredDeviceSession = {
            ...currentSession,
            state: "needs_reauth",
            reasonCode: result.reason === "unbound" ? "BINDING_UNBOUND" : result.reason === "credentials_rejected" ? "CREDENTIALS_REJECTED" : "INTERACTION_REQUIRED",
            deviceRevision: (currentSession.deviceRevision ?? 0) + 1,
            storageState: result.reason === "unbound" ? null : currentSession.storageState,
            exportDigest: result.reason === "unbound" ? null : currentSession.exportDigest,
            transientFailures: 0,
            transientStartedAt: null,
          };
          await tx.put(SESSION_KEY, next);
          await settleV3Operation(tx, next);
          committed = true;
        });
        if (committed) { await this.ctx.storage.deleteAlarm(); await v3.finish(await this.readSession()); }
        return;
      }
      if (result.kind !== "success") {
        await this.recordTransient(session, result.kind === "temporary_unavailable" ? result.reasonCode ?? "SCHOOL_UNREACHABLE" : "OPERATION_CANCELLED", result.kind === "temporary_unavailable" ? result.retryAfterMs : 60_000);
        await v3.finish(await this.readSession());
        return;
      }
      const cookies = extractSsoCookies(result.storageState, Date.now());
      const digest = await digestSsoCookies(cookies);
      const binding = await new QuickloginLoginBrokerClient(this.env).getBindingSnapshot(authority.ownerUserId);
      if (binding.state !== "bound" || binding.bindingEpoch !== result.bindingEpoch || binding.credentialRevision !== (result.credentialRevision ?? result.bindingEpoch)) {
        await this.recordTransient(session, "BINDING_CHANGED", 60_000);
        return;
      }
      let committed = false;
      await this.ctx.storage.transaction(async (tx) => {
        const currentSession = await tx.get<StoredDeviceSession>(SESSION_KEY);
        if (!currentSession || currentSession.generation !== session.generation ||
              (session.operationId !== undefined && (currentSession.operationId !== session.operationId || currentSession.leaseToken !== session.leaseToken)) ||
            currentSession.state === "disabled" || currentSession.state === "revoked" ||
            !quickloginDeviceModeEnabled(this.env)) return;
        const next: StoredDeviceSession = {
          ...currentSession,
          bindingEpoch: result.bindingEpoch,
          credentialRevision: result.credentialRevision ?? result.bindingEpoch,
          reasonCode: null,
          deviceRevision: (currentSession.deviceRevision ?? 0) + 1,
          storageState: result.storageState,
          exportDigest: digest,
          sessionVersion: currentSession.sessionVersion + 1,
          loginAt: result.loginAt,
          reloginAt: sampleCquReloginAt(result.loginAt),
          lastKeepAliveAt: result.loginAt,
          state: "ready",
          transientFailures: 0,
          transientStartedAt: null,
          fastRetries: 0,
          nextAttemptAt: null,
        };
        await tx.put(SESSION_KEY, next);
        await settleV3Operation(tx, next);
        committed = true;
      });
      if (committed) {
        const current = await this.readSession();
        await this.ctx.storage.setAlarm(this.nextMaintenanceAt(current, authority));
        await v3.finish(current);
      }
    } catch (error) {
      const reason = error instanceof Error && ["INVALID_REQUEST", "PROTOCOL_UNSUPPORTED"].includes(error.message)
        ? "CONTRACT_INVALID" : "INTERNAL_STATE_UNAVAILABLE";
      console.warn(JSON.stringify({ event: "quicklogin.result_processing_failed", reasonCode: reason, operationId: session.operationId ?? null }));
      await this.recordTransient(session, reason, 60_000);
    }
  }

  private async notify(authority: DeviceAuthority): Promise<void> {
    await this.ensureOwner(authority.ownerUserId, authority.deviceId);
    const current =
      (await this.ctx.storage.get<StoredDeviceSession>(SESSION_KEY)) ??
      emptySession(authority);
    if (authority.generation < current.generation) return;
    const next = { ...current, generation: authority.generation, deviceRevision: (current.deviceRevision ?? 0) + 1 };
    if (authority.generation !== current.generation || !authority.allowed) { delete next.operationId; delete next.leaseToken; }
    if (
      authority.generation !== current.generation ||
      !authority.allowed ||
      !quickloginDeviceModeEnabled(this.env)
    ) {
      delete next.pendingKeepaliveMint;
    }
    if (!quickloginDeviceModeEnabled(this.env)) {
      next.state = authority.enabled ? "paused" : "disabled";
      await this.ctx.storage.transaction(async (tx) => {
        await tx.put(SESSION_KEY, next);
        if (!next.pendingKeepaliveMint) {
          await tx.delete(PENDING_KEEPALIVE_STATE_KEY);
        }
      });
      await this.ctx.storage.deleteAlarm();
      return;
    }
    if (authority.reason === "DEVICE_REVOKED") {
      next.state = "revoked";
      next.storageState = null;
      next.exportDigest = null;
      await this.ctx.storage.deleteAlarm();
    } else if (!authority.enabled) {
      next.state = "disabled";
      next.storageState = null;
      next.exportDigest = null;
      await this.ctx.storage.deleteAlarm();
    } else if (!authority.masterEnabled) {
      next.state = "paused";
      await this.ctx.storage.deleteAlarm();
    } else {
      next.state = next.storageState ? "ready" : "preparing";
      await this.ctx.storage.setAlarm(Date.now());
    }
    await this.ctx.storage.transaction(async (tx) => {
      await tx.put(SESSION_KEY, next);
      if (!next.pendingKeepaliveMint) {
        await tx.delete(PENDING_KEEPALIVE_STATE_KEY);
      }
    });
  }

  private async exportCookies(
    authority: DeviceAuthority
  ): Promise<CookieEnvelope> {
    const accounts = new QuickloginAccountClient(this.env);
    const before = await accounts.getDeviceAuthority(
      authority.ownerUserId,
      authority.deviceId
    );
    if (!before.allowed) throw new DeviceDoError(before.reason ?? "FORBIDDEN");
    const session = await this.readSession();
    if (
      session.state !== "ready" ||
      session.generation !== before.generation ||
      !session.storageState
    ) {
      throw new DeviceDoError("PREPARING");
    }
    const binding = await new QuickloginLoginBrokerClient(this.env)
      .getQuickloginBindingEpoch(before.ownerUserId);
    if (!binding.bound || binding.epoch !== session.bindingEpoch) {
      throw new DeviceDoError("NEEDS_REAUTH");
    }
    const cookies = extractSsoCookies(session.storageState, Date.now());
    const after = await accounts.getDeviceAuthority(
      authority.ownerUserId,
      authority.deviceId
    );
    if (!after.allowed || after.generation !== session.generation) {
      throw new DeviceDoError(after.reason ?? "STALE_GENERATION");
    }
    return {
      protocolVersion: 2,
      deviceId: session.deviceId,
      generation: session.generation,
      sessionVersion: session.sessionVersion,
      createdAt: Date.now(),
      cookies,
    };
  }
}
