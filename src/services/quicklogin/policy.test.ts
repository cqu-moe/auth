import { describe, expect, it } from "vitest";
import type { DeviceRecord } from "./contracts";
import { selectQuotaDevices, validateDeviceLimit } from "./policy";

function device(
  deviceId: string,
  overrides: Partial<DeviceRecord> = {}
): DeviceRecord {
  return {
    ownerUserId: "user-1",
    grantId: `grant-${deviceId}`,
    deviceId,
    deviceName: "Chrome",
    browserFamily: "chrome",
    browserVersion: "140",
    enabled: true,
    enabledAt: 10,
    lastSeenAt: 10,
    lastIp: null,
    revokedAt: null,
    generation: 1,
    disabledReason: null,
    appliedVersion: null,
    ...overrides,
  };
}

describe("validateDeviceLimit", () => {
  it.each([
    -1,
    1.5,
    "5",
    null,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects invalid device limit %p", (value) => {
    expect(() => validateDeviceLimit(value)).toThrowError("INVALID_REQUEST");
  });

  it.each([0, 5, Number.MAX_SAFE_INTEGER])(
    "accepts nonnegative safe integer %p",
    (value) => {
      expect(validateDeviceLimit(value)).toBe(value);
    }
  );
});

describe("selectQuotaDevices", () => {
  it("keeps recently contacted devices with deterministic ties", () => {
    const rows = [
      device("c", { lastSeenAt: 100, enabledAt: 20 }),
      device("b", { lastSeenAt: 100, enabledAt: 30 }),
      device("a", { lastSeenAt: 100, enabledAt: 30 }),
      device("d", { lastSeenAt: null, enabledAt: 99 }),
      device("e", { lastSeenAt: null, enabledAt: null }),
    ];
    const snapshot = structuredClone(rows);

    expect(selectQuotaDevices(rows, 2)).toEqual({
      kept: ["a", "b"],
      disabled: ["c", "d", "e"],
    });
    expect(rows).toEqual(snapshot);
  });

  it("excludes already disabled and revoked devices from quota selection", () => {
    const rows = [
      device("enabled"),
      device("disabled", { enabled: false, disabledReason: "user" }),
      device("revoked", { revokedAt: 50 }),
    ];

    expect(selectQuotaDevices(rows, 0)).toEqual({
      kept: [],
      disabled: ["enabled"],
    });
  });
});
