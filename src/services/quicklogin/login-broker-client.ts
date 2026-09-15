import { validBindingSnapshot, type BindingSnapshot } from "./binding-snapshot";
import type { Env } from "../../types";
import type {
  DeviceLoginRequest,
  DeviceLoginResult,
} from "./contracts";

export class QuickloginLoginBrokerClient {
  constructor(private readonly env: Pick<Env, "CQU_SESSION">) {}

  async quickloginLogin(input: DeviceLoginRequest): Promise<DeviceLoginResult> {
    const stub = this.env.CQU_SESSION.get(
      this.env.CQU_SESSION.idFromName(input.ownerUserId)
    );
    const response = await stub.fetch("https://cqu-session/quicklogin-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      return { kind: "temporary_unavailable", retryAfterMs: 60_000 };
    }
    return response.json<DeviceLoginResult>();
  }

  async getQuickloginBindingEpoch(
    userId: string
  ): Promise<{ bound: boolean; epoch: number }> {
    const stub = this.env.CQU_SESSION.get(
      this.env.CQU_SESSION.idFromName(userId)
    );
    const response = await stub.fetch("https://cqu-session/quicklogin-binding");
    if (!response.ok) throw new Error("INTERNAL_STATE_UNAVAILABLE");
    const binding = await response.json<{ bound: boolean; epoch: number }>().catch(() => null);
    if (!binding || typeof binding.bound !== "boolean" || !Number.isSafeInteger(binding.epoch) || binding.epoch < 0) {
      throw new Error("INTERNAL_STATE_UNAVAILABLE");
    }
    return binding;
  }

  async getBindingSnapshot(userId: string): Promise<BindingSnapshot> {
    const stub = this.env.CQU_SESSION.get(this.env.CQU_SESSION.idFromName(userId));
    const response = await stub.fetch("https://cqu-session/quicklogin-binding-v3");
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok || !validBindingSnapshot(data)) throw new Error("INTERNAL_STATE_UNAVAILABLE");
    return data;
  }

  async recordQuickloginKeepaliveMint(
    userId: string,
    input: { deviceId: string; operationId: string; mintedAt: number }
  ): Promise<void> {
    const stub = this.env.CQU_SESSION.get(
      this.env.CQU_SESSION.idFromName(userId)
    );
    const response = await stub.fetch(
      "https://cqu-session/quicklogin-keepalive-mint",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }
    );
    if (!response.ok) throw new Error("TEMPORARY_UNAVAILABLE");
  }
}
