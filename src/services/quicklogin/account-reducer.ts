import type {
  AccountState,
  DeviceAuthority,
  DeviceList,
  DeviceMetadata,
  DeviceRecord,
  ErrorCode,
  GrantRecord,
  HeartbeatInput,
} from "./contracts";
import { ONLINE_MS } from "./contracts";
import type { OutboxEvent, OutboxKind } from "./outbox";
import { selectQuotaDevices, validateDeviceLimit } from "./policy";

const PENDING_GRANT_TTL_MS = 10 * 60_000;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export class QuickloginAccountError extends Error {
  constructor(public readonly code: ErrorCode) {
    super(code);
    this.name = "QuickloginAccountError";
  }
}

export type AccountCommand =
  | {
      type: "create_pending_grant";
      grantId: string;
      ownerUserId: string;
      clientId: string;
    }
  | { type: "activate_grant"; grantId: string }
  | {
      type: "register_device";
      grantId: string;
      deviceId: string;
      metadata: DeviceMetadata;
    }
  | { type: "set_device_enabled"; deviceId: string; enabled: boolean; expectedGeneration?: number }
  | { type: "set_master_enabled"; enabled: boolean }
  | { type: "revoke_device"; deviceId: string }
  | { type: "notify_binding_changed" }
  | {
      type: "heartbeat";
      deviceId: string;
      input: HeartbeatInput;
      ip: string | null;
    }
  | { type: "apply_quota"; limit: number };

interface EventSeed {
  kind: OutboxKind;
  deviceId?: string;
  generation?: number;
  grantId?: string;
}

export interface AccountReduction {
  state: AccountState;
  result: unknown;
  events: OutboxEvent[];
}

export function emptyAccountState(): AccountState {
  return {
    schemaVersion: 1,
    revision: 0,
    masterEnabled: false,
    deviceLimit: 0,
    devices: {},
    grants: {},
  };
}

function fail(code: ErrorCode): never {
  throw new QuickloginAccountError(code);
}

function increment(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    fail("INVALID_REQUEST");
  }
  return value + 1;
}

function validateMetadata(metadata: DeviceMetadata): DeviceMetadata {
  const deviceName = metadata.deviceName.trim();
  const browserVersion = metadata.browserVersion.trim();
  if (
    metadata.browserFamily !== "chrome" ||
    deviceName.length < 1 ||
    deviceName.length > 80 ||
    browserVersion.length < 1 ||
    browserVersion.length > 40 ||
    CONTROL_CHARACTERS.test(deviceName) ||
    CONTROL_CHARACTERS.test(browserVersion)
  ) {
    fail("INVALID_REQUEST");
  }
  return { deviceName, browserFamily: "chrome", browserVersion };
}

function prunePendingGrants(state: AccountState, now: number): boolean {
  let changed = false;
  for (const [grantId, grant] of Object.entries(state.grants)) {
    if (
      grant.state === "pending" &&
      grant.expiresAt !== null &&
      grant.expiresAt <= now
    ) {
      delete state.grants[grantId];
      changed = true;
    }
  }
  return changed;
}

function requireDevice(state: AccountState, deviceId: string): DeviceRecord {
  const device = state.devices[deviceId];
  if (!device) fail("FORBIDDEN");
  return device;
}

function requireLiveDevice(state: AccountState, deviceId: string): DeviceRecord {
  const device = requireDevice(state, deviceId);
  const grant = state.grants[device.grantId];
  if (device.revokedAt !== null || grant?.state === "revoked") {
    fail("DEVICE_REVOKED");
  }
  if (!grant || grant.state !== "active") fail("FORBIDDEN");
  return device;
}

export function getDeviceAuthorityFromState(
  state: AccountState,
  deviceId: string
): DeviceAuthority {
  const device = requireDevice(state, deviceId);
  const grant = state.grants[device.grantId];
  let reason: ErrorCode | null = null;

  if (device.revokedAt !== null || grant?.state === "revoked") {
    reason = "DEVICE_REVOKED";
  } else if (!grant || grant.state !== "active") {
    reason = "FORBIDDEN";
  } else if (!state.masterEnabled) {
    reason = "MASTER_DISABLED";
  } else if (!device.enabled) {
    reason = "DEVICE_DISABLED";
  } else if (state.deviceLimit === 0) {
    reason = "NO_DEVICE_CAPACITY";
  } else {
    const kept = selectQuotaDevices(
      Object.values(state.devices),
      state.deviceLimit
    ).kept;
    if (!kept.includes(deviceId)) reason = "NO_DEVICE_CAPACITY";
  }

  return {
    ownerUserId: device.ownerUserId,
    deviceId,
    grantId: device.grantId,
    generation: device.generation,
    masterEnabled: state.masterEnabled,
    enabled: device.enabled,
    allowed: reason === null,
    reason,
    lastSeenAt: device.lastSeenAt,
  };
}

