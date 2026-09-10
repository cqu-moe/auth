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
    const body = await response.json<{ result?: T; error?: { code: ErrorCode } }>();
    if (!response.ok || body.error) {
      throw new QuickloginDeviceError(body.error?.code ?? "TEMPORARY_UNAVAILABLE");
    }
    return body.result as T;
  }

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
