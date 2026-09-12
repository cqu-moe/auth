import { Hono, type Context } from "hono";
import type { HonoEnv } from "../types";
import { createAuth } from "../auth";
import {
  QuickloginAccountClient,
  QuickloginAccountClientError,
} from "../services/quicklogin/account-client";
import {
  QuickloginDeviceClient,
  QuickloginDeviceError,
} from "../services/quicklogin/device-client";
import {
  QuickloginDeviceAuthError,
  verifyQuickloginBearer,
} from "../middleware/quicklogin-device-auth";
import {
  getTrustedClientIp,
  parseDeviceMetadata,
  parseEnabled,
  parseExportRequest,
  parseHeartbeat,
  parseRefreshRequest,
  QuickloginHttpError,
  readJson,
} from "../services/quicklogin/http";
import type { DeviceAuthority, DeviceStatus, ErrorCode } from "../services/quicklogin/contracts";
import { quickloginDeviceModeEnabled } from "../services/quicklogin/mode";
import { hasQuickloginPolicy } from "../services/quicklogin/eligibility";

const router = new Hono<HonoEnv>();
const DEVICE_BASE_PATH = "/api/v1/cqu/quicklogin/devices";

function apiError(c: Context<HonoEnv>, code: ErrorCode, status: number) {
  return c.json({ error: { code, message: code } }, status as never);
}

function isDeviceOperation(method: string, pathname: string): boolean {
  if (!pathname.startsWith(DEVICE_BASE_PATH)) return false;
  const suffix = pathname.slice(DEVICE_BASE_PATH.length).replace(/\/$/, "");
  if (!suffix) return method === "GET" || method === "HEAD" || method === "POST";
  if (/^\/[^/]+$/.test(suffix)) return method === "PUT" || method === "DELETE";
  return /^\/[^/]+\/(status|refresh|export)$/.test(suffix) && method === "POST";
}

router.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  const origin = c.req.header("Origin");
  if (origin === c.env.QUICKLOGIN_EXTENSION_ORIGIN) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Vary", "Origin");
  }
  if (
    c.req.method !== "OPTIONS" &&
    isDeviceOperation(c.req.method, new URL(c.req.url).pathname) &&
    !quickloginDeviceModeEnabled(c.env)
  ) {
    return apiError(c, "TEMPORARY_UNAVAILABLE", 503);
  }
  await next();
});

const devicePreflight = (c: Context<HonoEnv>) => {
  if (c.req.header("Origin") !== c.env.QUICKLOGIN_EXTENSION_ORIGIN) {
    return apiError(c, "FORBIDDEN", 403);
  }
  c.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
  return c.body(null, 204);
};

for (const path of ["/", "/:id", "/:id/status", "/:id/refresh", "/:id/export"]) {
  router.options(path, devicePreflight);
}

async function devicePrincipal(c: Context<HonoEnv>) {
  if (c.req.header("Origin") !== c.env.QUICKLOGIN_EXTENSION_ORIGIN) {
    throw new QuickloginDeviceAuthError("FORBIDDEN");
  }
  return verifyQuickloginBearer(c.req.raw, c.env);
}

function requireWebsiteOrigin(c: Context<HonoEnv>) {
  if (c.req.header("Origin") !== new URL(c.env.BETTER_AUTH_URL).origin) {
    throw new QuickloginDeviceAuthError("FORBIDDEN");
  }
}

async function websiteUser(c: Context<HonoEnv>): Promise<{ id: string }> {
  if (c.req.header("Authorization")) {
    throw new QuickloginDeviceAuthError("UNAUTHORIZED");
  }
  const auth = createAuth(c.env, c.req.raw);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) throw new QuickloginDeviceAuthError("UNAUTHORIZED");
  if (!(await hasQuickloginPolicy(c.env.DATABASE, session.user.id))) {
    throw new QuickloginDeviceAuthError("FORBIDDEN");
  }
  return session.user;
}

async function statusFor(c: Context<HonoEnv>, authority: DeviceAuthority): Promise<DeviceStatus> {
  const list = await new QuickloginAccountClient(c.env)
    .listDevices(authority.ownerUserId, Date.now());
  let session = null;
  try {
    session = await new QuickloginDeviceClient(c.env)
      .readDeviceSession(authority.ownerUserId, authority.deviceId);
  } catch (error) {
    if (!(error instanceof QuickloginDeviceError) || error.code !== "PREPARING") throw error;
  }
  const device = list.devices.find((entry) => entry.deviceId === authority.deviceId);
  return {
    protocolVersion: 1,
    deviceId: authority.deviceId,
    generation: authority.generation,
    masterEnabled: authority.masterEnabled,
    enabled: authority.enabled,
    deviceLimit: list.deviceLimit,
    used: list.used,
    disabledReason: device?.disabledReason ?? null,
    state: session?.state ?? (authority.enabled ? "preparing" : "disabled"),
    sessionVersion: session?.sessionVersion ?? 0,
    appliedVersion: device?.appliedVersion ?? null,
    loginAt: session?.loginAt ?? null,
    lastKeepAliveAt: session?.lastKeepAliveAt ?? null,
    lastSeenAt: authority.lastSeenAt,
  };
}

function errorStatus(code: ErrorCode): number {
  switch (code) {
    case "UNAUTHORIZED": return 401;
    case "DEVICE_LIMIT_REACHED":
    case "PREPARING":
    case "STALE_GENERATION":
    case "PREVIEW_CHANGED": return 409;
    case "INVALID_REQUEST":
    case "NEEDS_REAUTH": return 422;
    case "RATE_LIMITED": return 429;
    case "TEMPORARY_UNAVAILABLE": return 503;
    case "PROTOCOL_UNSUPPORTED": return 426;
    default: return 403;
  }
}

