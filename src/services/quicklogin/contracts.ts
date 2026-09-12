export const PROTOCOL_VERSION = 1 as const;
export const HEARTBEAT_MS = 5 * 60_000;
export const ONLINE_MS = 10 * 60_000;
export const INACTIVE_MS = 7 * 24 * 60 * 60_000;
export const DEVICE_SCOPE = "cqu:quicklogin:device";
export const DEVICE_LIMIT_KEY = "cqu.quicklogin_device_limit";
export const MASTER_KEY = "cqu.quicklogin";

export type EpochMs = number;
export type DeviceId = string;
export type GrantId = string;
export type CloudState =
  | "disabled"
  | "paused"
  | "preparing"
  | "ready"
  | "refreshing"
  | "needs_reauth"
  | "temporary_unavailable"
  | "revoked";
export type DisabledReason = "user" | "quota_reduced" | null;
export type ErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "INVALID_REQUEST"
  | "NO_DEVICE_CAPACITY"
  | "DEVICE_LIMIT_REACHED"
  | "DEVICE_REVOKED"
  | "MASTER_DISABLED"
  | "DEVICE_DISABLED"
  | "PREPARING"
  | "NEEDS_REAUTH"
  | "TEMPORARY_UNAVAILABLE"
  | "RATE_LIMITED"
  | "PROTOCOL_UNSUPPORTED"
  | "STALE_GENERATION"
  | "PREVIEW_CHANGED";

export interface ApiError {
  error: { code: ErrorCode; message: string; retryAfterMs?: number };
}

export interface DeviceMetadata {
  deviceName: string;
  browserFamily: "chrome";
  browserVersion: string;
}

export interface DeviceRecord extends DeviceMetadata {
  deviceId: DeviceId;
  ownerUserId: string;
  grantId: GrantId;
  enabled: boolean;
  enabledAt: EpochMs | null;
  lastSeenAt: EpochMs | null;
  lastIp: string | null;
  revokedAt: EpochMs | null;
  generation: number;
  disabledReason: DisabledReason;
  appliedVersion: number | null;
}

export interface GrantRecord {
  grantId: GrantId;
  ownerUserId: string;
  clientId: string;
  state: "pending" | "active" | "revoked";
  createdAt: EpochMs;
  expiresAt: EpochMs | null;
  deviceId: DeviceId | null;
  revokedAt: EpochMs | null;
}

export interface AccountState {
  schemaVersion: 1;
  revision: number;
  masterEnabled: boolean;
  deviceLimit: number;
  devices: Record<DeviceId, DeviceRecord>;
  grants: Record<GrantId, GrantRecord>;
}

export interface DeviceAuthority {
  ownerUserId: string;
  deviceId: DeviceId;
  grantId: GrantId;
  generation: number;
  masterEnabled: boolean;
  enabled: boolean;
  allowed: boolean;
  reason: ErrorCode | null;
  lastSeenAt: EpochMs | null;
}

export interface DeviceStatus {
  protocolVersion: 1;
  deviceId: DeviceId;
  generation: number;
  masterEnabled: boolean;
  enabled: boolean;
  deviceLimit: number;
  used: number;
  disabledReason: DisabledReason;
  state: CloudState;
  sessionVersion: number;
  appliedVersion: number | null;
  loginAt: EpochMs | null;
  lastKeepAliveAt: EpochMs | null;
  lastSeenAt: EpochMs | null;
}

export type PublicDevice = Omit<DeviceRecord, "ownerUserId" | "grantId"> & {
  online: boolean;
};

export interface DeviceList {
  masterEnabled: boolean;
  deviceLimit: number;
  used: number;
  revision: number;
  devices: PublicDevice[];
}

export interface SsoCookie {
  name: string;
  value: string;
  domain: "sso.cqu.edu.cn" | ".sso.cqu.edu.cn";
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: "Strict" | "Lax" | "None";
  expires: number;
}

export interface CookieEnvelope {
  protocolVersion: 1;
  deviceId: DeviceId;
  generation: number;
  sessionVersion: number;
  createdAt: EpochMs;
  cookies: SsoCookie[];
}

export interface StoredDeviceSession {
  schemaVersion: 1;
  ownerUserId: string;
  deviceId: DeviceId;
  generation: number;
  bindingEpoch: number;
  sessionVersion: number;
  state: CloudState;
  loginAt: EpochMs | null;
  lastKeepAliveAt: EpochMs | null;
  storageState: string | null;
  exportDigest: string | null;
  transientFailures: number;
  transientStartedAt: EpochMs | null;
  fastRetries: number;
  nextAttemptAt: EpochMs | null;
  pendingKeepaliveMint?: {
    operationId: string;
    mintedAt: EpochMs;
    storageState?: string;
  };
}

export interface DeviceLoginRequest {
  ownerUserId: string;
  deviceId: DeviceId;
  generation: number;
}

export type DeviceLoginResult =
  | {
      kind: "success";
      storageState: string;
      loginAt: EpochMs;
      bindingEpoch: number;
    }
  | {
      kind: "needs_reauth";
      reason: "unbound" | "credentials_rejected" | "interactive_required";
    }
  | { kind: "temporary_unavailable"; retryAfterMs: number }
  | { kind: "cancelled" };

export interface HeartbeatInput {
  protocolVersion: 1;
  appliedVersion: number | null;
  generation: number;
  browserVersion: string;
}

export interface QuotaPreview {
  token: string;
  expiresAt: number;
  revision: number;
  oldLimit: number;
  newLimit: number;
  kept: DeviceId[];
  disabled: DeviceId[];
}

export interface QuotaApply {
  token: string;
  newLimit: number;
}
