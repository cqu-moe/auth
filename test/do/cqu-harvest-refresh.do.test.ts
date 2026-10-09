import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CquStorageState } from "../../src/services/cqu-sso";
import { freshStub, readState, seedSession, spyBrowserFetch, validStorageState } from "./helpers";

afterEach(() => vi.restoreAllMocks());

const recipe = {
  navUrl: "https://my.cqu.edu.cn/workspace/curriculum",
  capture: ["student/my-table-detail"],
  fetch: [{ method: "GET", url: "https://my.cqu.edu.cn/api/exam/x" }],
};
const data = {
  captures: [{ url: "https://my.cqu.edu.cn/api/student/my-table-detail", status: 200, contentType: "application/json", body: "{}" }],
  fetches: [{ url: "https://my.cqu.edu.cn/api/exam/x", status: 200, body: "[]" }],
};
function refreshedState(): CquStorageState {
  const state = validStorageState();
  state.cookies[0].value = "refreshed-tgt";
  state.origins = [{ origin: "https://my.cqu.edu.cn", localStorage: [{ name: "some-key", value: "refreshed-local" }] }];
  return state;
}
function postHarvest(stub: DurableObjectStub) {
  return stub.fetch("http://do/data-harvest?clientId=calendar&source=rpc", { method: "POST", body: JSON.stringify(recipe) });
}
type StoredState = { storageState: CquStorageState | null; loginAt: number; lastKeepAlive: number; [key: string]: unknown };
type HarvestTarget = {
  state: StoredState;
  dataHarvest: (arg: { recipe: typeof recipe; clientId: string; source: string }) => Promise<typeof data>;
};

