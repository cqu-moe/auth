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
import { nextDeviceAction } from "../services/quicklogin/maintenance";
import { fetchBrowser } from "../services/cqu-browser-routing";
import { quickloginBrowserRoute } from "../services/quicklogin/browser-routing";
import { nextKeepaliveDelayMs } from "../services/cqu-2fa/relogin-policy";

const SESSION_KEY = "session";
const OWNER_KEY = "owner";
const KEEPALIVE_MS = 60 * 60_000;

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
    fastRetries: 0,
    nextAttemptAt: null,
  };
}

export class CquQuickloginDeviceDO extends DurableObject<Env> {
  private owner: DeviceOwner | null = null;

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
          await this.notify(body.payload.authority);
          await this.ctx.storage.setAlarm(Date.now());
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
      await this.ctx.storage.deleteAlarm();
      return;
    }
    if (!this.owner) return;
    const session = await this.ctx.storage.get<StoredDeviceSession>(SESSION_KEY);
    if (!session) return;
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
    session.state = "temporary_unavailable";
    session.transientFailures += 1;
    const delay = nextKeepaliveDelayMs(session.transientFailures, {
      fastRetries: 2,
      fastMs: 60_000,
      baseMs: KEEPALIVE_MS,
      capMs: 6 * KEEPALIVE_MS,
    });
    session.nextAttemptAt = Date.now() + delay;
    await this.ctx.storage.put(SESSION_KEY, session);
    await this.ctx.storage.setAlarm(session.nextAttemptAt);
  }

  private async performKeepalive(
    session: StoredDeviceSession,
    authority: DeviceAuthority
  ): Promise<void> {
    if (!session.storageState) {
      await this.performLogin(session, authority);
      return;
    }
    const operationId = crypto.randomUUID();
    let response: Response;
    try {
      response = await fetchBrowser(
        this.env,
        quickloginBrowserRoute(authority.ownerUserId, authority.deviceId),
        new Request("http://cqu-login.internal/keepalive", {
          method: "POST",
          body: JSON.stringify({ state: JSON.parse(session.storageState) }),
          signal: AbortSignal.timeout(210_000),
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
    await new QuickloginLoginBrokerClient(this.env)
      .recordQuickloginKeepaliveMint(authority.ownerUserId, {
        deviceId: authority.deviceId,
        operationId,
        mintedAt: Date.now(),
      });
    if (body.state !== undefined) {
      const serialized = JSON.stringify(body.state);
      const cookies = extractSsoCookies(serialized, Date.now());
      const digest = await digestSsoCookies(cookies);
      if (digest !== session.exportDigest) session.sessionVersion += 1;
      session.storageState = serialized;
      session.exportDigest = digest;
    }
    session.lastKeepAliveAt = Date.now();
    session.state = "ready";
    session.transientFailures = 0;
    session.fastRetries = 0;
    session.nextAttemptAt = null;
    await this.ctx.storage.put(SESSION_KEY, session);
    await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_MS);
  }

  private async performLogin(
    session: StoredDeviceSession,
    authority: DeviceAuthority
  ): Promise<void> {
    session.state = session.storageState ? "refreshing" : "preparing";
    await this.ctx.storage.put(SESSION_KEY, session);
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
      session.state = "needs_reauth";
      session.storageState = null;
      session.exportDigest = null;
      await this.ctx.storage.put(SESSION_KEY, session);
      await this.ctx.storage.deleteAlarm();
      return;
    }
    if (result.kind !== "success") {
      session.state = "temporary_unavailable";
      session.transientFailures += 1;
      session.nextAttemptAt = Date.now() + 60_000;
      await this.ctx.storage.put(SESSION_KEY, session);
      await this.ctx.storage.setAlarm(session.nextAttemptAt);
      return;
    }
    const cookies = extractSsoCookies(result.storageState, Date.now());
    const digest = await digestSsoCookies(cookies);
    session.bindingEpoch = result.bindingEpoch;
    session.storageState = result.storageState;
    session.exportDigest = digest;
    session.sessionVersion += 1;
    session.loginAt = result.loginAt;
    session.lastKeepAliveAt = result.loginAt;
    session.state = "ready";
    session.transientFailures = 0;
    session.fastRetries = 0;
    session.nextAttemptAt = null;
    await this.ctx.storage.put(SESSION_KEY, session);
    await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_MS);
  }

  private async notify(authority: DeviceAuthority): Promise<void> {
    await this.ensureOwner(authority.ownerUserId, authority.deviceId);
    const current =
      (await this.ctx.storage.get<StoredDeviceSession>(SESSION_KEY)) ??
      emptySession(authority);
    if (authority.generation < current.generation) return;
    const next = { ...current, generation: authority.generation };
    if (!quickloginDeviceModeEnabled(this.env)) {
      next.state = authority.enabled ? "paused" : "disabled";
      await this.ctx.storage.put(SESSION_KEY, next);
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
    await this.ctx.storage.put(SESSION_KEY, next);
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
      protocolVersion: 1,
      deviceId: session.deviceId,
      generation: session.generation,
      sessionVersion: session.sessionVersion,
      createdAt: Date.now(),
      cookies,
    };
  }
}
