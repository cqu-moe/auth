import type { DeviceAuthority, StoredDeviceSession } from "./contracts";
import { INACTIVE_MS } from "./contracts";

const KEEPALIVE_MS = 60 * 60_000;
const RELOGIN_MS = 7 * 60 * 60_000;

export type DeviceAction =
  | "stop"
  | "pause_inactive"
  | "login"
  | "keepalive"
  | "wait";

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
  if (!state.storageState || state.loginAt === null) return "login";
  if (now - state.loginAt >= RELOGIN_MS) return "login";
  if (state.lastKeepAliveAt === null || now - state.lastKeepAliveAt >= KEEPALIVE_MS) {
    return "keepalive";
  }
  return "wait";
}
