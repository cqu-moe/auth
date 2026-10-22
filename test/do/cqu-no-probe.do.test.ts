import { env, reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CQU_PROACTIVE_RELOGIN_MS } from "../../src/services/cqu-maintenance-policy";
import {
  captureSetAlarm, driveAlarm, freshStub, readAlarm, readState, readStorage,
  seedCredentials, seedSession, spyBrowserFetch,
} from "./helpers";

afterEach(async () => {
  await reset();
  vi.restoreAllMocks();
  delete env.CQU_NO_PROBE_EXPERIMENT_USER_ID;
  delete env.CQU_NO_PROBE_EXPERIMENT_DEVICE_ID;
});

describe("account no-probe experiment", () => {
  it("skips an old hourly alarm without changing validation evidence and renews at seven hours", async () => {
    env.CQU_NO_PROBE_EXPERIMENT_USER_ID = "u1";
    const stub = freshStub();
    const loginAt = Date.now() - 3 * 60 * 60_000;
    await seedSession(stub, { loginAt });
    const before = await readState(stub);
    const browser = spyBrowserFetch({});

    await driveAlarm(stub);

    expect(browser).not.toHaveBeenCalled();
    expect(await readState(stub)).toEqual(before);
    expect(await readAlarm(stub)).toBe(loginAt + CQU_PROACTIVE_RELOGIN_MS);
  });

  it("keeps hourly probes for another account", async () => {
    env.CQU_NO_PROBE_EXPERIMENT_USER_ID = "someone-else";
    const stub = freshStub();
    await seedSession(stub);
    const browser = spyBrowserFetch({
      "/keepalive": () => Response.json({ ok: true, status: "alive" }),
    });

    await driveAlarm(stub);

    expect(browser).toHaveBeenCalledOnce();
    expect(new URL(browser.mock.calls[0][0].url).pathname).toBe("/keepalive");
  });

  it("preserves an earlier QuickLogin OTP deadline while skipping account probes", async () => {
    env.CQU_NO_PROBE_EXPERIMENT_USER_ID = "u1";
    const stub = freshStub();
    const deadlineAt = Date.now() + 10 * 60_000;
    const lock = { token: "waiting-otp", deviceId: "device-a", generation: 1,
      bindingEpoch: 1, startedAt: Date.now(), deadlineAt, browserRouteVersion: 1 };
    await seedSession(stub, { extra: { "quickloginLogin:device-a": lock } });
    const browser = spyBrowserFetch({});

    await driveAlarm(stub);

    expect(browser).not.toHaveBeenCalled();
    expect(await readStorage(stub, "quickloginLogin:device-a")).toEqual(lock);
    expect(await readAlarm(stub)).toBe(deadlineAt);
  });

  it("still starts a real login at the seven-hour boundary", async () => {
    env.CQU_NO_PROBE_EXPERIMENT_USER_ID = "u1";
    const stub = freshStub();
    await seedSession(stub, { loginAt: Date.now() - CQU_PROACTIVE_RELOGIN_MS });
    await seedCredentials(stub);
    const paths: string[] = [];
    const record = (path: string, body: unknown) => () => {
      paths.push(path);
      return Response.json(body);
    };
    spyBrowserFetch({
      "/health": record("/health", { ok: true, bootId: "test-boot", browserProfile: "cloudflare",
        capabilities: ["browser-route-v1", "operation-deadline-v1"] }),
      "/run": record("/run", { ok: false, error: "code wait timed out" }),
      "/code-permit": record("/code-permit", { ok: true }),
      "/login-cancel": record("/login-cancel", { ok: true, stopped: true, mayHaveRequestedCode: false }),
    });

    await driveAlarm(stub);

    expect(paths).toContain("/run");
    expect(paths).not.toContain("/keepalive");
    expect(await readAlarm(stub)).toBeGreaterThan(Date.now());
  });

  it("still invalidates an expired ticket session and schedules immediate recovery", async () => {
    env.CQU_NO_PROBE_EXPERIMENT_USER_ID = "u1";
    const stub = freshStub();
    await seedSession(stub);
    const alarms = await captureSetAlarm(stub);
    spyBrowserFetch({
      "/service-ticket": () => Response.json({ ok: false, error: "cas-login" }, { status: 409 }),
    });

    const response = await stub.fetch("http://do/service-ticket?service=jwxt&source=route", { method: "POST" });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "TGT_EXPIRED" });
    expect(await readState(stub)).toMatchObject({ confirmedExpiredAt: expect.any(Number) });
    expect(alarms.some(at => at <= Date.now() + 1_000)).toBe(true);
  });
});