function routeError(c: Context<HonoEnv>, error: unknown) {
  if (error instanceof QuickloginHttpError) return apiError(c, error.code, error.status);
  if (error instanceof QuickloginDeviceAuthError) {
    return apiError(c, error.code, errorStatus(error.code));
  }
  if (error instanceof QuickloginAccountClientError || error instanceof QuickloginDeviceError) {
    const status = errorStatus(error.code);
    if (status === 429) c.header("Retry-After", "60");
    return apiError(c, error.code, status);
  }
  return apiError(c, "TEMPORARY_UNAVAILABLE", 503);
}

router.post("/", async (c) => {
  try {
    const principal = await devicePrincipal(c);
    const metadata = parseDeviceMetadata(await readJson(c.req.raw));
    const accounts = new QuickloginAccountClient(c.env);
    const device = await accounts.registerDevice(principal.userId, principal.grantId, metadata);
    return c.json(await statusFor(c,
      await accounts.getDeviceAuthority(principal.userId, device.deviceId)));
  } catch (error) { return routeError(c, error); }
});

router.get("/", async (c) => {
  try {
    const user = await websiteUser(c);
    return c.json(await new QuickloginAccountClient(c.env).listDevices(user.id, Date.now()));
  } catch (error) { return routeError(c, error); }
});

function assertOwnDevice(
  principal: Awaited<ReturnType<typeof devicePrincipal>>,
  deviceId: string
) {
  if (!principal.deviceId || principal.deviceId !== deviceId) {
    throw new QuickloginDeviceAuthError("FORBIDDEN");
  }
}

router.put("/:id", async (c) => {
  try {
    const principal = await devicePrincipal(c);
    assertOwnDevice(principal, c.req.param("id"));
    const enabled = parseEnabled(await readJson(c.req.raw));
    const accounts = new QuickloginAccountClient(c.env);
    const authority = await accounts.setDeviceEnabled(principal.userId, principal.deviceId!, enabled);
    await new QuickloginDeviceClient(c.env).notifyDevice(authority);
    return c.json(await statusFor(c, authority));
  } catch (error) { return routeError(c, error); }
});

router.delete("/:id", async (c) => {
  try {
    requireWebsiteOrigin(c);
    const user = await websiteUser(c);
    await new QuickloginAccountClient(c.env).revokeDevice(user.id, c.req.param("id"), Date.now());
    return c.body(null, 204);
  } catch (error) { return routeError(c, error); }
});

router.post("/:id/status", async (c) => {
  try {
    const principal = await devicePrincipal(c);
    assertOwnDevice(principal, c.req.param("id"));
    const devices = new QuickloginDeviceClient(c.env);
    await devices.consumeRateLimit(principal.userId, principal.deviceId!, "status", 30, Date.now());
    const input = parseHeartbeat(await readJson(c.req.raw));
    const accounts = new QuickloginAccountClient(c.env);
    const authority = await accounts.getDeviceAuthority(principal.userId, principal.deviceId!);
    const before = await statusFor(c, authority);
    if (input.appliedVersion !== null && input.appliedVersion > before.sessionVersion) {
      throw new QuickloginHttpError("INVALID_REQUEST", 422);
    }
    await accounts.heartbeat(principal.userId, principal.deviceId!, input,
      getTrustedClientIp(c.req.raw), Date.now());
    const current = await accounts.getDeviceAuthority(principal.userId, principal.deviceId!);
    let status = await statusFor(c, current);
    if (current.allowed && status.state === "paused") {
      await devices.notifyDevice(current);
      status = await statusFor(c, current);
    }
    return c.json(status);
  } catch (error) { return routeError(c, error); }
});

router.post("/:id/refresh", async (c) => {
  try {
    const principal = await devicePrincipal(c);
    assertOwnDevice(principal, c.req.param("id"));
    const devices = new QuickloginDeviceClient(c.env);
    await devices.consumeRateLimit(principal.userId, principal.deviceId!, "refresh", 3, Date.now());
    const body = parseRefreshRequest(await readJson(c.req.raw));
    const authority = await new QuickloginAccountClient(c.env)
      .getDeviceAuthority(principal.userId, principal.deviceId!);
    if (authority.generation !== body.generation) {
      throw new QuickloginHttpError("STALE_GENERATION", 409);
    }
    await devices.requestDeviceRefresh(authority);
    return c.json(await statusFor(c, authority), 202);
  } catch (error) { return routeError(c, error); }
});

router.post("/:id/export", async (c) => {
  try {
    const principal = await devicePrincipal(c);
    assertOwnDevice(principal, c.req.param("id"));
    const devices = new QuickloginDeviceClient(c.env);
    await devices.consumeRateLimit(principal.userId, principal.deviceId!, "export", 12, Date.now());
    const body = parseExportRequest(await readJson(c.req.raw));
    const accounts = new QuickloginAccountClient(c.env);
    const authority = await accounts.getDeviceAuthority(principal.userId, principal.deviceId!);
    const status = await statusFor(c, authority);
    if (status.generation !== body.generation || status.sessionVersion !== body.sessionVersion) {
      throw new QuickloginHttpError("STALE_GENERATION", 409);
    }
    const envelope = await devices.exportDeviceCookies(authority);
    const current = await accounts.getDeviceAuthority(principal.userId, principal.deviceId!);
    if (!current.allowed || current.generation !== envelope.generation ||
        current.generation !== authority.generation) {
      throw new QuickloginDeviceAuthError(current.reason === "DEVICE_REVOKED"
        ? "DEVICE_REVOKED" : "FORBIDDEN");
    }
    return c.json(envelope);
  } catch (error) { return routeError(c, error); }
});

export { router as cquQuickloginDevices };
