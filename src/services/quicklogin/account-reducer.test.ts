import { describe, expect, it } from "vitest";
import type {
  AccountState,
  DeviceRecord,
  GrantRecord,
} from "./contracts";
import {
  QuickloginAccountError,
  reduceAccount,
  type AccountCommand,
} from "./account-reducer";

const NOW = 1_800_000_000_000;

function grant(overrides: Partial<GrantRecord> = {}): GrantRecord {
  return {
    grantId: "grant-1",
    ownerUserId: "user-1",
    clientId: "official-client",
    state: "active",
    createdAt: NOW - 1_000,
    expiresAt: null,
    deviceId: "device-1",
    revokedAt: null,
    ...overrides,
  };
}

function device(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    deviceId: "device-1",
    ownerUserId: "user-1",
    grantId: "grant-1",
    deviceName: "Chrome",
    browserFamily: "chrome",
    browserVersion: "140",
    enabled: true,
    enabledAt: NOW - 2_000,
    lastSeenAt: NOW - 1_000,
    lastIp: null,
    revokedAt: null,
    generation: 1,
    disabledReason: null,
    appliedVersion: null,
    ...overrides,
  };
}

function state(overrides: Partial<AccountState> = {}): AccountState {
  return {
    schemaVersion: 1,
    revision: 1,
    masterEnabled: true,
    deviceLimit: 1,
    devices: { "device-1": device() },
    grants: { "grant-1": grant() },
    ...overrides,
  };
}

function reduce(input: AccountState, command: AccountCommand, now = NOW) {
  return reduceAccount(input, command, now);
}

describe("reduceAccount", () => {
  it("turns master off without releasing enabled slots", () => {
    const result = reduce(state(), { type: "set_master_enabled", enabled: false });

    expect(result.state.masterEnabled).toBe(false);
    expect(result.state.devices["device-1"]).toMatchObject({
      enabled: true,
      generation: 2,
    });
    expect(result.result).toMatchObject({ used: 1, masterEnabled: false });
  });

  it("releases a slot on disable and keeps repeated enable idempotent", () => {
    const disabled = reduce(state(), {
      type: "set_device_enabled",
      deviceId: "device-1",
      enabled: false,
    });
    expect(disabled.state.devices["device-1"]).toMatchObject({
      enabled: false,
      disabledReason: "user",
      generation: 2,
    });

    const enabled = reduce(disabled.state, {
      type: "set_device_enabled",
      deviceId: "device-1",
      enabled: true,
    });
    const repeated = reduce(enabled.state, {
      type: "set_device_enabled",
      deviceId: "device-1",
      enabled: true,
    });

    expect(enabled.state.devices["device-1"].generation).toBe(3);
    expect(repeated.state.revision).toBe(enabled.state.revision);
    expect(repeated.state.devices["device-1"].generation).toBe(3);
  });

  it("revokes the device and its grant with a higher generation", () => {
    const result = reduce(state(), {
      type: "revoke_device",
      deviceId: "device-1",
    });

    expect(result.state.devices["device-1"]).toMatchObject({
      enabled: false,
      revokedAt: NOW,
      generation: 2,
    });
    expect(result.state.grants["grant-1"]).toMatchObject({
      state: "revoked",
      revokedAt: NOW,
    });
    expect(result.events.map((event) => event.kind)).toEqual([
      "device-notify",
      "revoke-oauth-family",
      "projection",
    ]);
  });

  it("reduces quota to zero without changing master and never auto-enables on increase", () => {
    const reduced = reduce(state(), { type: "apply_quota", limit: 0 });

    expect(reduced.state.masterEnabled).toBe(true);
    expect(reduced.state.deviceLimit).toBe(0);
    expect(reduced.state.devices["device-1"]).toMatchObject({
      enabled: false,
      disabledReason: "quota_reduced",
      generation: 2,
    });

    const increased = reduce(reduced.state, { type: "apply_quota", limit: 5 });
    expect(increased.state.masterEnabled).toBe(true);
    expect(increased.state.deviceLimit).toBe(5);
    expect(increased.state.devices["device-1"].enabled).toBe(false);
  });

  it("rejects an expired pending grant and prunes it on the next mutation", () => {
    const pending = grant({
      state: "pending",
      deviceId: null,
      expiresAt: NOW - 1,
    });
    const input = state({ grants: { "grant-1": pending } });

    expect(() =>
      reduce(input, { type: "activate_grant", grantId: "grant-1" })
    ).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));

    const result = reduce(input, {
      type: "create_pending_grant",
      grantId: "grant-2",
      ownerUserId: "user-1",
      clientId: "official-client",
    });
    expect(result.state.grants["grant-1"]).toBeUndefined();
    expect(result.state.grants["grant-2"]).toMatchObject({
      state: "pending",
      expiresAt: NOW + 10 * 60_000,
    });
  });

  it("emits increasing generations so stale notifications cannot restore authority", () => {
    const enabled = reduce(
      state({
        devices: { "device-1": device({ enabled: false }) },
      }),
      { type: "set_device_enabled", deviceId: "device-1", enabled: true }
    );
    const disabled = reduce(enabled.state, { type: "apply_quota", limit: 0 });
    const oldNotice = enabled.events.find(
      (event) => event.kind === "device-notify"
    );
    const currentNotice = disabled.events.find(
      (event) => event.kind === "device-notify"
    );

    expect(oldNotice?.generation).toBe(2);
    expect(currentNotice?.generation).toBe(3);
    expect(disabled.state.devices["device-1"].enabled).toBe(false);
  });

  it("uses stable error codes for revoked and capacity failures", () => {
    const revoked = state({
      devices: { "device-1": device({ revokedAt: NOW }) },
      grants: { "grant-1": grant({ state: "revoked", revokedAt: NOW }) },
    });
    expect(() =>
      reduce(revoked, {
        type: "set_device_enabled",
        deviceId: "device-1",
        enabled: true,
      })
    ).toThrowError(expect.objectContaining({ code: "DEVICE_REVOKED" }));

    const noCapacity = state({
      deviceLimit: 0,
      devices: { "device-1": device({ enabled: false }) },
    });
    expect(() =>
      reduce(noCapacity, {
        type: "set_device_enabled",
        deviceId: "device-1",
        enabled: true,
      })
    ).toThrowError(expect.objectContaining({ code: "NO_DEVICE_CAPACITY" }));
  });

  it("exposes coded account errors without leaking state", () => {
    const error = new QuickloginAccountError("PREVIEW_CHANGED");
    expect(error).toMatchObject({
      name: "QuickloginAccountError",
      code: "PREVIEW_CHANGED",
      message: "PREVIEW_CHANGED",
    });
  });
});
