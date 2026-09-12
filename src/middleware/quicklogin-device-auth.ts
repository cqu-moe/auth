import type { Env } from "../types";
import { verifyAuthAccessToken } from "../services/auth-access-token";
import {
  QuickloginAccountClient,
  QuickloginAccountClientError,
} from "../services/quicklogin/account-client";
import { DEVICE_SCOPE } from "../services/quicklogin/contracts";

type DeviceAuthErrorCode = "UNAUTHORIZED" | "FORBIDDEN" | "DEVICE_REVOKED";

export class QuickloginDeviceAuthError extends Error {
  constructor(public readonly code: DeviceAuthErrorCode) {
    super(code);
    this.name = "QuickloginDeviceAuthError";
  }
}

function fail(code: DeviceAuthErrorCode): never {
  throw new QuickloginDeviceAuthError(code);
}

export async function verifyQuickloginBearer(request: Request, env: Env): Promise<{
  userId: string;
  clientId: string;
  grantId: string;
  deviceId: string | null;
}> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) fail("UNAUTHORIZED");
  const token = authorization.slice("Bearer ".length);
  if (!token) fail("UNAUTHORIZED");

  let payload: Record<string, unknown>;
  try {
    payload = await verifyAuthAccessToken(token, env) as Record<string, unknown>;
  } catch {
    fail("UNAUTHORIZED");
  }
  const userId = payload.sub;
  const clientId = payload.azp ?? payload.client_id;
  const grantId = payload.ql_grant;
  const scopes = typeof payload.scope === "string"
    ? new Set(payload.scope.split(/\s+/).filter(Boolean))
    : new Set<string>();
  if (
    typeof userId !== "string" ||
    typeof clientId !== "string" ||
    clientId !== env.QUICKLOGIN_CLIENT_ID ||
    !scopes.has(DEVICE_SCOPE) ||
    typeof grantId !== "string" ||
    !grantId
  ) fail("FORBIDDEN");

  try {
    const grant = await new QuickloginAccountClient(env)
      .assertGrant(userId, grantId, clientId);
    return { userId, clientId, grantId, deviceId: grant.deviceId };
  } catch (error) {
    if (error instanceof QuickloginAccountClientError) {
      fail(error.code === "DEVICE_REVOKED" ? "DEVICE_REVOKED" : "FORBIDDEN");
    }
    throw error;
  }
}
