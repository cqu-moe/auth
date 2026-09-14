import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
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
import { QuickloginLoginBrokerClient } from "../services/quicklogin/login-broker-client";
import { quickloginDeviceModeEnabled } from "../services/quicklogin/mode";
import {
  nextDeviceAction,
  nextQuickloginRetryDelayMs,
  QUICKLOGIN_RETRY_CAP_MS,
} from "../services/quicklogin/maintenance";
import { fetchBrowser } from "../services/cqu-browser-routing";
import {
  BROWSER_CLEANUP_MARGIN_MS,
  CONTAINER_BROWSER_DEADLINE_MS,
} from "../services/cqu-browser-budget";
import { quickloginBrowserRoute } from "../services/quicklogin/browser-routing";

const SESSION_KEY = "session";
const OWNER_KEY = "owner";
const PENDING_KEEPALIVE_STATE_KEY = "pendingKeepaliveState";
const KEEPALIVE_MS = 60 * 60_000;
const PENDING_KEEPALIVE_TTL_MS = 24 * 60 * 60_000;

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
        };
      }>();
      await this.ensureOwner(body.ownerUserId, body.deviceId);
      let result: unknown;
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
      const code = error instanceof DeviceDoError
        ? error.code
        : "TEMPORARY_UNAVAILABLE";
      const status = code === "RATE_LIMITED" ? 429 :
        code === "PREPARING" ? 409 :
        code === "INVALID_REQUEST" ? 422 : 403;
      return Response.json({ error: { code, message: code } }, { status });
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
    const session = await this.ctx.storage.get<StoredDeviceSession>(SESSION_KEY);
    if (!session) return;
    await this.recoverPendingKeepalive(session, Date.now());
    const authority = await new QuickloginAccountClient(this.env)
      .getDeviceAuthority(this.owner.userId, this.owner.deviceId);
    const action = nextDeviceAction(session, authority, Date.now());
    if (action === "stop") {
      await this.notify(authority);
      return;
    }
    if (action === "pause_inactive") {
      session.state = "paused";
      await this.ctx.storage.put(SESSION_KEY, session);
      await this.ctx.storage.deleteAlarm();
      return;
    }
    if (action === "wait") {
      await this.ctx.storage.setAlarm(
        session.nextAttemptAt ?? Date.now() + KEEPALIVE_MS
      );
      return;
    }
    if (action === "login") {
      await this.performLogin(session, authority);
      return;
    }
    await this.performKeepalive(session, authority);
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

  private async recordTransient(session: StoredDeviceSession): Promise<void> {
    const now = Date.now();
    await this.ctx.storage.transaction(async (tx) => {
      const current = await tx.get<StoredDeviceSession>(SESSION_KEY);
      if (!current || current.generation !== session.generation ||
          current.state === "disabled" || current.state === "revoked" ||
          !quickloginDeviceModeEnabled(this.env)) return;
      const next = { ...current };
      next.state = "temporary_unavailable";
      next.transientFailures += 1;
      next.transientStartedAt ??= now;
      const delay = nextQuickloginRetryDelayMs(next.transientStartedAt, now);
      next.nextAttemptAt = now + delay;
      await tx.put(SESSION_KEY, next);
      await tx.setAlarm(next.nextAttemptAt);
    });
  }

  private async requestRefresh(authority: DeviceAuthority): Promise<void> {
    await this.notify(authority);
    if (!authority.allowed) return;
    const session = await this.ctx.storage.get<StoredDeviceSession>(SESSION_KEY);
    if (!session || session.generation !== authority.generation) return;
    session.state = session.storageState ? "refreshing" : "preparing";
    session.nextAttemptAt = null;
    await this.ctx.storage.put(SESSION_KEY, session);
    await this.ctx.storage.setAlarm(Date.now());
  }

  private async performKeepalive(
    session: StoredDeviceSession,
    authority: DeviceAuthority
  ): Promise<void> {
    if (session.pendingKeepaliveMint) {
      await this.confirmKeepaliveMint(session, authority);
      return;
    }
    if (!session.storageState) {
      await this.performLogin(session, authority);
      return;
    }
    let response: Response;
    try {
      response = await fetchBrowser(
        this.env,
        quickloginBrowserRoute(authority.ownerUserId, authority.deviceId),
        new Request("http://cqu-login.internal/keepalive", {
          method: "POST",
          body: JSON.stringify({
            state: JSON.parse(session.storageState),
            operationTimeoutMs:
              CONTAINER_BROWSER_DEADLINE_MS - BROWSER_CLEANUP_MARGIN_MS,
          }),
          signal: AbortSignal.timeout(CONTAINER_BROWSER_DEADLINE_MS),
        })
      );
    } catch {
      await this.recordTransient(session);
      return;
    }
    const body = await response.json<{
      ok?: boolean;
      status?: string;
      state?: unknown;
    }>().catch(() => null);
    if (!response.ok || !body?.ok || body.status === "unreachable") {
      console.warn({
        evt: "quicklogin_maintenance_failure",
        phase: "keepalive_response",
        deviceId: authority.deviceId,
        generation: authority.generation,
        httpStatus: response.status,
        backendStatus:
          body?.status === "alive" ||
          body?.status === "expired" ||
          body?.status === "unreachable"
            ? body.status
            : null,
      });
      await this.recordTransient(session);
      return;
    }
    if (body.status === "expired") {
      await this.performLogin(session, authority);
      return;
    }
    if (body.status !== "alive") {
      await this.recordTransient(session);
      return;
    }
    const current = await new QuickloginAccountClient(this.env)
      .getDeviceAuthority(authority.ownerUserId, authority.deviceId);
    if (!current.allowed || current.generation !== session.generation) {
      await this.notify(current);
      return;
    }
    session.pendingKeepaliveMint = {
      operationId: crypto.randomUUID(),
      mintedAt: Date.now(),
      expiresAt: Date.now() + PENDING_KEEPALIVE_TTL_MS,
      hasStorageState: body.state !== undefined,
    };
    const pendingStorageState = body.state === undefined
      ? undefined
      : JSON.stringify(body.state);
    await this.ctx.storage.transaction(async (tx) => {
      await tx.put(SESSION_KEY, session);
      if (pendingStorageState === undefined) {
        await tx.delete(PENDING_KEEPALIVE_STATE_KEY);
      } else {
        await tx.put(PENDING_KEEPALIVE_STATE_KEY, pendingStorageState);
      }
    });
    await this.confirmKeepaliveMint(session, authority);
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
      if (!current || current.generation !== session.generation ||
          current.pendingKeepaliveMint?.operationId !== pending.operationId ||
          current.state === "disabled" || current.state === "revoked" ||
          !quickloginDeviceModeEnabled(this.env)) return;
      const next = { ...current };
      if (pendingStorageState !== undefined) {
        if (session.exportDigest !== current.exportDigest) next.sessionVersion += 1;
        next.storageState = session.storageState;
        next.exportDigest = session.exportDigest;
      }
      next.lastKeepAliveAt = pending.mintedAt;
      next.state = "ready";
      next.transientFailures = 0;
      next.transientStartedAt = null;
      next.fastRetries = 0;
      next.nextAttemptAt = null;
      delete next.pendingKeepaliveMint;
      await tx.put(SESSION_KEY, next);
      await tx.delete(PENDING_KEEPALIVE_STATE_KEY);
      committed = true;
    });
    if (committed) await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_MS);
  }

  private async recoverPendingKeepalive(
    session: StoredDeviceSession,
    now: number
  ): Promise<void> {
    const pending = session.pendingKeepaliveMint;
    if (pending && pending.expiresAt > now) return;
    if (pending) delete session.pendingKeepaliveMint;
    await this.ctx.storage.transaction(async (tx) => {
      if (pending) await tx.put(SESSION_KEY, session);
      await tx.delete(PENDING_KEEPALIVE_STATE_KEY);
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
      if (!current || current.generation !== session.generation ||
          current.state === "disabled" || current.state === "revoked" ||
          !quickloginDeviceModeEnabled(this.env)) return;
      await tx.put(SESSION_KEY, {
        ...current,
        state: current.storageState ? "refreshing" : "preparing",
      });
      started = true;
    });
    if (!started) return;
    const result = await new QuickloginLoginBrokerClient(this.env)
      .quickloginLogin({
        ownerUserId: authority.ownerUserId,
        deviceId: authority.deviceId,
        generation: authority.generation,
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
            currentSession.state === "disabled" || currentSession.state === "revoked" ||
            !quickloginDeviceModeEnabled(this.env)) return;
        await tx.put(SESSION_KEY, {
          ...currentSession,
          state: "needs_reauth",
          storageState: null,
          exportDigest: null,
          transientFailures: 0,
          transientStartedAt: null,
        });
        committed = true;
      });
      if (committed) await this.ctx.storage.deleteAlarm();
      return;
    }
    if (result.kind !== "success") {
      await this.recordTransient(session);
      return;
    }
    const cookies = extractSsoCookies(result.storageState, Date.now());
    const digest = await digestSsoCookies(cookies);
    let committed = false;
    await this.ctx.storage.transaction(async (tx) => {
      const currentSession = await tx.get<StoredDeviceSession>(SESSION_KEY);
      if (!currentSession || currentSession.generation !== session.generation ||
          currentSession.state === "disabled" || currentSession.state === "revoked" ||
          !quickloginDeviceModeEnabled(this.env)) return;
      await tx.put(SESSION_KEY, {
        ...currentSession,
        bindingEpoch: result.bindingEpoch,
        storageState: result.storageState,
        exportDigest: digest,
        sessionVersion: currentSession.sessionVersion + 1,
        loginAt: result.loginAt,
        lastKeepAliveAt: result.loginAt,
        state: "ready",
        transientFailures: 0,
        transientStartedAt: null,
        fastRetries: 0,
        nextAttemptAt: null,
      });
      committed = true;
    });
    if (committed) await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_MS);
  }

  private async notify(authority: DeviceAuthority): Promise<void> {
    await this.ensureOwner(authority.ownerUserId, authority.deviceId);
    const current =
      (await this.ctx.storage.get<StoredDeviceSession>(SESSION_KEY)) ??
      emptySession(authority);
    if (authority.generation < current.generation) return;
    const next = { ...current, generation: authority.generation };
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