describe("harvest refreshed storage state", () => {
  it("persists a valid refresh atomically and returns only course data", async () => {
    const stub = freshStub("refresh-valid");
    await seedSession(stub);
    const refreshed = refreshedState();
    spyBrowserFetch({ "/data-harvest": async () => Response.json({
      ok: true, ...data, state: refreshed,
      diagnostics: { timeline: [{ stage: "DONE", elapsedMs: 42 }], secret: "SECRET" },
    }) });
    const res = await postHarvest(stub);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(data);
    expect((await readState(stub))?.storageState).toEqual(refreshed);
    await runInDurableObject(stub, (instance) => {
      expect((instance as unknown as HarvestTarget).state.storageState).toEqual(refreshed);
    });
  });

  it.each([
    ["absent", undefined], ["missing CAS cookie", { ...refreshedState(), cookies: [] }],
    ["malformed cookie", { ...refreshedState(), cookies: [null] }],
    ["foreign origin", { ...refreshedState(), origins: [{ origin: "https://evil.example", localStorage: [] }] }],
    ["malformed localStorage", { ...refreshedState(), origins: [{ origin: "https://my.cqu.edu.cn", localStorage: [{ name: "n", value: 1 }] }] }],
    ["oversized", { ...refreshedState(), origins: [{ origin: "https://my.cqu.edu.cn", localStorage: [{ name: "n", value: "x".repeat(121 * 1024) }] }] }],
  ])("retains old state and successful data for %s refresh", async (_label, state) => {
    const stub = freshStub("refresh-invalid");
    await seedSession(stub);
    spyBrowserFetch({ "/data-harvest": async () => Response.json({ ok: true, ...data, state }) });
    const res = await postHarvest(stub);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(data);
    expect((await readState(stub))?.storageState).toEqual(validStorageState());
  });

  it.each([
    [502, false], [409, false], [200, false],
  ])("failed or partial node response %i never replaces state", async (status, ok) => {
    const stub = freshStub("refresh-failed");
    await seedSession(stub);
    spyBrowserFetch({ "/data-harvest": async () => Response.json({ ok, ...data, state: refreshedState() }, { status }) });
    expect((await postHarvest(stub)).status).toBeGreaterThanOrEqual(400);
    expect((await readState(stub))?.storageState).toEqual(validStorageState());
  });

  it.each([
    { ...data, fetches: [{ ...data.fetches[0], status: 503 }] },
    { ...data, fetches: [] },
    { ...data, captures: [] },
    { ...data, captures: [{ ...data.captures[0], status: 503 }] },
  ])("does not refresh an incomplete success response %#", async (partial) => {
    const stub = freshStub("refresh-partial-get");
    await seedSession(stub);
    spyBrowserFetch({ "/data-harvest": async () => Response.json({ ok: true, ...partial, state: refreshedState() }) });
    expect(await (await postHarvest(stub)).json()).toEqual(partial);
    expect((await readState(stub))?.storageState).toEqual(validStorageState());
  });

  it.each(["unbound", "revoked", "needs_reauth", "deleted", "replaced", "relogin", "metadata"])(
    "re-reads durable state after browser await: %s", async (change) => {
      const stub = freshStub("refresh-race");
      await seedSession(stub);
      await runInDurableObject(stub, async (instance, ctx) => {
        let latest: StoredState | undefined;
        spyBrowserFetch({ "/data-harvest": async () => {
          latest = await ctx.storage.get<StoredState>("state");
          if (change === "deleted") {
            await ctx.storage.delete("state");
          } else if (change === "replaced") {
            latest = { ...latest!, storageState: { ...validStorageState(), origins: [{ origin: "https://sso.cqu.edu.cn", localStorage: [{ name: "new-session", value: "v" }] }] } };
            await ctx.storage.put("state", latest);
          } else if (change === "relogin") {
            latest = { ...latest!, loginAt: latest!.loginAt + 1 };
            await ctx.storage.put("state", latest);
          } else if (change === "metadata") {
            latest = { ...latest!, lastKeepAlive: 123456 };
            await ctx.storage.put("state", latest);
          } else {
            await ctx.storage.put("status", change);
          }
          return Response.json({ ok: true, ...data, state: refreshedState() });
        } });
        const target = instance as unknown as HarvestTarget;
        const harvest = target.dataHarvest({ recipe, clientId: "calendar", source: "rpc" });
        if (["unbound", "revoked", "needs_reauth"].includes(change)) {
          await expect(harvest).rejects.toMatchObject({ code: "SESSION_INACTIVE" });
        } else {
          expect(await harvest).toEqual(data);
        }
        const stored = await ctx.storage.get<StoredState>("state");
        if (change === "deleted") expect(stored).toBeUndefined();
        else if (change === "metadata") expect(stored).toEqual({ ...latest, storageState: refreshedState() });
        else expect(stored).toEqual(latest);
        expect(await ctx.storage.get("status")).toBe(["deleted", "replaced", "relogin", "metadata"].includes(change) ? "active" : change);
      });
    },
  );

  it("applies the size guard to the whole session envelope", async () => {
    const stub = freshStub("refresh-envelope-limit");
    await seedSession(stub);
    const refreshed = refreshedState();
    refreshed.origins[0].localStorage[0].value = "x".repeat(118 * 1024);
    await runInDurableObject(stub, async (instance, ctx) => {
      let latest: StoredState | undefined;
      spyBrowserFetch({ "/data-harvest": async () => {
        latest = { ...(await ctx.storage.get<StoredState>("state"))!, envelopePadding: "x".repeat(3 * 1024) };
        await ctx.storage.put("state", latest);
        return Response.json({ ok: true, ...data, state: refreshed });
      } });
      expect(await (instance as unknown as HarvestTarget).dataHarvest({ recipe, clientId: "calendar", source: "rpc" })).toEqual(data);
      expect(await ctx.storage.get("state")).toEqual(latest);
    });
  });

  it("an authority read failure withholds data without resetting the durable object", async () => {
    const stub = freshStub("refresh-read-failure");
    await seedSession(stub);
    await runInDurableObject(stub, async (instance, ctx) => {
      let getSpy: ReturnType<typeof vi.spyOn> | undefined;
      spyBrowserFetch({ "/data-harvest": async () => {
        getSpy = vi.spyOn(ctx.storage, "get").mockRejectedValueOnce(new Error("SECRET storage unavailable"));
        return Response.json({ ok: true, ...data, state: refreshedState() });
      } });
      await expect((instance as unknown as HarvestTarget).dataHarvest({ recipe, clientId: "calendar", source: "rpc" })).rejects.toThrow();
      getSpy?.mockRestore();
      expect((await ctx.storage.get<StoredState>("state"))?.storageState).toEqual(validStorageState());
    });
    expect((await readState(stub))?.storageState).toEqual(validStorageState());
  });

  it("a guarded storage.put failure preserves durable and in-memory state without leaking values", async () => {
    const stub = freshStub("refresh-put-failure");
    await seedSession(stub);
    await runInDurableObject(stub, async (instance, ctx) => {
      let original: StoredState | undefined;
      let putSpy: ReturnType<typeof vi.spyOn> | undefined;
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      spyBrowserFetch({ "/data-harvest": async () => {
        original = await ctx.storage.get<StoredState>("state");
        putSpy = vi.spyOn(ctx.storage, "put").mockRejectedValue(new Error("SECRET state write failed"));
        return Response.json({ ok: true, ...data, state: refreshedState() });
      } });
      const target = instance as unknown as HarvestTarget;
      expect(await target.dataHarvest({ recipe, clientId: "calendar", source: "rpc" })).toEqual(data);
      putSpy?.mockRestore();
      expect(await ctx.storage.get("state")).toEqual(original);
      expect(target.state).toEqual(original);
      expect(JSON.stringify(errors.mock.calls)).not.toContain("SECRET");
    });
  });
});
