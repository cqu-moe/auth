import {
  abortAllDurableObjects,
  env,
  reset,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CQU_PROACTIVE_RELOGIN_MS } from "../../src/services/cqu-maintenance-policy";
import {
  driveAlarm,
  freshStub,
  readAlarm,
  readState,
  readStorage,
  seedCredentials,
  seedSession,
  spyBrowserFetch,
  validStorageState,
} from "./helpers";

type StoredSession = {
  loginAt: number;
  reloginAt?: number;
  [key: string]: unknown;
};

async function persistReloginAt(
  stub: DurableObjectStub,
  reloginAt: number
): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    const stored = await state.storage.get<StoredSession>("state");
    await state.storage.put("state", { ...stored, reloginAt });
  });
}

async function restartDurableObject(stub: DurableObjectStub) {
  const id = stub.id;
  await abortAllDurableObjects();
  return env.CQU_SESSION.get(id);
}

afterEach(async () => {
  await reset();
  vi.restoreAllMocks();
});

describe("account maintenance without periodic probes", () => {
  it("makes no school call before the persisted relogin deadline", async () => {
    const stub = freshStub("before-relogin");
    const loginAt = Date.now() - 3 * 60 * 60_000;
    const reloginAt = loginAt + 5 * 60 * 60_000;
    await seedSession(stub, { loginAt });
    await persistReloginAt(stub, reloginAt);
    const before = await readStorage<StoredSession>(stub, "state");
    const browser = spyBrowserFetch({});

    await driveAlarm(stub);

    expect(browser).not.toHaveBeenCalled();
    expect(await readStorage<StoredSession>(stub, "state")).toEqual(before);
    expect(await readAlarm(stub)).toBe(reloginAt);
  });

  it("migrates a legacy session once and keeps the drawn deadline after recreation", async () => {
    const stub = freshStub("relogin-migration");
    const loginAt = Date.now() - 3 * 60 * 60_000;
    await seedSession(stub, { loginAt });
    await runInDurableObject(stub, async (_instance, state) => {
      const legacy = (await state.storage.get<StoredSession>("state"))!;
      delete legacy.reloginAt;
      await state.storage.put("state", legacy);
    });
    const browser = spyBrowserFetch({});

    await driveAlarm(stub);

    const migrated = await readStorage<StoredSession>(stub, "state");
    expect(migrated?.reloginAt).toBeGreaterThanOrEqual(
      loginAt + 4 * 60 * 60_000
    );
    expect(migrated?.reloginAt).toBeLessThan(
      loginAt + 7 * 60 * 60_000
    );
    expect(browser).not.toHaveBeenCalled();
    expect(await readAlarm(stub)).toBe(migrated?.reloginAt);

    const restarted = await restartDurableObject(stub);
    await driveAlarm(restarted);

    expect(browser).not.toHaveBeenCalled();
    expect(await readStorage<StoredSession>(restarted, "state")).toEqual(
      migrated
    );
    expect(await readAlarm(restarted)).toBe(migrated?.reloginAt);
  });

  it("preserves an earlier QuickLogin OTP deadline", async () => {
    const stub = freshStub("quicklogin-deadline");
    const loginAt = Date.now() - 3 * 60 * 60_000;
    const deadlineAt = Date.now() + 10 * 60_000;
    const lock = {
      token: "waiting-otp",
      deviceId: "device-a",
      generation: 1,
      bindingEpoch: 1,
      startedAt: Date.now(),
      deadlineAt,
      browserRouteVersion: 1,
    };
    await seedSession(stub, {
      loginAt,
      extra: { "quickloginLogin:device-a": lock },
    });
    await persistReloginAt(stub, loginAt + 5 * 60 * 60_000);
    const browser = spyBrowserFetch({});

    await driveAlarm(stub);

    expect(browser).not.toHaveBeenCalled();
    expect(await readStorage(stub, "quickloginLogin:device-a")).toEqual(lock);
    expect(await readAlarm(stub)).toBe(deadlineAt);
  });

  it("keeps a due CAS OTP wait open instead of closing it from another alarm", async () => {
    const stub = freshStub("pending-cas-otp");
    const loginAt = Date.now() - CQU_PROACTIVE_RELOGIN_MS - 1_000;
    const deadlineAt = Date.now() + 10 * 60_000;
    const lock = {
      token: "waiting-cas-otp",
      startedAt: Date.now(),
      deadlineAt,
      browserRouteVersion: 1,
    };
    await seedSession(stub, {
      loginAt,
      extra: {
        loginInFlight: lock,
        codeLease: { ownerToken: lock.token, ownerKind: "cas", acquiredAt: Date.now(), queue: [] },
        codePermitProven: lock.token,
      },
    });
    await persistReloginAt(stub, loginAt + CQU_PROACTIVE_RELOGIN_MS);
    const browser = spyBrowserFetch({});

    await driveAlarm(stub);

    expect(browser).not.toHaveBeenCalled();
    expect(await readStorage(stub, "loginInFlight")).toEqual(lock);
    expect(await readStorage(stub, "codePermitProven")).toBe(lock.token);
    expect(await readAlarm(stub)).toBe(deadlineAt);
  });

  it("starts a due relogin with the OTP permit and persists its retry", async () => {
    const stub = freshStub("due-relogin-retry");
    const loginAt = Date.now() - CQU_PROACTIVE_RELOGIN_MS - 1_000;
    await seedSession(stub, { loginAt });
    await persistReloginAt(stub, loginAt + CQU_PROACTIVE_RELOGIN_MS);
    await seedCredentials(stub);
    const paths: string[] = [];
    const record = (path: string, body: unknown) => () => {
      paths.push(path);
      return Response.json(body);
    };
    spyBrowserFetch({
      "/health": record("/health", {
        ok: true,
        bootId: "test-boot",
        browserProfile: "cloudflare",
        capabilities: ["browser-route-v1", "operation-deadline-v1"],
      }),
      "/code-permit": record("/code-permit", { ok: true }),
      "/run": record("/run", { ok: false, error: "code wait timed out" }),
      "/login-cancel": record("/login-cancel", {
        ok: true,
        stopped: true,
        mayHaveRequestedCode: false,
      }),
    });

    await driveAlarm(stub);

    expect(paths).toContain("/run");
    expect(paths).not.toContain("/keepalive");
    expect(paths.indexOf("/code-permit")).toBeLessThan(paths.indexOf("/run"));
    expect(await readState(stub)).toMatchObject({
      storageState: validStorageState(),
    });
    expect(await readStorage(stub, "reloginFailures")).toBe(1);
    const retryAt = await readStorage<number>(stub, "reloginRetryAt");
    expect(retryAt).toBeGreaterThan(Date.now());
    expect(await readAlarm(stub)).toBeGreaterThan(Date.now());
    // A still-earlier cleanup alarm may run first, but cannot bypass login backoff.
    const attempts = paths.filter(path => path === "/run").length;
    await driveAlarm(stub);
    expect(paths.filter(path => path === "/run")).toHaveLength(attempts);
    expect(await readStorage(stub, "reloginRetryAt")).toBe(retryAt);
  });

  it("recovers a business-expired session with a real relogin", async () => {
    const stub = freshStub("business-expiry-relogin");
    await seedSession(stub);
    await seedCredentials(stub);
    const recovered = validStorageState();
    recovered.cookies[0].value = "recovered-tgt";
    const paths: string[] = [];
    const record = (path: string, body: unknown) => () => {
      paths.push(path);
      return Response.json(body);
    };
    spyBrowserFetch({
      "/service-ticket": () => {
        paths.push("/service-ticket");
        return Response.json({ ok: false, error: "cas-login" }, { status: 409 });
      },
      "/health": record("/health", {
        ok: true,
        bootId: "test-boot",
        browserProfile: "cloudflare",
        capabilities: ["browser-route-v1", "operation-deadline-v1"],
      }),
      "/code-permit": record("/code-permit", { ok: true }),
      "/run": record("/run", { ok: true, state: recovered }),
    });

    const response = await stub.fetch(
      "http://do/service-ticket?service=jwxt&source=route",
      { method: "POST" }
    );
    await driveAlarm(stub);

    expect(response.status).toBe(409);
    expect(paths).toEqual(
      expect.arrayContaining(["/service-ticket", "/code-permit", "/run"])
    );
    expect(paths).not.toContain("/keepalive");
    expect(await readState(stub)).toMatchObject({ storageState: recovered });
  });
});
