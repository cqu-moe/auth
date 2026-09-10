import type { Env } from "../../types";
import type {
  DeviceAuthority,
  DeviceList,
  DeviceMetadata,
  DeviceRecord,
  ErrorCode,
  GrantRecord,
  HeartbeatInput,
  QuotaApply,
  QuotaPreview,
} from "./contracts";

type AccountOperation =
  | "create_pending_grant"
  | "activate_grant"
  | "register_device"
  | "set_device_enabled"
  | "set_master_enabled"
  | "revoke_device"
  | "get_device_authority"
  | "assert_grant"
  | "list_devices"
  | "heartbeat"
  | "preview_quota"
  | "apply_quota";

export class QuickloginAccountClientError extends Error {
  readonly preview?: QuotaPreview;

  constructor(
    public readonly code: ErrorCode,
    message: string = code,
    preview?: QuotaPreview
  ) {
    super(message);
    this.name = "QuickloginAccountClientError";
    this.preview = preview;
  }
}

export class QuickloginAccountClient {
  constructor(private readonly env: Env) {}

  private async call<T>(
    userId: string,
    operation: AccountOperation,
    payload: Record<string, unknown>
  ): Promise<T> {
    const id = this.env.CQU_QUICKLOGIN_ACCOUNT.idFromName(userId);
    const response = await this.env.CQU_QUICKLOGIN_ACCOUNT.get(id).fetch(
      "http://quicklogin.internal/account",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation, ownerUserId: userId, payload }),
      }
    );
    const body = await response.json<{
      result?: T;
      error?: { code: ErrorCode; message: string };
      preview?: QuotaPreview;
    }>();
    if (!response.ok || body.error) {
      const error = body.error ?? {
        code: "TEMPORARY_UNAVAILABLE" as const,
        message: "TEMPORARY_UNAVAILABLE",
      };
      throw new QuickloginAccountClientError(
        error.code,
        error.message,
        body.preview
      );
    }
    return body.result as T;
  }

  createPendingGrant(
    userId: string,
    clientId: string,
    now: number
  ): Promise<GrantRecord> {
    return this.call(userId, "create_pending_grant", { clientId, now });
  }

  activateGrant(
    userId: string,
    grantId: string,
    now: number
  ): Promise<GrantRecord> {
    return this.call(userId, "activate_grant", { grantId, now });
  }

  registerDevice(
    userId: string,
    grantId: string,
    metadata: DeviceMetadata
  ): Promise<DeviceRecord> {
    return this.call(userId, "register_device", { grantId, metadata });
  }

  setDeviceEnabled(
    userId: string,
    deviceId: string,
    enabled: boolean
  ): Promise<DeviceAuthority> {
    return this.call(userId, "set_device_enabled", { deviceId, enabled });
  }

  setMasterEnabled(
    userId: string,
    enabled: boolean
  ): Promise<DeviceList> {
    return this.call(userId, "set_master_enabled", { enabled });
  }

  async revokeDevice(
    userId: string,
    deviceId: string,
    now: number
  ): Promise<void> {
    await this.call(userId, "revoke_device", { deviceId, now });
  }

  getDeviceAuthority(
    userId: string,
    deviceId: string
  ): Promise<DeviceAuthority> {
    return this.call(userId, "get_device_authority", { deviceId });
  }

  assertGrant(
    userId: string,
    grantId: string,
    clientId: string
  ): Promise<GrantRecord> {
    return this.call(userId, "assert_grant", { grantId, clientId });
  }

  listDevices(userId: string, now: number): Promise<DeviceList> {
    return this.call(userId, "list_devices", { now });
  }

  async heartbeat(
    userId: string,
    deviceId: string,
    input: HeartbeatInput,
    ip: string | null,
    now: number
  ): Promise<void> {
    await this.call(userId, "heartbeat", { deviceId, input, ip, now });
  }

  previewQuota(
    userId: string,
    limit: number,
    now: number
  ): Promise<QuotaPreview> {
    return this.call(userId, "preview_quota", { limit, now });
  }

  applyQuota(
    userId: string,
    input: QuotaApply,
    now: number
  ): Promise<DeviceList> {
    return this.call(userId, "apply_quota", { input, now });
  }
}
