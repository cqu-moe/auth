import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { QuickloginAccountClient } from "../../src/services/quicklogin/account-client";
import { QuickloginDeviceClient } from "../../src/services/quicklogin/device-client";
import { QuickloginLoginBrokerClient } from "../../src/services/quicklogin/login-broker-client";
import { readStorage, seedCredentials, seedSession, spyBrowserFetch, validStorageState } from "./helpers";

function exportableStorageState(marker = "") {
  const state = validStorageState();
  return {
    ...state,
    cookies: state.cookies.map((cookie) => ({
      ...cookie,
      value: `${cookie.value}${marker}`,
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
      expires: -1,
    })),
  };
}

async function setupDevice() {
  const accounts = new QuickloginAccountClient(env);
  const userId = `device-do-${crypto.randomUUID()}`;
  await accounts.setMasterEnabled(userId, true);
  const preview = await accounts.previewQuota(userId, 1, Date.now());
  await accounts.applyQuota(userId, { token: preview.token, newLimit: 1 }, Date.now());
  const grant = await accounts.createPendingGrant(userId, "quicklogin-test-client", Date.now());
  await accounts.activateGrant(userId, grant.grantId, Date.now());
  const device = await accounts.registerDevice(userId, grant.grantId, {
    deviceName: "Device DO Chrome",
    browserFamily: "chrome",
    browserVersion: "140",
  });
  const authority = await accounts.setDeviceEnabled(userId, device.deviceId, true);
  return { accounts, userId, device, authority };
}

describe("CquQuickloginDeviceDO", () => {
  it("logs in and exports validated SSO cookies", async () => {
    const { userId, authority } = await setupDevice();
    const sessionStub = env.CQU_SESSION.get(env.CQU_SESSION.idFromName(userId));
    await seedSession(sessionStub, { status: "active" });
    await seedCredentials(sessionStub);
    await runInDurableObject(sessionStub, async (_instance, state) => {
      const current = await state.storage.get<Record<string, unknown>>("state");
      await state.storage.put("state", { ...current, userId });
    });
    spyBrowserFetch({
      "/health": () => Response.json({
        ok: true,
        bootId: "device-boot",
        browserProfile: "cloudflare",
        capabilities: ["browser-route-v1", "operation-deadline-v1"],
      }),
      "/code-permit": () => Response.json({ ok: true }),
      "/run": () => Response.json({ ok: true, state: exportableStorageState() }),
      "/keepalive": () => Response.json({
        ok: true,
        status: "alive",
        state: exportableStorageState("-rotated"),
      }),
    });
    const devices = new QuickloginDeviceClient(env);
    await devices.notifyDevice(authority);
    const stub = env.CQU_QUICKLOGIN_DEVICE.get(
      env.CQU_QUICKLOGIN_DEVICE.idFromName(
        `${userId}:${authority.deviceId}`
      )
    );
    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as { alarm(): Promise<void> }).alarm();
    });
    await expect(devices.readDeviceSession(userId, authority.deviceId))
      .resolves.toMatchObject({ state: "ready", sessionVersion: 1 });
    await expect(devices.exportDeviceCookies(authority)).resolves.toMatchObject({
      protocolVersion: 1,
      deviceId: authority.deviceId,
      generation: authority.generation,
      sessionVersion: 1,
      cookies: expect.arrayContaining([
        expect.objectContaining({ name: "SOURCEID_TGC" }),
      ]),
    });
    const before = await devices.readDeviceSession(userId, authority.deviceId);
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("session", { ...before, lastKeepAliveAt: 0 });
    });
    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as { alarm(): Promise<void> }).alarm();
    });
    await expect(devices.readDeviceSession(userId, authority.deviceId))
      .resolves.toMatchObject({
        state: "ready",
        sessionVersion: 2,
        loginAt: before.loginAt,
      });
    const broker = new QuickloginLoginBrokerClient(env);
    const operationId = crypto.randomUUID();
    await broker.recordQuickloginKeepaliveMint(userId, {
      deviceId: authority.deviceId,
      operationId,
      mintedAt: Date.now(),
    });
    await broker.recordQuickloginKeepaliveMint(userId, {
      deviceId: authority.deviceId,
      operationId,
      mintedAt: Date.now(),
    });
    const mintLog =
      (await readStorage<unknown[]>(sessionStub, "stMintLog")) ?? [];
    expect(mintLog).toHaveLength(2);
  });

  it("ignores stale notification and rejects export after revocation", async () => {
    const { accounts, userId, device, authority } = await setupDevice();
    const devices = new QuickloginDeviceClient(env);
    await devices.notifyDevice(authority);
    await devices.notifyDevice({
      ...authority,
      generation: authority.generation - 1,
    });
    await expect(devices.readDeviceSession(userId, device.deviceId))
      .resolves.toMatchObject({ generation: authority.generation });
    await accounts.revokeDevice(userId, device.deviceId, Date.now());
    await expect(devices.exportDeviceCookies(authority))
      .rejects.toMatchObject({ code: "DEVICE_REVOKED" });
  });

  it("drops a successful login result that arrives after revocation", async () => {
    const { accounts, userId, device, authority } = await setupDevice();
    const sessionStub = env.CQU_SESSION.get(env.CQU_SESSION.idFromName(userId));
    await seedSession(sessionStub, { status: "active" });
    await seedCredentials(sessionStub);
    await runInDurableObject(sessionStub, async (_instance, state) => {
      const current = await state.storage.get<Record<string, unknown>>("state");
      await state.storage.put("state", { ...current, userId });
    });
    spyBrowserFetch({
      "/health": () => Response.json({
        ok: true,
        bootId: "late-boot",
        browserProfile: "cloudflare",
        capabilities: ["browser-route-v1", "operation-deadline-v1"],
      }),
      "/code-permit": () => Response.json({ ok: true }),
      "/run": async () => {
        await accounts.revokeDevice(userId, device.deviceId, Date.now());
        return Response.json({ ok: true, state: exportableStorageState() });
      },
    });
    const devices = new QuickloginDeviceClient(env);
    await devices.notifyDevice(authority);
    const stub = env.CQU_QUICKLOGIN_DEVICE.get(
      env.CQU_QUICKLOGIN_DEVICE.idFromName(`${userId}:${device.deviceId}`)
    );
    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as { alarm(): Promise<void> }).alarm();
    });
    await expect(devices.readDeviceSession(userId, device.deviceId))
      .resolves.toMatchObject({
        state: "revoked",
        storageState: null,
        generation: authority.generation + 1,
      });
  });

  it("enforces per-device minute buckets", async () => {
    const { userId, device } = await setupDevice();
    const devices = new QuickloginDeviceClient(env);
    for (let count = 0; count < 3; count += 1) {
      await devices.consumeRateLimit(
        userId,
        device.deviceId,
        "refresh",
        3,
        1_800_000_000_000
      );
    }
    await expect(
      devices.consumeRateLimit(
        userId,
        device.deviceId,
        "refresh",
        3,
        1_800_000_000_000
      )
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
});
