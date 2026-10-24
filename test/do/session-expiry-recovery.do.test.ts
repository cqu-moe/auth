import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { freshStub, seedSession, seedCredentials, spyBrowserFetch, validStorageState } from "./helpers";

afterEach(() => vi.restoreAllMocks());

const recipe = {
  navUrl: "https://my.cqu.edu.cn/workspace/curriculum",
  capture: ["student/my-table-detail"],
  fetch: [],
};
type SessionTarget = {
  loadState(): Promise<void>;
  relogin(): Promise<void>;
  alarm(): Promise<void>;
  dataHarvest(args: { recipe: typeof recipe; clientId: string; source: string }): Promise<unknown>;
  getServiceTicket(args: { service: string }): Promise<string>;
  quickloginLogin(args: { ownerUserId: string; deviceId: string; generation: number; seedState: string }): Promise<{ kind: string; storageState?: string }>;
};

describe("confirmed CAS expiry recovery", () => {
  it("ordinary CAS login retains WAF and origin seed without authentication cookies", async () => {
    const stub = freshStub("cas-fresh-seed");
    const seed = validStorageState();
    const wafCookie = { name: "waf80S", value: "waf-proof", domain: "sso.cqu.edu.cn", path: "/" };
    seed.cookies.push(wafCookie, { ...seed.cookies[0], domain: ".cqu.edu.cn" });
    seed.origins = [{ origin: "https://sso.cqu.edu.cn", localStorage: [{ name: "browser-proof", value: "origin-seed" }] }];
    await seedSession(stub, { storageState: seed });
    await seedCredentials(stub);
    await runInDurableObject(stub, async (instance) => {
      let sentSeed: unknown;
      spyBrowserFetch({
        "/health": () => Response.json({ ok: true, bootId: "boot-1", browserProfile: "cloudflare", capabilities: ["browser-route-v1", "operation-deadline-v1"] }),
        "/code-permit": () => Response.json({ ok: true }),
        "/run": async (request) => {
          sentSeed = (await request.json<{ seedState: unknown }>()).seedState;
          return Response.json({ ok: false, errorCode: "WAF_CHALLENGE" });
        },
        "/login-cancel": () => Response.json({ ok: true, stopped: true, mayHaveRequestedCode: false }),
      });
      const target = instance as unknown as SessionTarget;
      await target.loadState();
      await target.relogin();
      expect(sentSeed).toEqual({ cookies: [wafCookie], origins: seed.origins });
      expect(seed.cookies).toHaveLength(5);
    });
  });

  it.each(["active", "expired"])("same TGT cannot renew an %s CAS session and releases a completed run", async (status) => {
    const stub = freshStub("cas-unchanged-tgt");
    const oldLoginAt = Date.now() - 7 * 60 * 60_000;
    await seedSession(stub, { status, loginAt: oldLoginAt });
    await seedCredentials(stub);
    await runInDurableObject(stub, async (instance, ctx) => {
      const warnings = vi.spyOn(console, "warn");
      spyBrowserFetch({
        "/health": () => Response.json({ ok: true, bootId: "boot-1", browserProfile: "cloudflare", capabilities: ["browser-route-v1", "operation-deadline-v1"] }),
        "/code-permit": () => Response.json({ ok: true }),
        "/run": () => Response.json({ ok: true, state: validStorageState() }),
      });
      const target = instance as unknown as SessionTarget;
      await target.loadState();
      await target.relogin();
      expect(await ctx.storage.get("state")).toMatchObject({ loginAt: oldLoginAt });
      expect(await ctx.storage.get("status")).toBe(status);
      expect(await ctx.storage.get("reloginFailures")).toBe(1);
      expect(await ctx.storage.get<number>("reloginRetryAt")).toBeGreaterThan(Date.now());
      expect(await ctx.storage.get("credentialFailures")).toBeUndefined();
      expect(await ctx.storage.get("loginInFlight")).toBeUndefined();
      expect(await ctx.storage.get("interruptedLogins")).toBeUndefined();
      expect(await ctx.storage.get("codeLease")).toBeUndefined();
      expect(JSON.stringify(warnings.mock.calls)).not.toContain("new TGT minted");
    });
  });

  it("a new CAS TGT advances login age after a successful ordinary login", async () => {
    const stub = freshStub("cas-new-tgt");
    const oldLoginAt = Date.now() - 7 * 60 * 60_000;
    await seedSession(stub, { loginAt: oldLoginAt });
    await seedCredentials(stub);
    await runInDurableObject(stub, async (instance, ctx) => {
      const fresh = validStorageState();
      fresh.cookies[0].value = "new-tgt";
      spyBrowserFetch({
        "/health": () => Response.json({ ok: true, bootId: "boot-1", browserProfile: "cloudflare", capabilities: ["browser-route-v1", "operation-deadline-v1"] }),
        "/code-permit": () => Response.json({ ok: true }),
        "/run": () => Response.json({ ok: true, state: fresh }),
      });
      const target = instance as unknown as SessionTarget;
      await target.loadState();
      await target.relogin();
      expect(await ctx.storage.get("status")).toBe("active");
      expect(await ctx.storage.get("state")).toMatchObject({ storageState: fresh });
      expect((await ctx.storage.get<{ loginAt: number }>("state"))!.loginAt).toBeGreaterThan(oldLoginAt);
      expect(await ctx.storage.get("reloginRetryAt")).toBeUndefined();
    });
  });

  it("QuickLogin keeps the full seed and may successfully reuse its TGT", async () => {
    const stub = freshStub("quicklogin-reuse-tgt");
    await seedSession(stub);
    await seedCredentials(stub);
    await runInDurableObject(stub, async (instance, ctx) => {
      const previous = await ctx.storage.get("state");
      const seed = validStorageState();
      let sentSeed: unknown;
      spyBrowserFetch({
        "/health": () => Response.json({ ok: true, bootId: "boot-1", browserProfile: "cloudflare", capabilities: ["browser-route-v1", "operation-deadline-v1"] }),
        "/code-permit": () => Response.json({ ok: true }),
        "/run": async (request) => {
          sentSeed = (await request.json<{ seedState: unknown }>()).seedState;
          return Response.json({ ok: true, state: seed });
        },
      });
      const result = await (instance as unknown as SessionTarget).quickloginLogin({ ownerUserId: "u1", deviceId: "reuse-device", generation: 1, seedState: JSON.stringify(seed) });
      expect(result.kind).toBe("success");
      expect(sentSeed).toEqual(seed);
      expect(JSON.parse(result.storageState!)).toEqual(seed);
      expect(await ctx.storage.get("state")).toEqual(previous);
    });
  });

  it.each(["harvest", "ticket"])("%s expiry starts asynchronous recovery", async (operation) => {
    const stub = freshStub("confirmed-expiry");
    await seedSession(stub);
    await runInDurableObject(stub, async (instance, ctx) => {
      const original = await ctx.storage.get("state");
      spyBrowserFetch({
        "/data-harvest": () => Response.json({ ok: false, error: "TGT_EXPIRED" }, { status: 409 }),
        "/service-ticket": () => Response.json({ ok: false, error: "TGT_EXPIRED" }, { status: 409 }),
      });
      const target = instance as unknown as SessionTarget;
      const request = operation === "harvest"
        ? target.dataHarvest({ recipe, clientId: "calendar", source: "rpc" })
        : target.getServiceTicket({ service: "jwxt" });
      await expect(request).rejects.toMatchObject({ code: "TGT_EXPIRED" });
      expect(await ctx.storage.get("status")).toBe("expired");
      expect(await ctx.storage.get("sessionRecoveryCycle")).toMatchObject({ userId: "u1" });
      expect(await ctx.storage.get("state")).toMatchObject({
        storageState: (original as { storageState: unknown }).storageState,
      });
    });
  });

  it("does not declare recovery complete after a failed login for a confirmed expired session", async () => {
    const stub = freshStub("expired-transient-login");
    await seedSession(stub);
    await seedCredentials(stub);
    await runInDurableObject(stub, async (instance, ctx) => {
      const target = instance as unknown as SessionTarget;
      spyBrowserFetch({
        "/service-ticket": () => Response.json({ ok: false, error: "cas-login" }, { status: 409 }),
        "/health": () => Response.json({ ok: true, bootId: "boot-1", browserProfile: "cloudflare", capabilities: ["browser-route-v1", "operation-deadline-v1"] }),
        "/code-permit": () => Response.json({ ok: true }),
        "/run": () => Response.json({ ok: false, errorCode: "WAF_CHALLENGE" }),
        "/login-cancel": () => Response.json({ ok: true, stopped: true, mayHaveRequestedCode: false }),
      });
      await expect(target.getServiceTicket({ service: "jwxt" }))
        .rejects.toMatchObject({ code: "TGT_EXPIRED" });
      await target.alarm();
      expect(await ctx.storage.get("status")).toBe("expired");
      const cycle = await ctx.storage.get<{ id: string }>("sessionRecoveryCycle");
      expect(cycle).toBeDefined();
      const result = await (instance as unknown as {
        recoveryTick(id: string): Promise<{ state: string }>;
      }).recoveryTick(cycle!.id);
      expect(result.state).toBe("waiting");
    });
  });

  it.each([
    ["harvest", false, "expired"], ["harvest", true, "active"],
    ["ticket", false, "expired"], ["ticket", true, "active"],
  ] as const)("%s expiry during proactive login (success=%s) ends %s", async (operation, success, expectedStatus) => {
    const stub = freshStub("concurrent-expiry");
    await seedSession(stub);
    await seedCredentials(stub);
    await runInDurableObject(stub, async (instance, ctx) => {
      const target = instance as unknown as SessionTarget;
      let finishExpiredRequest!: (response: Response) => void;
      let requestStarted!: () => void;
      const started = new Promise<void>((resolve) => { requestStarted = resolve; });
      let expiredRequest: Promise<void>;
      const pendingRequest = () => new Promise<Response>((resolve) => {
        finishExpiredRequest = resolve;
        requestStarted();
      });
      const newState = validStorageState();
      newState.cookies[0].value = "new-login-tgt";
      spyBrowserFetch({
        "/data-harvest": pendingRequest,
        "/service-ticket": pendingRequest,
        "/health": () => Response.json({ ok: true, bootId: "boot-1", browserProfile: "cloudflare", capabilities: ["browser-route-v1", "operation-deadline-v1"] }),
        "/code-permit": () => Response.json({ ok: true }),
        "/run": async () => {
          finishExpiredRequest(Response.json({ ok: false, error: "TGT_EXPIRED" }, { status: 409 }));
          await expiredRequest;
          return Response.json(success
            ? { ok: true, state: newState }
            : { ok: false, errorCode: "WAF_CHALLENGE" });
        },
        "/login-cancel": () => Response.json({ ok: true, stopped: true, mayHaveRequestedCode: false }),
      });
      expiredRequest = expect(operation === "harvest"
        ? target.dataHarvest({ recipe, clientId: "calendar", source: "rpc" })
        : target.getServiceTicket({ service: "jwxt" }))
        .rejects.toMatchObject({ code: "TGT_EXPIRED" });
      await started;
      await target.relogin();
      expect(await ctx.storage.get("status")).toBe(expectedStatus);
      if (success) {
        expect(await ctx.storage.get("state")).toMatchObject({ storageState: newState });
        expect(await ctx.storage.get("state")).not.toHaveProperty("confirmedExpiredAt");
      }
    });
  });

  it.each([false, true])(
    "a real harvest refresh preserves maintenance and an earlier alarm (earlier alarm=%s)",
    async (hasEarlierAlarm) => {
      const stub = freshStub("harvest-refresh-maintenance");
      const reloginAt = Date.now() + 2 * 60 * 60_000;
      await seedSession(stub, { reloginAt });
    await runInDurableObject(stub, async (instance, ctx) => {
      const target = instance as unknown as SessionTarget;
      const refreshed = validStorageState();
      refreshed.cookies[0].value = "harvest-refreshed-tgt";
      const earlierAlarm = Date.now() + 30_000;
      spyBrowserFetch({
        "/data-harvest": () => Response.json({
          ok: true,
          state: refreshed,
          captures: [{ url: "https://my.cqu.edu.cn/student/my-table-detail", status: 200, contentType: "application/json", body: "{}" }],
          fetches: [],
        }),
      });
      await target.dataHarvest({ recipe, clientId: "calendar", source: "rpc" });
      if (hasEarlierAlarm) await ctx.storage.setAlarm(earlierAlarm);
      else await ctx.storage.deleteAlarm();
      await target.alarm();
      expect(await ctx.storage.get("status")).toBe("active");
      expect(await ctx.storage.get("state")).toMatchObject({
        storageState: refreshed,
        reloginAt,
      });
      expect(await ctx.storage.getAlarm()).toBe(
        hasEarlierAlarm ? earlierAlarm : reloginAt
      );
    });
    }
  );

  it("a successful recovery clears old expiry evidence for future proactive refreshes", async () => {
    const stub = freshStub("recovered-expiry");
    await seedSession(stub);
    await seedCredentials(stub);
    await runInDurableObject(stub, async (instance, ctx) => {
      const target = instance as unknown as SessionTarget;
      let loginSucceeds = true;
      const recovered = validStorageState();
      recovered.cookies[0].value = "recovered-tgt";
      spyBrowserFetch({
        "/data-harvest": () => Response.json({ ok: false, error: "TGT_EXPIRED" }, { status: 409 }),
        "/health": () => Response.json({ ok: true, bootId: "boot-1", browserProfile: "cloudflare", capabilities: ["browser-route-v1", "operation-deadline-v1"] }),
        "/code-permit": () => Response.json({ ok: true }),
        "/run": () => Response.json(loginSucceeds
          ? { ok: true, state: recovered }
          : { ok: false, errorCode: "WAF_CHALLENGE" }),
        "/login-cancel": () => Response.json({ ok: true, stopped: true, mayHaveRequestedCode: false }),
      });
      await expect(target.dataHarvest({ recipe, clientId: "calendar", source: "rpc" }))
        .rejects.toMatchObject({ code: "TGT_EXPIRED" });
      await target.relogin();
      expect(await ctx.storage.get("status")).toBe("active");
      expect(await ctx.storage.get("state")).not.toHaveProperty("confirmedExpiredAt");
      loginSucceeds = false;
      await target.relogin();
      expect(await ctx.storage.get("status")).toBe("active");
    });
  });

  it.each(["revoked", "unbound", "needs_reauth", "binding"])("late harvest expiry preserves %s status", async (status) => {
    const stub = freshStub("late-expiry-status");
    await seedSession(stub);
    await runInDurableObject(stub, async (instance, ctx) => {
      spyBrowserFetch({ "/data-harvest": async () => {
        await ctx.storage.put("status", status);
        return Response.json({ ok: false, error: "TGT_EXPIRED" }, { status: 409 });
      } });
      await expect((instance as unknown as SessionTarget).dataHarvest({ recipe, clientId: "calendar", source: "rpc" }))
        .rejects.toMatchObject({ code: "TGT_EXPIRED" });
      expect(await ctx.storage.get("status")).toBe(status);
      expect(await ctx.storage.get("sessionRecoveryCycle")).toBeUndefined();
    });
  });

  it.each(["harvest", "ticket"])("late %s expiry cannot invalidate a newer login", async (operation) => {
    const stub = freshStub("late-expiry");
    await seedSession(stub);
    await seedCredentials(stub);
    await runInDurableObject(stub, async (instance, ctx) => {
      let replacement: Record<string, unknown> | undefined;
      const expireOldSession = async () => {
        const original = await ctx.storage.get<Record<string, unknown>>("state");
        replacement = { ...original, loginAt: (original!.loginAt as number) + 1 };
        await ctx.storage.put("state", replacement);
        (instance as unknown as { state: Record<string, unknown> }).state = replacement;
        return Response.json({ ok: false, error: "TGT_EXPIRED" }, { status: 409 });
      };
      spyBrowserFetch({
        "/data-harvest": expireOldSession,
        "/service-ticket": expireOldSession,
        "/health": () => Response.json({ ok: true, bootId: "boot-1", browserProfile: "cloudflare", capabilities: ["browser-route-v1", "operation-deadline-v1"] }),
        "/code-permit": () => Response.json({ ok: true }),
        "/run": () => Response.json({ ok: false, errorCode: "WAF_CHALLENGE" }),
        "/login-cancel": () => Response.json({ ok: true, stopped: true, mayHaveRequestedCode: false }),
      });
      const target = instance as unknown as SessionTarget;
      await expect(operation === "harvest"
        ? target.dataHarvest({ recipe, clientId: "calendar", source: "rpc" })
        : target.getServiceTicket({ service: "jwxt" })).rejects.toMatchObject({ code: "TGT_EXPIRED" });
      expect(await ctx.storage.get("status")).toBe("active");
      expect(await ctx.storage.get("state")).toEqual(replacement);
      expect(await ctx.storage.get("reloginAttempts")).toBeUndefined();
    });
  });
});
