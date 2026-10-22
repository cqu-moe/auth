import type { DeviceAuthority, StoredDeviceSession } from "./contracts";
import { INACTIVE_MS } from "./contracts";
import type { Env } from "../../types";
import {
  CQU_PROACTIVE_RELOGIN_MS,
  skipDeviceProbes,
} from "../cqu-maintenance-policy";

const KEEPALIVE_MS = 60 * 60_000;
const MINUTE_MS = 60_000;
const QUICKLOGIN_RETRY_BACKOFF_AT_MS = 2 * 60 * MINUTE_MS;
export const QUICKLOGIN_RETRY_CAP_MS = 30 * MINUTE_MS;

export type DeviceAction =
  | "stop"
  | "pause_inactive"
  | "login"
  | "keepalive"
  | "wait";

export function nextQuickloginRetryDelayMs(
  firstFailureAt: number,
  now: number
): number {
  const elapsed = Math.max(0, now - firstFailureAt);
  if (elapsed < 5 * MINUTE_MS) return MINUTE_MS;
  if (elapsed < 30 * MINUTE_MS) return 3 * MINUTE_MS;
  if (elapsed < QUICKLOGIN_RETRY_BACKOFF_AT_MS) return 5 * MINUTE_MS;

  let remaining = elapsed - QUICKLOGIN_RETRY_BACKOFF_AT_MS;
  let delay = 10 * MINUTE_MS;
  while (remaining >= delay && delay < QUICKLOGIN_RETRY_CAP_MS) {
    remaining -= delay;
    delay = Math.min(delay * 2, QUICKLOGIN_RETRY_CAP_MS);
  }
  return delay;
}

export function nextDeviceAction(
  state: StoredDeviceSession,
  authority: DeviceAuthority,
  now: number,
  probesEnabled = true
): DeviceAction {
  if (!authority.allowed || authority.generation !== state.generation) return "stop";
  if (authority.lastSeenAt !== null && now - authority.lastSeenAt >= INACTIVE_MS) {
    return "pause_inactive";
  }
  if (state.nextAttemptAt !== null && state.nextAttemptAt > now) return "wait";
  if (state.state === "needs_reauth") return "wait";
  if (state.operationId && (state.state === "refreshing" || state.state === "preparing")) return "login";
  if (!state.storageState || state.loginAt === null) return "login";
  if (now - state.loginAt >= CQU_PROACTIVE_RELOGIN_MS) return "login";
  if (!probesEnabled) return "wait";
  if (state.lastKeepAliveAt === null || now - state.lastKeepAliveAt >= KEEPALIVE_MS) {
    return "keepalive";
  }
  return "wait";
}

export function quickloginSessionUsableUntil(
  env: Env,
  session: StoredDeviceSession
): number | null {
  if (!session.storageState) return null;
  if (skipDeviceProbes(env, session.ownerUserId, session.deviceId)) {
    return session.loginAt === null
      ? null
      : session.loginAt + CQU_PROACTIVE_RELOGIN_MS;
  }
  return session.lastKeepAliveAt === null
    ? null
    : session.lastKeepAliveAt + 2 * 60 * 60_000;
}
