import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuickloginAccountClient } from "../../src/services/quicklogin/account-client";
import { QuickloginDeviceClient } from "../../src/services/quicklogin/device-client";
import { QuickloginLoginBrokerClient } from "../../src/services/quicklogin/login-broker-client";
import { readStorage, seedCredentials, seedSession, spyBrowserFetch, validStorageState } from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

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

function largeExportableStorageState(marker: string) {
  const state = exportableStorageState(marker);
  return {
    ...state,
    origins: [{
      origin: "https://sso.cqu.edu.cn",
      localStorage: [{
        name: "quicklogin-test-padding",
        value: `${marker}:${"x".repeat(70 * 1024)}`,
      }],
    }],
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
  it("does not restore temporary_unavailable after a delayed keepalive failure disables the device", async () => {
    const { userId, authority } = await setupDevice();
    const devices = new QuickloginDeviceClient(env);
    await devices.notifyDevice(authority);
    const stub = env.CQU_QUICKLOGIN_DEVICE.get(
      env.CQU_QUICKLOGIN_DEVICE.idFromName(`${userId}:${authority.deviceId}`)
    );
    const session = {
      ...(await devices.readDeviceSession(userId, authority.deviceId)),
      state: "ready" as const,
      storageState: JSON.stringify(exportableStorageState("transient-race")),
    };
    await runInDurableObject(stub, async (_instance, state) => state.storage.put("session", session));
    let release!: () => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    spyBrowserFetch({
      "/keepalive": async () => {
        started();
        await hold;
        return Response.json({ ok: false, status: "unreachable" }, { status: 503 });
      },
    });

    await runInDurableObject(stub, async (instance) => {
      const internal = instance as unknown as {
        performKeepalive(value: typeof session, input: typeof authority): Promise<void>;
        notify(input: typeof authority): Promise<void>;
      };
      const keepalive = internal.performKeepalive(session, authority);
      await began;
      await internal.notify({
        ...authority,
        generation: authority.generation + 1,
        enabled: false,
        allowed: false,
        reason: "DEVICE_DISABLED",
      });
      release();
      await keepalive;
    });

    expect(await readStorage<Record<string, unknown>>(stub, "session"))
      .toMatchObject({ state: "disabled", storageState: null, generation: authority.generation + 1 });
    await expect(runInDurableObject(stub, async (_instance, state) => state.storage.getAlarm()))
      .resolves.toBeNull();
  });

  it("does not restore temporary_unavailable after a delayed login failure revokes the device", async () => {
    const { userId, authority } = await setupDevice();
    const devices = new QuickloginDeviceClient(env);
    await devices.notifyDevice(authority);
    const stub = env.CQU_QUICKLOGIN_DEVICE.get(
      env.CQU_QUICKLOGIN_DEVICE.idFromName(`${userId}:${authority.deviceId}`)
    );
    const session = await devices.readDeviceSession(userId, authority.deviceId);
    let release!: () => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(QuickloginLoginBrokerClient.prototype, "quickloginLogin")
      .mockImplementation(async () => {
        started();
        await hold;
        return { kind: "temporary_unavailable", retryAfterMs: 60_000 };
      });

    await runInDurableObject(stub, async (instance) => {
      const internal = instance as unknown as {
        performLogin(value: typeof session, input: typeof authority): Promise<void>;
        notify(input: typeof authority): Promise<void>;
      };
      const login = internal.performLogin(session, authority);
      await began;
      await internal.notify({
        ...authority,
        generation: authority.generation + 1,
        enabled: false,
        allowed: false,
        reason: "DEVICE_REVOKED",
      });
      release();
      await login;
    });

    expect(await readStorage<Record<string, unknown>>(stub, "session"))
      .toMatchObject({ state: "revoked", storageState: null, generation: authority.generation + 1 });
    await expect(runInDurableObject(stub, async (_instance, state) => state.storage.getAlarm()))
      .resolves.toBeNull();
  });

  it("does not restore a disabled session after a delayed keepalive confirmation", async () => {
    const { userId, authority } = await setupDevice();
    const devices = new QuickloginDeviceClient(env);
    await devices.notifyDevice(authority);
    const stub = env.CQU_QUICKLOGIN_DEVICE.get(
      env.CQU_QUICKLOGIN_DEVICE.idFromName(`${userId}:${authority.deviceId}`)
    );
    const session = await devices.readDeviceSession(userId, authority.deviceId);
    const pending = {
      ...session,
      state: "ready" as const,
      pendingKeepaliveMint: {
        operationId: "delayed-keepalive",
        mintedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        hasStorageState: true,
      },
    };
    await runInDurableObject(stub, async (_instance, state) => state.storage.put({
      session: pending,
      pendingKeepaliveState: JSON.stringify(exportableStorageState("delayed")),
    }));
    let release!: () => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(QuickloginLoginBrokerClient.prototype, "recordQuickloginKeepaliveMint")
      .mockImplementation(async () => { started(); await hold; });

    await runInDurableObject(stub, async (instance) => {
      const internal = instance as unknown as {
        confirmKeepaliveMint(value: typeof pending, input: typeof authority): Promise<void>;
        notify(input: typeof authority): Promise<void>;
      };
      const confirming = internal.confirmKeepaliveMint(pending, authority);
      await began;
      await internal.notify({
        ...authority,
        generation: authority.generation + 1,
        enabled: false,
        allowed: false,
        reason: "DEVICE_DISABLED",
      });
      release();
      await confirming;
    });

    expect(await readStorage<Record<string, unknown>>(stub, "session"))
      .toMatchObject({ state: "disabled", storageState: null, generation: authority.generation + 1 });
    expect(await readStorage(stub, "pendingKeepaliveState")).toBeUndefined();
  });

  it("does not restore a revoked session when login digest completes late", async () => {
    const { userId, authority } = await setupDevice();
    const devices = new QuickloginDeviceClient(env);
    await devices.notifyDevice(authority);
    const stub = env.CQU_QUICKLOGIN_DEVICE.get(
      env.CQU_QUICKLOGIN_DEVICE.idFromName(`${userId}:${authority.deviceId}`)
    );
    const session = await devices.readDeviceSession(userId, authority.deviceId);
    vi.spyOn(QuickloginLoginBrokerClient.prototype, "quickloginLogin")
      .mockResolvedValue({
        kind: "success",
        bindingEpoch: 3,
        storageState: JSON.stringify(exportableStorageState("late-login")),
        loginAt: Date.now(),
      });
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    let release!: () => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
      started();
      await hold;
      return originalDigest(...args);
    });

    await runInDurableObject(stub, async (instance) => {
      const internal = instance as unknown as {
        performLogin(value: typeof session, input: typeof authority): Promise<void>;
        notify(input: typeof authority): Promise<void>;
      };
      const login = internal.performLogin(session, authority);
      await began;
      await internal.notify({
        ...authority,
        generation: authority.generation + 1,
        enabled: false,
        allowed: false,
        reason: "DEVICE_REVOKED",
      });
      release();
      await login;
    });

    expect(await readStorage<Record<string, unknown>>(stub, "session"))
      .toMatchObject({ state: "revoked", storageState: null, generation: authority.generation + 1 });
  });

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

  it("reuses a pending keepalive mint operation after the broker response is lost", async () => {
    const { userId, authority } = await setupDevice();
    const sessionStub = env.CQU_SESSION.get(env.CQU_SESSION.idFromName(userId));
    await seedSession(sessionStub, { status: "active" });
    await seedCredentials(sessionStub);
    await runInDurableObject(sessionStub, async (_instance, state) => {
      const current = await state.storage.get<Record<string, unknown>>("state");
      await state.storage.put("state", { ...current, userId });
    });
    let keepaliveCalls = 0;
    spyBrowserFetch({
      "/health": () => Response.json({
        ok: true,
        bootId: "lost-response-boot",
        browserProfile: "cloudflare",
        capabilities: ["browser-route-v1", "operation-deadline-v1"],
      }),
      "/code-permit": () => Response.json({ ok: true }),
      "/run": () => Response.json({
        ok: true,
        state: largeExportableStorageState("initial"),
      }),
      "/keepalive": () => {
        keepaliveCalls += 1;
        return Response.json({
          ok: true,
          status: "alive",
          state: largeExportableStorageState("pending"),
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
      await state.storage.put("session", { ...ready, lastKeepAliveAt: 0 });
    });

    let loseFirstResponse = true;
    const operationIds: string[] = [];
    vi.spyOn(env.CQU_SESSION, "get").mockReturnValue({
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request
          ? input
          : new Request(input as string | URL, init);
        if (new URL(request.url).pathname === "/quicklogin-keepalive-mint") {
          const body = await request.clone().json<{ operationId: string }>();
          operationIds.push(body.operationId);
          if (loseFirstResponse) {
            loseFirstResponse = false;
            throw new Error("broker response lost");
          }
          return Response.json({ success: true });
        }
        throw new Error(`unexpected CQU_SESSION path: ${new URL(request.url).pathname}`);
      },
    } as never);

    await expect(
      runInDurableObject(stub, async (instance) => {
        await (instance as unknown as { alarm(): Promise<void> }).alarm();
      })
    ).rejects.toThrow("broker response lost");
    const pending = await readStorage<Record<string, unknown>>(stub, "session");
    expect(pending?.pendingKeepaliveMint).toMatchObject({
      operationId: expect.any(String),
    });
    expect(JSON.stringify(pending).length).toBeLessThan(120 * 1024);
    expect(
      (await readStorage<string>(stub, "pendingKeepaliveState"))?.length
    ).toBeGreaterThan(64 * 1024);

    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as { alarm(): Promise<void> }).alarm();
    });

    expect(keepaliveCalls).toBe(1);
    expect(operationIds).toHaveLength(2);
    expect(operationIds[1]).toBe(operationIds[0]);
    expect(await readStorage<Record<string, unknown>>(stub, "session"))
      .not.toHaveProperty("pendingKeepaliveMint");
    expect(await readStorage(stub, "pendingKeepaliveState")).toBeUndefined();
  });

  it("clears an independent pending keepalive payload when authority changes", async () => {
    const { userId, authority } = await setupDevice();
    const devices = new QuickloginDeviceClient(env);
    await devices.notifyDevice(authority);
    const stub = env.CQU_QUICKLOGIN_DEVICE.get(
      env.CQU_QUICKLOGIN_DEVICE.idFromName(`${userId}:${authority.deviceId}`)
    );
    const session = await devices.readDeviceSession(userId, authority.deviceId);
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put({
        session: {
          ...session,
          pendingKeepaliveMint: {
            operationId: "pending-before-disable",
            mintedAt: Date.now(),
            expiresAt: Date.now() + 60_000,
            hasStorageState: true,
          },
        },
        pendingKeepaliveState: JSON.stringify(exportableStorageState("stale")),
      });
    });

    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as {
        notify(input: typeof authority): Promise<void>;
      }).notify({
        ...authority,
        generation: authority.generation + 1,
        enabled: false,
        allowed: false,
        reason: "DEVICE_DISABLED",
      });
    });

    expect(await readStorage<Record<string, unknown>>(stub, "session"))
      .not.toHaveProperty("pendingKeepaliveMint");
    expect(await readStorage(stub, "pendingKeepaliveState")).toBeUndefined();
  });

  it("recovers an expired pending keepalive payload on read", async () => {
    const currentTime = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(currentTime);
    const { userId, authority } = await setupDevice();
    const devices = new QuickloginDeviceClient(env);
    await devices.notifyDevice(authority);
    const stub = env.CQU_QUICKLOGIN_DEVICE.get(
      env.CQU_QUICKLOGIN_DEVICE.idFromName(`${userId}:${authority.deviceId}`)
    );
    const session = await devices.readDeviceSession(userId, authority.deviceId);
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put({
        session: {
          ...session,
          pendingKeepaliveMint: {
            operationId: "expired-pending",
            mintedAt: currentTime - 60_000,
            expiresAt: currentTime - 1,
            hasStorageState: true,
          },
        },
        pendingKeepaliveState: JSON.stringify(exportableStorageState("expired")),
      });
    });

    await expect(devices.readDeviceSession(userId, authority.deviceId))
      .resolves.not.toHaveProperty("pendingKeepaliveMint");
    expect(await readStorage(stub, "pendingKeepaliveState")).toBeUndefined();
  });

  it("clears pending keepalive data on a mode-off alarm without deleting the live session", async () => {
    const userId = `mode-off-${crypto.randomUUID()}`;
    const deviceId = "device-mode-off";
    const stub = env.CQU_QUICKLOGIN_DEVICE.get(
      env.CQU_QUICKLOGIN_DEVICE.idFromName(`${userId}:${deviceId}`)
    );
    const storageState = JSON.stringify(exportableStorageState("live"));
    const session = {
      schemaVersion: 1 as const,
      ownerUserId: userId,
      deviceId,
      generation: 4,
      bindingEpoch: 2,
      sessionVersion: 3,
      state: "ready" as const,
      loginAt: Date.now(),
      lastKeepAliveAt: Date.now(),
      storageState,
      exportDigest: "live-digest",
      transientFailures: 0,
      transientStartedAt: null,
      fastRetries: 0,
      nextAttemptAt: null,
      pendingKeepaliveMint: {
        operationId: "pending-before-mode-off",
        mintedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        hasStorageState: true,
      },
    };
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put({
        session,
        pendingKeepaliveState: JSON.stringify(
          largeExportableStorageState("mode-off-pending")
        ),
      });
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    expect(await readStorage<Record<string, unknown>>(stub, "session"))
      .toMatchObject({ storageState });
    const originalMode = env.QUICKLOGIN_DEVICE_MODE;
    env.QUICKLOGIN_DEVICE_MODE = "off";
    try {
      await runInDurableObject(stub, async (instance) => {
        await (instance as unknown as { alarm(): Promise<void> }).alarm();
      });
    } finally {
      env.QUICKLOGIN_DEVICE_MODE = originalMode;
    }

    expect(await readStorage<Record<string, unknown>>(stub, "session"))
      .toMatchObject({ storageState });
    expect(await readStorage<Record<string, unknown>>(stub, "session"))
      .not.toHaveProperty("pendingKeepaliveMint");
    expect(await readStorage(stub, "pendingKeepaliveState")).toBeUndefined();
    await expect(
      runInDurableObject(stub, async (_instance, state) => state.storage.getAlarm())
    ).resolves.toBeNull();
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
