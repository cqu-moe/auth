import { describe, expect, it } from "vitest";
import type { DeviceAuthority, StoredDeviceSession } from "./contracts";
import { nextDeviceAction, nextQuickloginRetryDelayMs } from "./maintenance";

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
  it("uses the confirmed maintenance boundaries", () => {
    expect(nextDeviceAction({ ...session, loginAt: now - 7 * 60 * 60_000 }, authority, now)).toBe("login");
    expect(nextDeviceAction({ ...session, lastKeepAliveAt: now - 60 * 60_000 }, authority, now)).toBe("keepalive");
    expect(nextDeviceAction(session, { ...authority, lastSeenAt: now - 7 * 24 * 60 * 60_000 }, now)).toBe("pause_inactive");
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
