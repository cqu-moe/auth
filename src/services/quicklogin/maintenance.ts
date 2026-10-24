import type { DeviceAuthority, StoredDeviceSession } from "./contracts";
import { INACTIVE_MS } from "./contracts";
import { CQU_PROACTIVE_RELOGIN_MS } from "../cqu-maintenance-policy";

const MINUTE_MS = 60_000;
const QUICKLOGIN_RETRY_BACKOFF_AT_MS = 2 * 60 * MINUTE_MS;
export const QUICKLOGIN_RETRY_CAP_MS = 30 * MINUTE_MS;

export type DeviceAction =
  | "stop"
  | "pause_inactive"
  | "login"
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
  now: number
): DeviceAction {
  if (!authority.allowed || authority.generation !== state.generation) return "stop";
  if (authority.lastSeenAt !== null && now - authority.lastSeenAt >= INACTIVE_MS) {
    return "pause_inactive";
  }
  if (state.nextAttemptAt !== null && state.nextAttemptAt > now) return "wait";
  if (state.state === "needs_reauth") return "wait";
  if (state.state === "refreshing" || state.state === "preparing") return "login";
  if (!state.storageState || state.loginAt === null) return "login";
  if (state.state === "temporary_unavailable") return "login";
  return now >= (state.reloginAt ?? state.loginAt + CQU_PROACTIVE_RELOGIN_MS)
    ? "login"
    : "wait";
}

export function quickloginSessionUsableUntil(
  session: StoredDeviceSession
): number | null {
  if (!session.storageState) return null;
  return session.lastKeepAliveAt === null
    ? null
    : session.loginAt === null
      ? null
      : session.loginAt + CQU_PROACTIVE_RELOGIN_MS;
}
