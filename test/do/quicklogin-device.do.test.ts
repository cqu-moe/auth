import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
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

  it("uses the elapsed failure window and resets it after recovery", async () => {
    const minute = 60_000;
    let currentTime = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => currentTime);
    const { userId, authority } = await setupDevice();
    const sessionStub = env.CQU_SESSION.get(env.CQU_SESSION.idFromName(userId));
    await seedSession(sessionStub, { status: "active" });
    await seedCredentials(sessionStub);
    await runInDurableObject(sessionStub, async (_instance, state) => {
      const current = await state.storage.get<Record<string, unknown>>("state");
      await state.storage.put("state", { ...current, userId });
    });
    let keepaliveSucceeds = false;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    spyBrowserFetch({
      "/health": () => Response.json({
        ok: true,
        bootId: "retry-window-boot",
        browserProfile: "cloudflare",
        capabilities: ["browser-route-v1", "operation-deadline-v1"],
      }),
      "/code-permit": () => Response.json({ ok: true }),
      "/run": () => Response.json({ ok: true, state: exportableStorageState() }),
      "/keepalive": () => keepaliveSucceeds
        ? Response.json({
            ok: true,
            status: "alive",
            state: exportableStorageState("-recovered"),
          })
        : Response.json(
            { ok: false, error: "SOURCEID_TGC=must-not-reach-logs" },
            { status: 400 }
          ),
    });
    const devices = new QuickloginDeviceClient(env);
    await devices.notifyDevice(authority);
    const stub = env.CQU_QUICKLOGIN_DEVICE.get(
      env.CQU_QUICKLOGIN_DEVICE.idFromName(`${userId}:${authority.deviceId}`)
    );
    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as { alarm(): Promise<void> }).alarm();
    });
    const ready = await devices.readDeviceSession(userId, authority.deviceId);
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("session", { ...ready, lastKeepAliveAt: 0 });
    });

    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as { alarm(): Promise<void> }).alarm();
    });
    await expect(devices.readDeviceSession(userId, authority.deviceId))
      .resolves.toMatchObject({
        state: "temporary_unavailable",
        transientFailures: 1,
        transientStartedAt: currentTime,
        nextAttemptAt: currentTime + minute,
      });
    expect(warning).toHaveBeenCalledWith({
      evt: "quicklogin_maintenance_failure",
      phase: "keepalive_response",
      deviceId: authority.deviceId,
      generation: authority.generation,
      httpStatus: 400,
      backendStatus: null,
    });
    expect(JSON.stringify(warning.mock.calls)).not.toContain("must-not-reach-logs");

    currentTime += 5 * minute;
    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as { alarm(): Promise<void> }).alarm();
    });
    await expect(devices.readDeviceSession(userId, authority.deviceId))
      .resolves.toMatchObject({
        transientFailures: 2,
        transientStartedAt: currentTime - 5 * minute,
        nextAttemptAt: currentTime + 3 * minute,
      });

    keepaliveSucceeds = true;
    currentTime += 3 * minute;
    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as { alarm(): Promise<void> }).alarm();
    });
    await expect(devices.readDeviceSession(userId, authority.deviceId))
      .resolves.toMatchObject({
        state: "ready",
        transientFailures: 0,
        transientStartedAt: null,
      });
  });

  it("cancels persisted backoff when the device requests an immediate refresh", async () => {
    let currentTime = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => currentTime);
    const { userId, authority } = await setupDevice();
    const sessionStub = env.CQU_SESSION.get(env.CQU_SESSION.idFromName(userId));
    await seedSession(sessionStub, { status: "active" });
    await seedCredentials(sessionStub);
    await runInDurableObject(sessionStub, async (_instance, state) => {
      const current = await state.storage.get<Record<string, unknown>>("state");
      await state.storage.put("state", { ...current, userId });
    });
    let keepaliveCalls = 0;
    let keepaliveBody: Record<string, unknown> | null = null;
    spyBrowserFetch({
      "/health": () => Response.json({
        ok: true,
        bootId: "manual-refresh-boot",
        browserProfile: "cloudflare",
        capabilities: ["browser-route-v1", "operation-deadline-v1"],
      }),
      "/code-permit": () => Response.json({ ok: true }),
      "/run": () => Response.json({ ok: true, state: exportableStorageState() }),
      "/keepalive": async (request) => {
        keepaliveCalls += 1;
        keepaliveBody = await request.json<Record<string, unknown>>();
        return Response.json({
          ok: true,
          status: "alive",
          state: exportableStorageState("-manual-refresh"),
        });
      },
    });
    const devices = new QuickloginDeviceClient(env);
    await devices.notifyDevice(authority);
    const stub = env.CQU_QUICKLOGIN_DEVICE.get(
      env.CQU_QUICKLOGIN_DEVICE.idFromName(`${userId}:${authority.deviceId}`)
    );
    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as { alarm(): Promise<void> }).alarm();
    });
    const ready = await devices.readDeviceSession(userId, authority.deviceId);
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("session", {
        ...ready,
        state: "temporary_unavailable",
        lastKeepAliveAt: 0,
        transientFailures: 4,
        transientStartedAt: currentTime - 90 * 60_000,
        nextAttemptAt: currentTime + 2 * 60 * 60_000,
      });
    });

    await devices.requestDeviceRefresh(authority);

    await expect(devices.readDeviceSession(userId, authority.deviceId))
      .resolves.toMatchObject({
        state: "refreshing",
        nextAttemptAt: null,
      });
    currentTime += 1;
    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as { alarm(): Promise<void> }).alarm();
    });
    expect(keepaliveCalls).toBe(1);
    expect(keepaliveBody).toMatchObject({
      operationTimeoutMs: 190_000,
    });
    await expect(devices.readDeviceSession(userId, authority.deviceId))
      .resolves.toMatchObject({
        state: "ready",
        transientFailures: 0,
        transientStartedAt: null,
        nextAttemptAt: null,
      });
  });

  it("wakes a persisted retry that exceeds the current backoff cap", async () => {
    const currentTime = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(currentTime);
    const { userId, authority } = await setupDevice();
    const devices = new QuickloginDeviceClient(env);
    await devices.notifyDevice(authority);
    const before = await devices.readDeviceSession(userId, authority.deviceId);
    const stub = env.CQU_QUICKLOGIN_DEVICE.get(
      env.CQU_QUICKLOGIN_DEVICE.idFromName(`${userId}:${authority.deviceId}`)
    );
    const legacyRetryAt = currentTime + 2 * 60 * 60_000;
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("session", {
        ...before,
        state: "temporary_unavailable",
        transientFailures: 4,
        transientStartedAt: currentTime - 90 * 60_000,
        nextAttemptAt: legacyRetryAt,
      });
      await state.storage.setAlarm(legacyRetryAt);
    });

    await expect(devices.readDeviceSession(userId, authority.deviceId))
      .resolves.toMatchObject({
        state: "temporary_unavailable",
        nextAttemptAt: null,
      });
    await expect(
      runInDurableObject(stub, async (_instance, state) => state.storage.getAlarm())
    ).resolves.toBe(currentTime);
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
