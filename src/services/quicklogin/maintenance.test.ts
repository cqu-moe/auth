import { describe, expect, it } from "vitest";
import type { DeviceAuthority, StoredDeviceSession } from "./contracts";
import {
  nextDeviceAction,
  nextQuickloginRetryDelayMs,
  quickloginSessionUsableUntil,
} from "./maintenance";

const now = 1_800_000_000_000;
const authority: DeviceAuthority = {
  ownerUserId: "u", deviceId: "d", grantId: "g", generation: 1,
  masterEnabled: true, enabled: true, allowed: true, reason: null,
  lastSeenAt: now,
};
const session: StoredDeviceSession = {
  schemaVersion: 1, ownerUserId: "u", deviceId: "d", generation: 1,
  bindingEpoch: 0, sessionVersion: 1, state: "ready",
  loginAt: now - 60_000, lastKeepAliveAt: now - 30 * 60_000,
  storageState: "{}", exportDigest: "digest", transientFailures: 0,
  transientStartedAt: null, fastRetries: 0, nextAttemptAt: null,
};

describe("nextDeviceAction", () => {
  it("waits until the persisted randomized relogin boundary", () => {
    const reloginAt = now + 6 * 60 * 60_000;
    expect(nextDeviceAction({ ...session, reloginAt }, authority, now)).toBe("wait");
    expect(nextDeviceAction({ ...session, reloginAt }, authority, reloginAt)).toBe("login");
    expect(nextDeviceAction(session, { ...authority, lastSeenAt: now - 7 * 24 * 60 * 60_000 }, now)).toBe("pause_inactive");
  });
  it("uses the seven-hour fallback for unmigrated sessions", () => {
    const boundary = now - 7 * 60 * 60_000;
    expect(nextDeviceAction({ ...session, loginAt: boundary }, authority, now)).toBe("login");
    expect(nextDeviceAction({ ...session, loginAt: boundary + 1 }, authority, now)).toBe("wait");
  });
  it("starts a login retry when transient backoff is due", () => {
    expect(nextDeviceAction({
      ...session,
      state: "temporary_unavailable",
      nextAttemptAt: now,
    }, authority, now)).toBe("login");
    expect(nextDeviceAction({
      ...session,
      state: "temporary_unavailable",
      nextAttemptAt: now + 60_000,
    }, authority, now)).toBe("wait");
  });
  it("does not relogin needs_reauth and stops denied authority", () => {
    expect(nextDeviceAction({ ...session, state: "needs_reauth" }, authority, now)).toBe("wait");
    expect(nextDeviceAction(session, { ...authority, allowed: false, reason: "DEVICE_REVOKED" }, now)).toBe("stop");
  });
});

describe("nextQuickloginRetryDelayMs", () => {
  const minute = 60_000;
  const firstFailureAt = now;

  it.each([
    [0, 1],
    [5 * minute - 1, 1],
    [5 * minute, 3],
    [30 * minute - 1, 3],
    [30 * minute, 5],
    [2 * 60 * minute - 1, 5],
    [2 * 60 * minute, 10],
    [2 * 60 * minute + 10 * minute, 20],
    [2 * 60 * minute + 30 * minute, 30],
    [3 * 60 * minute + 10 * minute, 30],
    [12 * 60 * minute + 30 * minute, 30],
  ])("after %d ms returns a %d-minute delay", (elapsed, delayMinutes) => {
    expect(nextQuickloginRetryDelayMs(firstFailureAt, firstFailureAt + elapsed))
      .toBe(delayMinutes * minute);
  });

  it("treats a future first-failure timestamp as a new failure window", () => {
    expect(nextQuickloginRetryDelayMs(now + minute, now)).toBe(minute);
  });
});

it('executes an explicit refresh even when the old session was recently validated', () => {
 expect(nextDeviceAction(
  { ...session, state: 'refreshing', reloginAt: now + 6 * 60 * 60_000 },
  authority,
  now
 )).toBe('login');
});

it('keeps a refreshing session usable until the seven-hour login boundary', () => {
  expect(quickloginSessionUsableUntil({
    ...session,
    state: "refreshing",
    lastKeepAliveAt: session.loginAt,
    reloginAt: session.loginAt + 4 * 60 * 60_000,
  })).toBe(session.loginAt + 7 * 60 * 60_000);
  expect(quickloginSessionUsableUntil({ ...session, lastKeepAliveAt: null })).toBeNull();
  expect(quickloginSessionUsableUntil({ ...session, storageState: null })).toBeNull();
});
