import { applyD1Migrations, env, runInDurableObject } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/types";
import { QuickloginAccountClient } from "../../src/services/quicklogin/account-client";
import type {
  AccountState,
  DeviceRecord,
} from "../../src/services/quicklogin/contracts";
import { projectAccount } from "../../src/services/quicklogin/projection";
import type { OutboxEvent } from "../../src/services/quicklogin/outbox";

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DATABASE.prepare("DELETE FROM quicklogin_device_projection").run();
  await env.DATABASE.prepare("DELETE FROM quicklogin_account_projection").run();
  await env.DATABASE.prepare(
    "DELETE FROM user_entitlement WHERE subsystem = 'cqu' AND capability IN ('quicklogin', 'quicklogin_device_limit')"
  ).run();
});

function device(
  deviceId: string,
  overrides: Partial<DeviceRecord> = {}
): DeviceRecord {
  return {
    deviceId,
    ownerUserId: "projection-user",
    grantId: `grant-${deviceId}`,
    deviceName: `Chrome ${deviceId}`,
    browserFamily: "chrome",
    browserVersion: "140",
    enabled: true,
    enabledAt: 100,
    lastSeenAt: 200,
    lastIp: "192.0.2.1",
    revokedAt: null,
    generation: 2,
    disabledReason: null,
    appliedVersion: 1,
    ...overrides,
  };
}

function accountState(revision: number, limit: number): AccountState {
  return {
    schemaVersion: 1,
    revision,
    masterEnabled: true,
    deviceLimit: limit,
    devices: {
      "device-a": device("device-a"),
      "device-b": device("device-b", { enabled: false }),
    },
    grants: {},
  };
}

describe("quicklogin D1 projection", () => {
  it("delivers projection outbox events without dropping other consumers", async () => {
    const client = new QuickloginAccountClient(env);
    const userId = `projection-outbox-${crypto.randomUUID()}`;
    await client.setMasterEnabled(userId, true);
    const stub = env.CQU_QUICKLOGIN_ACCOUNT.get(
      env.CQU_QUICKLOGIN_ACCOUNT.idFromName(userId)
    );
    await runInDurableObject(stub, async (_instance, storage) => {
      const outbox =
        (await storage.storage.get<OutboxEvent[]>("outbox")) ?? [];
      await storage.storage.put(
        "outbox",
        outbox.map((event) => ({ ...event, nextAttemptAt: Date.now() - 1 }))
      );
      await storage.storage.setAlarm(Date.now() - 1);
    });

    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as { alarm(): Promise<void> }).alarm();
    });

    const projected = await env.DATABASE.prepare(
      "SELECT master_enabled FROM quicklogin_account_projection WHERE user_id = ?"
    )
      .bind(userId)
      .first<{ master_enabled: number }>();
    const outbox = await runInDurableObject(
      stub,
      async (_instance, storage) =>
        (await storage.storage.get<OutboxEvent[]>("outbox")) ?? []
    );
    expect(projected?.master_enabled).toBe(1);
    expect(outbox.some((event) => event.kind === "projection")).toBe(false);
  });

  it("does not let a lower revision overwrite projection rows", async () => {
    await projectAccount(env, "projection-user", accountState(10, 5));
    await projectAccount(env, "projection-user", accountState(9, 1));

    const account = await env.DATABASE.prepare(
      "SELECT revision, device_limit, master_enabled FROM quicklogin_account_projection WHERE user_id = ?"
    )
      .bind("projection-user")
      .first<{
        revision: number;
        device_limit: number;
        master_enabled: number;
      }>();
    const devices = await env.DATABASE.prepare(
      "SELECT revision, payload_json FROM quicklogin_device_projection WHERE user_id = ? ORDER BY device_id"
    )
      .bind("projection-user")
      .all<{ revision: number; payload_json: string }>();
    const quota = await env.DATABASE.prepare(
      "SELECT value FROM user_entitlement WHERE user_id = ? AND subsystem = 'cqu' AND capability = 'quicklogin_device_limit'"
    )
      .bind("projection-user")
      .first<{ value: string }>();

    expect(account).toEqual({ revision: 10, device_limit: 5, master_enabled: 1 });
    expect(devices.results).toHaveLength(2);
    expect(devices.results.every((row) => row.revision === 10)).toBe(true);
    for (const row of devices.results) {
      expect(JSON.parse(row.payload_json)).not.toHaveProperty("grantId");
    }
    expect(quota?.value).toBe("5");
  });

  it("keeps authoritative revocation when projection fails and converges on retry", async () => {
    const client = new QuickloginAccountClient(env);
    const userId = `projection-failure-${crypto.randomUUID()}`;
    await client.setMasterEnabled(userId, true);
    const preview = await client.previewQuota(userId, 1, Date.now());
    await client.applyQuota(
      userId,
      { token: preview.token, newLimit: 1 },
      Date.now()
    );
    const pending = await client.createPendingGrant(
      userId,
      "quicklogin-test-client",
      Date.now()
    );
    await client.activateGrant(userId, pending.grantId, Date.now());
    const registered = await client.registerDevice(userId, pending.grantId, {
      deviceName: "Projection Failure Chrome",
      browserFamily: "chrome",
      browserVersion: "140",
    });
    await client.setDeviceEnabled(userId, registered.deviceId, true);
    await client.revokeDevice(userId, registered.deviceId, Date.now());
    const stub = env.CQU_QUICKLOGIN_ACCOUNT.get(
      env.CQU_QUICKLOGIN_ACCOUNT.idFromName(userId)
    );
    const state = await runInDurableObject(stub, async (_instance, storage) =>
      storage.storage.get<AccountState>("account")
    );
    if (!state) throw new Error("missing account state");
    const failingDatabase = new Proxy(env.DATABASE, {
      get(target, property) {
        if (property === "batch") {
          return async () => {
            throw new Error("synthetic projection failure");
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const failingEnv = { ...env, DATABASE: failingDatabase } as Env;

    await expect(projectAccount(failingEnv, userId, state)).rejects.toThrowError(
      "synthetic projection failure"
    );
    await expect(
      client.getDeviceAuthority(userId, registered.deviceId)
    ).resolves.toMatchObject({ allowed: false, reason: "DEVICE_REVOKED" });
    await projectAccount(env, userId, state);
    const projected = await env.DATABASE.prepare(
      "SELECT payload_json FROM quicklogin_device_projection WHERE device_id = ?"
    )
      .bind(registered.deviceId)
      .first<{ payload_json: string }>();
    expect(JSON.parse(projected?.payload_json ?? "{}")).toMatchObject({
      revokedAt: expect.any(Number),
      enabled: false,
    });
  });
});
