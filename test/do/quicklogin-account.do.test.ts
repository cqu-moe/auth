import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  QuickloginAccountClient,
  QuickloginAccountClientError,
} from "../../src/services/quicklogin/account-client";
import type {
  AccountState,
  DeviceMetadata,
  DeviceRecord,
  HeartbeatInput,
} from "../../src/services/quicklogin/contracts";
import type { OutboxEvent } from "../../src/services/quicklogin/outbox";

const OFFICIAL_CLIENT = "official-client";
const TEST_NOW = Date.now() - 60_000;
const METADATA: DeviceMetadata = {
  deviceName: "Synthetic Chrome",
  browserFamily: "chrome",
  browserVersion: "140",
};

function freshUser(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function account(): QuickloginAccountClient {
  return new QuickloginAccountClient(env);
}

async function configurePolicy(
  client: QuickloginAccountClient,
  userId: string,
  limit: number
): Promise<void> {
  await client.setMasterEnabled(userId, true);
  const preview = await client.previewQuota(userId, limit, TEST_NOW);
  await client.applyQuota(
    userId,
    { token: preview.token, newLimit: limit },
    TEST_NOW + 1
  );
}

async function registerDevice(
  client: QuickloginAccountClient,
  userId: string,
  suffix: string
): Promise<DeviceRecord> {
  const pending = await client.createPendingGrant(
    userId,
    `${OFFICIAL_CLIENT}-${suffix}`,
    TEST_NOW
  );
  await client.activateGrant(userId, pending.grantId, TEST_NOW + 1);
  return client.registerDevice(userId, pending.grantId, {
    ...METADATA,
    deviceName: `Synthetic Chrome ${suffix}`,
  });
}

function heartbeat(device: DeviceRecord, appliedVersion: number | null = null): HeartbeatInput {
  return {
    protocolVersion: 2,
    appliedVersion,
    observedGeneration: device.generation,
    browserVersion: "140.0.0",
  };
}

describe("CquQuickloginAccountDO", () => {
  it("serializes concurrent slot claims through the real client and DO", async () => {
    const client = account();
    const userId = freshUser("quota-race");
    await configurePolicy(client, userId, 1);
    const first = await registerDevice(client, userId, "a");
    const second = await registerDevice(client, userId, "b");

    const results = await Promise.allSettled([
      client.setDeviceEnabled(userId, first.deviceId, true),
      client.setDeviceEnabled(userId, second.deviceId, true),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    expect(rejection?.reason).toBeInstanceOf(QuickloginAccountClientError);
    expect(rejection?.reason).toMatchObject({ code: "DEVICE_LIMIT_REACHED" });
    expect((await client.listDevices(userId, Date.now())).used).toBe(1);
  });

  it("rejects a stale quota preview when heartbeat changes the kept device", async () => {
    const client = account();
    const userId = freshUser("preview-changed");
    await configurePolicy(client, userId, 2);
    const first = await registerDevice(client, userId, "a");
    const second = await registerDevice(client, userId, "b");
    const enabledFirst = await client.setDeviceEnabled(userId, first.deviceId, true);
    const enabledSecond = await client.setDeviceEnabled(userId, second.deviceId, true);
    await client.heartbeat(
      userId,
      enabledFirst.deviceId,
      heartbeat({ ...first, generation: enabledFirst.generation }),
      "192.0.2.1",
      TEST_NOW + 100
    );
    await client.heartbeat(
      userId,
      enabledSecond.deviceId,
      heartbeat({ ...second, generation: enabledSecond.generation }),
      "192.0.2.2",
      TEST_NOW + 200
    );
    const preview = await client.previewQuota(userId, 1, TEST_NOW + 300);
    expect(preview.kept).toEqual([enabledSecond.deviceId]);

    await client.heartbeat(
      userId,
      enabledFirst.deviceId,
      heartbeat({ ...first, generation: enabledFirst.generation }),
      "192.0.2.3",
      TEST_NOW + 400
    );

    await expect(
      client.applyQuota(
        userId,
        { token: preview.token, newLimit: 1 },
        TEST_NOW + 500
      )
    ).rejects.toMatchObject({
      code: "PREVIEW_CHANGED",
      preview: expect.objectContaining({ kept: [enabledFirst.deviceId] }),
    });
    const list = await client.listDevices(userId, TEST_NOW + 500);
    expect(list.deviceLimit).toBe(2);
    expect(list.used).toBe(2);
  });

  it("rejects an old quota preview when another quota change kept the same device set", async () => {
    const client = account();
    const userId = freshUser("preview-old-limit");
    await configurePolicy(client, userId, 2);

    const stale = await client.previewQuota(userId, 1, TEST_NOW + 100);
    const current = await client.previewQuota(userId, 3, TEST_NOW + 200);
    await client.applyQuota(
      userId,
      { token: current.token, newLimit: 3 },
      TEST_NOW + 300
    );

    await expect(client.applyQuota(
      userId,
      { token: stale.token, newLimit: 1 },
      TEST_NOW + 400
    )).rejects.toMatchObject({
      code: "PREVIEW_CHANGED",
      preview: expect.objectContaining({ oldLimit: 3, newLimit: 1 }),
    });
    await expect(client.listDevices(userId, TEST_NOW + 400)).resolves
      .toMatchObject({ deviceLimit: 3 });
  });

  it("applies a preview after a revision-only heartbeat and replays the token idempotently", async () => {
    const client = account();
    const userId = freshUser("preview-idempotent");
    await configurePolicy(client, userId, 2);
    const first = await registerDevice(client, userId, "a");
    const second = await registerDevice(client, userId, "b");
    const enabledFirst = await client.setDeviceEnabled(userId, first.deviceId, true);
    const enabledSecond = await client.setDeviceEnabled(userId, second.deviceId, true);
    await client.heartbeat(
      userId,
      enabledFirst.deviceId,
      heartbeat({ ...first, generation: enabledFirst.generation }),
      null,
      TEST_NOW + 100
    );
    await client.heartbeat(
      userId,
      enabledSecond.deviceId,
      heartbeat({ ...second, generation: enabledSecond.generation }),
      null,
      TEST_NOW + 200
    );
    const preview = await client.previewQuota(userId, 1, TEST_NOW + 300);
    await client.heartbeat(
      userId,
      enabledSecond.deviceId,
      heartbeat({ ...second, generation: enabledSecond.generation }),
      null,
      TEST_NOW + 400
    );

    const applied = await client.applyQuota(
      userId,
      { token: preview.token, newLimit: 1 },
      TEST_NOW + 500
    );
    const replayed = await client.applyQuota(
      userId,
      { token: preview.token, newLimit: 1 },
      TEST_NOW + 600
    );

    expect(replayed).toEqual(applied);
    expect(applied.used).toBe(1);
    const disabledId = preview.disabled[0];
    expect(
      applied.devices.find((device) => device.deviceId === disabledId)
    ).toMatchObject({
      enabled: false,
      disabledReason: "quota_reduced",
    });
  });

  it("accepts heartbeat reordering when the kept and disabled sets stay unchanged", async () => {
    const client = account();
    const userId = freshUser("preview-set-equality");
    await configurePolicy(client, userId, 3);
    const registered = await Promise.all([
      registerDevice(client, userId, "a"),
      registerDevice(client, userId, "b"),
      registerDevice(client, userId, "c"),
    ]);
    const enabled = [];
    for (const record of registered) {
      enabled.push(await client.setDeviceEnabled(userId, record.deviceId, true));
    }
    for (let index = 0; index < enabled.length; index += 1) {
      await client.heartbeat(
        userId,
        enabled[index].deviceId,
        heartbeat({ ...registered[index], generation: enabled[index].generation }),
        null,
        TEST_NOW + 100 + index * 100
      );
    }
    const preview = await client.previewQuota(userId, 2, TEST_NOW + 500);
    const keptBefore = new Set(preview.kept);

    await client.heartbeat(
      userId,
      preview.kept[1],
      heartbeat({
        ...registered.find((record) => record.deviceId === preview.kept[1])!,
        generation: enabled.find((record) => record.deviceId === preview.kept[1])!
          .generation,
      }),
      null,
      TEST_NOW + 600
    );
    const applied = await client.applyQuota(
      userId,
      { token: preview.token, newLimit: 2 },
      TEST_NOW + 700
    );

    expect(applied.used).toBe(2);
    expect(
      new Set(
        applied.devices
          .filter((device) => device.enabled)
          .map((device) => device.deviceId)
      )
    ).toEqual(keptBefore);
  });

  it("keeps undeliverable outbox events and backs off their alarm", async () => {
    const client = account();
    const userId = freshUser("outbox");
    await configurePolicy(client, userId, 1);
    const record = await registerDevice(client, userId, "a");
    await client.setDeviceEnabled(userId, record.deviceId, true);
    const stub = env.CQU_QUICKLOGIN_ACCOUNT.get(
      env.CQU_QUICKLOGIN_ACCOUNT.idFromName(userId)
    );

    const before = await runInDurableObject(stub, async (_instance, state) => ({
      account: await state.storage.get<AccountState>("account"),
      outbox: (await state.storage.get<OutboxEvent[]>("outbox")) ?? [],
    }));
    expect(before.account).toMatchObject({ masterEnabled: true, deviceLimit: 1 });
    expect(before.outbox.length).toBeGreaterThan(0);
    const unavailable: OutboxEvent = {
      id: "synthetic-revoke-event",
      kind: "revoke-oauth-family",
      revision: before.account!.revision,
      deviceId: record.deviceId,
      generation: record.generation,
      grantId: record.grantId,
      attempts: 0,
      nextAttemptAt: TEST_NOW,
    };

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put(
        "outbox",
        [
          ...before.outbox.map((event) => ({
            ...event,
            nextAttemptAt: TEST_NOW,
          })),
          unavailable,
        ]
      );
      await state.storage.setAlarm(TEST_NOW);
    });

    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as { alarm(): Promise<void> }).alarm();
    });

    const after = await runInDurableObject(stub, async (_instance, state) => ({
      outbox: (await state.storage.get<OutboxEvent[]>("outbox")) ?? [],
      alarm: await state.storage.getAlarm(),
    }));
    const retained = after.outbox.find((event) => event.id === unavailable.id);
    expect(retained).toMatchObject({
      kind: "revoke-oauth-family",
    });
    expect(retained?.attempts).toBeGreaterThanOrEqual(1);
    expect(after.alarm).not.toBeNull();
  });

  it("compacts 1000 failed event waves in storage while retaining latest projection and revocation", async () => {
    const userId = freshUser("bounded-outbox");
    const client = account();
    await client.setMasterEnabled(userId, true);
    const stub = env.CQU_QUICKLOGIN_ACCOUNT.get(
      env.CQU_QUICKLOGIN_ACCOUNT.idFromName(userId)
    );
    const future = Date.now() + 60_000;
    const events = Array.from({ length: 1000 }, (_, index) => [
      {
        id: `projection-${index}`, kind: "projection" as const, revision: index,
        attempts: index, nextAttemptAt: future,
      },
      {
        id: `revoke-${index}`, kind: "revoke-oauth-family" as const,
        revision: index, grantId: "grant-latest", attempts: index,
        nextAttemptAt: future,
      },
    ]).flat();
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("outbox", events);
      await state.storage.setAlarm(future);
    });
    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as { alarm(): Promise<void> }).alarm();
    });
    const stored = await runInDurableObject(stub, async (_instance, state) =>
      (await state.storage.get<OutboxEvent[]>("outbox")) ?? []
    );
    expect(stored).toHaveLength(2);
    expect(stored).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "projection", revision: 999 }),
      expect.objectContaining({ kind: "revoke-oauth-family", grantId: "grant-latest", revision: 999 }),
    ]));
  });

  it("persists one owner and rejects a mismatched internal caller", async () => {
    const client = account();
    const userId = freshUser("owner");
    await client.setMasterEnabled(userId, true);
    const stub = env.CQU_QUICKLOGIN_ACCOUNT.get(
      env.CQU_QUICKLOGIN_ACCOUNT.idFromName(userId)
    );

    const response = await stub.fetch("http://quicklogin.internal/account", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operation: "list_devices",
        ownerUserId: "different-user",
        payload: { now: TEST_NOW },
      }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "FORBIDDEN" },
    });
  });
});
