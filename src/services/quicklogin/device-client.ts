import { V3Error, type DeviceV3Read } from "./device-v3-store";
import type { Operation, OperationRequest, ReconcileRequest, ReceiptRequest, VersionTuple, ExportEnvelope, ReceiptAck } from "./protocol-v3";
import type { Env } from "../../types";
import type { CookieEnvelope, DeviceAuthority, ErrorCode, StoredDeviceSession } from "./contracts";

export class QuickloginDeviceError extends Error {
  constructor(public readonly code: ErrorCode) {
    super(code);
    this.name = "QuickloginDeviceError";
  }
}

export class QuickloginDeviceClient {
  constructor(private readonly env: Pick<Env, "CQU_QUICKLOGIN_DEVICE">) {}

  private async call<T>(
    userId: string,
    deviceId: string,
    operation: string,
    payload: Record<string, unknown> = {}
  ): Promise<T> {
    const id = this.env.CQU_QUICKLOGIN_DEVICE.idFromName(`${userId}:${deviceId}`);
    const response = await this.env.CQU_QUICKLOGIN_DEVICE.get(id).fetch(
      "https://quicklogin-device/internal",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation, ownerUserId: userId, deviceId, payload }),
      }
    );
    const body = await response.json<{ result?: T; error?: { code: ErrorCode; retryAt?: number | null } }>();
    if (!response.ok || body.error) {
      if (operation.startsWith("v3_")) throw new V3Error((body.error?.code ?? "INTERNAL_STATE_UNAVAILABLE") as import("./protocol-v3").ReasonCode, body.error?.retryAt ?? null);
      throw new QuickloginDeviceError(body.error?.code ?? "TEMPORARY_UNAVAILABLE");
    }
    return body.result as T;
  }

  readV3(authority: DeviceAuthority): Promise<DeviceV3Read> { return this.call(authority.ownerUserId, authority.deviceId, "v3_read", { authority }); }
  operateV3(authority: DeviceAuthority, input: OperationRequest): Promise<Operation> { return this.call(authority.ownerUserId, authority.deviceId, "v3_operation", { authority, input }); }
  operationV3(authority: DeviceAuthority, operationId: string): Promise<Operation> { return this.call(authority.ownerUserId, authority.deviceId, "v3_operation_read", { authority, operationId }); }
  exportV3(authority: DeviceAuthority, expected: VersionTuple): Promise<ExportEnvelope> { return this.call(authority.ownerUserId, authority.deviceId, "v3_export", { authority, expected }); }
  receiptV3(authority: DeviceAuthority, input: ReceiptRequest): Promise<Omit<ReceiptAck, "snapshot">> { return this.call(authority.ownerUserId, authority.deviceId, "v3_receipt", { authority, input }); }
  reportV3(authority: DeviceAuthority, input: ReconcileRequest): Promise<void> { return this.call(authority.ownerUserId, authority.deviceId, "v3_report", { authority, input }); }

  notifyDevice(authority: DeviceAuthority): Promise<void> {
    return this.call(authority.ownerUserId, authority.deviceId, "notify", { authority });
  }

  readDeviceSession(userId: string, deviceId: string): Promise<StoredDeviceSession> {
    return this.call(userId, deviceId, "read");
  }

  requestDeviceRefresh(authority: DeviceAuthority): Promise<void> {
    return this.call(authority.ownerUserId, authority.deviceId, "refresh", { authority });
  }

  exportDeviceCookies(authority: DeviceAuthority): Promise<CookieEnvelope> {
    return this.call(authority.ownerUserId, authority.deviceId, "export", { authority });
  }

  consumeRateLimit(
    userId: string,
    deviceId: string,
    kind: "status" | "export" | "refresh",
    limit: number,
    now: number
  ): Promise<void> {
    return this.call(userId, deviceId, "rate", { kind, limit, now });
  }
}