export function listDevicesFromState(
  state: AccountState,
  now: number
): DeviceList {
  const devices = Object.values(state.devices)
    .slice()
    .sort((left, right) => {
      if (left.deviceId < right.deviceId) return -1;
      if (left.deviceId > right.deviceId) return 1;
      return 0;
    })
    .map(({ ownerUserId: _ownerUserId, grantId: _grantId, ...device }) => ({
      ...device,
      online:
        device.lastSeenAt !== null &&
        now - device.lastSeenAt >= 0 &&
        now - device.lastSeenAt <= ONLINE_MS,
    }));

  return {
    masterEnabled: state.masterEnabled,
    deviceLimit: state.deviceLimit,
    used: Object.values(state.devices).filter(
      (device) => device.enabled && device.revokedAt === null
    ).length,
    revision: state.revision,
    devices,
  };
}

export function assertGrantFromState(
  state: AccountState,
  grantId: string,
  clientId: string
): GrantRecord {
  const grant = state.grants[grantId];
  if (!grant || grant.clientId !== clientId) fail("FORBIDDEN");
  if (grant.state === "revoked") fail("DEVICE_REVOKED");
  if (grant.state !== "active") fail("FORBIDDEN");
  return grant;
}

export function reduceAccount(
  input: AccountState,
  command: AccountCommand,
  now: number
): AccountReduction {
  const state = structuredClone(input);
  let changed = prunePendingGrants(state, now);
  const eventSeeds: EventSeed[] = [];

  switch (command.type) {
    case "create_pending_grant": {
      if (!command.grantId || !command.ownerUserId || !command.clientId) {
        fail("INVALID_REQUEST");
      }
      if (state.grants[command.grantId]) fail("INVALID_REQUEST");
      state.grants[command.grantId] = {
        grantId: command.grantId,
        ownerUserId: command.ownerUserId,
        clientId: command.clientId,
        state: "pending",
        createdAt: now,
        expiresAt: now + PENDING_GRANT_TTL_MS,
        deviceId: null,
        revokedAt: null,
      };
      changed = true;
      break;
    }
    case "activate_grant": {
      const grant = state.grants[command.grantId];
      if (!grant) fail("FORBIDDEN");
      if (grant.state === "revoked") fail("DEVICE_REVOKED");
      if (grant.state === "pending") {
        grant.state = "active";
        grant.expiresAt = null;
        changed = true;
      }
      break;
    }
    case "register_device": {
      const grant = state.grants[command.grantId];
      if (!grant) fail("FORBIDDEN");
      if (grant.state === "revoked") fail("DEVICE_REVOKED");
      if (grant.state !== "active") fail("FORBIDDEN");
      if (grant.deviceId !== null) {
        requireDevice(state, grant.deviceId);
        break;
      }
      const metadata = validateMetadata(command.metadata);
      if (!command.deviceId || command.deviceId.includes(":")) {
        fail("INVALID_REQUEST");
      }
      grant.deviceId = command.deviceId;
      state.devices[command.deviceId] = {
        ...metadata,
        deviceId: command.deviceId,
        ownerUserId: grant.ownerUserId,
        grantId: grant.grantId,
        enabled: false,
        enabledAt: null,
        lastSeenAt: null,
        lastIp: null,
        revokedAt: null,
        generation: 1,
        disabledReason: null,
        appliedVersion: null,
      };
      changed = true;
      eventSeeds.push({ kind: "projection" });
      break;
    }
    case "set_device_enabled": {
      const device = requireLiveDevice(state, command.deviceId);
      if (command.expectedGeneration !== undefined && device.generation !== command.expectedGeneration) fail("STALE_GENERATION");
      if (device.enabled === command.enabled) break;
      if (command.enabled) {
        if (!state.masterEnabled) fail("MASTER_DISABLED");
        if (state.deviceLimit === 0) fail("NO_DEVICE_CAPACITY");
        const used = Object.values(state.devices).filter(
          (candidate) => candidate.enabled && candidate.revokedAt === null
        ).length;
        if (used >= state.deviceLimit) fail("DEVICE_LIMIT_REACHED");
        device.enabled = true;
        device.enabledAt = now;
        device.disabledReason = null;
      } else {
        device.enabled = false;
        device.disabledReason = "user";
      }
      device.generation = increment(device.generation);
      changed = true;
      eventSeeds.push({
        kind: "device-notify",
        deviceId: device.deviceId,
        generation: device.generation,
      });
      eventSeeds.push({ kind: "projection" });
      break;
    }
    case "set_master_enabled": {
      if (state.masterEnabled === command.enabled) break;
      state.masterEnabled = command.enabled;
      for (const device of Object.values(state.devices)) {
        if (!device.enabled || device.revokedAt !== null) continue;
        device.generation = increment(device.generation);
        eventSeeds.push({
          kind: "device-notify",
          deviceId: device.deviceId,
          generation: device.generation,
        });
      }
      changed = true;
      eventSeeds.push({ kind: "projection" });
      break;
    }
    case "revoke_device": {
      const device = state.devices[command.deviceId];
      if (!device || device.revokedAt !== null) break;
      device.enabled = false;
      device.revokedAt = now;
      device.generation = increment(device.generation);
      const grant = state.grants[device.grantId];
      if (grant) {
        grant.state = "revoked";
        grant.revokedAt = now;
      }
      changed = true;
      eventSeeds.push({
        kind: "device-notify",
        deviceId: device.deviceId,
        generation: device.generation,
      });
      eventSeeds.push({
        kind: "revoke-oauth-family",
        deviceId: device.deviceId,
        generation: device.generation,
        grantId: device.grantId,
      });
      eventSeeds.push({ kind: "projection" });
      break;
    }
    case "heartbeat": {
      const device = requireLiveDevice(state, command.deviceId);
      if (command.input.protocolVersion !== 2) fail("PROTOCOL_UNSUPPORTED");
      const generationMatches =
        command.input.observedGeneration === device.generation;
      if (
        command.input.appliedVersion !== null &&
        (!Number.isSafeInteger(command.input.appliedVersion) ||
          command.input.appliedVersion < 0)
      ) {
        fail("INVALID_REQUEST");
      }
      const browserVersion = command.input.browserVersion.trim();
      if (
        browserVersion.length < 1 ||
        browserVersion.length > 40 ||
        CONTROL_CHARACTERS.test(browserVersion)
      ) {
        fail("INVALID_REQUEST");
      }
      device.lastSeenAt = now;
      device.lastIp = command.ip;
      device.browserVersion = browserVersion;
      if (generationMatches) {
        device.appliedVersion = command.input.appliedVersion;
      }
      changed = true;
      eventSeeds.push({ kind: "projection" });
      break;
    }
    case "notify_binding_changed": {
      for (const device of Object.values(state.devices)) {
        if (device.revokedAt !== null) continue;
        device.generation = increment(device.generation);
        changed = true;
        eventSeeds.push({
          kind: "device-notify",
          deviceId: device.deviceId,
          generation: device.generation,
        });
      }
      if (changed) eventSeeds.push({ kind: "projection" });
      break;
    }
    case "apply_quota": {
      validateDeviceLimit(command.limit);
      const selection = selectQuotaDevices(
        Object.values(state.devices),
        command.limit
      );
      if (state.deviceLimit !== command.limit) {
        state.deviceLimit = command.limit;
        changed = true;
      }
      for (const deviceId of selection.disabled) {
        const device = requireDevice(state, deviceId);
        device.enabled = false;
        device.disabledReason = "quota_reduced";
        device.generation = increment(device.generation);
        changed = true;
        eventSeeds.push({
          kind: "device-notify",
          deviceId,
          generation: device.generation,
        });
      }
      if (changed) eventSeeds.push({ kind: "projection" });
      break;
    }
  }

  if (changed) state.revision = increment(state.revision);
  const events = eventSeeds.map<OutboxEvent>((seed) => ({
    id: crypto.randomUUID(),
    ...seed,
    revision: state.revision,
    attempts: 0,
    nextAttemptAt: now,
  }));

  let result: unknown;
  switch (command.type) {
    case "create_pending_grant":
    case "activate_grant":
      result = state.grants[command.grantId];
      break;
    case "register_device": {
      const deviceId = state.grants[command.grantId]?.deviceId;
      result = deviceId ? state.devices[deviceId] : undefined;
      break;
    }
    case "set_device_enabled":
      result = getDeviceAuthorityFromState(state, command.deviceId);
      break;
    case "set_master_enabled":
    case "apply_quota":
      result = listDevicesFromState(state, now);
      break;
    case "revoke_device":
    case "heartbeat":
    case "notify_binding_changed":
      result = undefined;
      break;
  }

  return { state, result, events };
}
