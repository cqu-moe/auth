import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  freshStub,
  readState,
  readStatus,
  readStorage,
  seedCredentials,
  seedSession,
  spyBrowserFetch,
  validStorageState,
} from "./helpers";

const health = () =>
  Response.json({
    ok: true,
    bootId: "boot-1",
    browserProfile: "cloudflare",
    capabilities: ["code-permit", "browser-route-v1", "operation-deadline-v1"],
  });

describe("CAS login terminal ownership fencing", () => {
  it("does not let a late success replace a newer binding or session", async () => {
    const stub = freshStub("cas-late-success");
    await seedSession(stub, { status: "relogging" });
    await seedCredentials(stub);
    const replacement = validStorageState();
    replacement.cookies[0]!.value = "replacement-tgt";

    await runInDurableObject(stub, async (instance, durableState) => {
      await (instance as unknown as { loadState(): Promise<void> }).loadState();
      const token = "old-operation";
      await durableState.storage.put({
        loginInFlight: { token, startedAt: Date.now(), browserRouteVersion: 1 },
        [`browserRoute:${token}`]: {
          token,
          kind: "cas",
          route: { version: 1, backend: "cloudflare", userId: "u1" },
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
        quickloginBindingEpoch: 3,
      });
      spyBrowserFetch({
        "/health": health,
        "/code-permit": () => Response.json({ ok: true }),
        "/run": async () => {
          const current = await durableState.storage.get<Record<string, unknown>>("state");
          await durableState.storage.put({
            loginInFlight: { token: "replacement", startedAt: Date.now() },
            quickloginBindingEpoch: 4,
            status: "active",
            state: {
              ...current,
              userId: "u2",
              studentId: "2020000002",
              storageState: replacement,
            },
          });
          return Response.json({ ok: true, state: validStorageState() });
        },
      });

      const result = await (instance as unknown as {
        containerLogin(
          ok: string,
          fail: string,
          start: undefined,
          deadline: undefined,
          reservation: { token: string; route: { version: 1; backend: "cloudflare"; userId: string } }
        ): Promise<string>;
      }).containerLogin("RELOGIN_OK", "RELOGIN_FAIL", undefined, undefined, {
        token,
        route: { version: 1, backend: "cloudflare", userId: "u1" },
      });
      expect(result).toBe("failed");
    });

    expect(await readStorage(stub, "loginInFlight")).toMatchObject({ token: "replacement" });
    expect(await readStatus(stub)).toBe("active");
    expect(await readState(stub)).toMatchObject({ storageState: replacement });
  });

  it("does not let a late failure change a replacement operation", async () => {
    const stub = freshStub("cas-late-failure");
    await seedSession(stub, { status: "binding" });
    await seedCredentials(stub);

    await runInDurableObject(stub, async (instance, durableState) => {
      await (instance as unknown as { loadState(): Promise<void> }).loadState();
      const token = "old-operation";
      await durableState.storage.put({
        loginInFlight: { token, startedAt: Date.now(), browserRouteVersion: 1 },
        [`browserRoute:${token}`]: {
          token,
          kind: "cas",
          route: { version: 1, backend: "cloudflare", userId: "u1" },
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
        quickloginBindingEpoch: 1,
      });
      spyBrowserFetch({
        "/health": health,
        "/code-permit": () => Response.json({ ok: true }),
        "/run": async () => {
          await durableState.storage.put({
            loginInFlight: { token: "replacement", startedAt: Date.now() },
            status: "binding",
          });
          return Response.json({ ok: false, error: "temporary" }, { status: 503 });
        },
      });

      await (instance as unknown as {
        containerLogin(
          ok: string,
          fail: string,
          start: undefined,
          deadline: undefined,
          reservation: { token: string; route: { version: 1; backend: "cloudflare"; userId: string } }
        ): Promise<string>;
      }).containerLogin("FIRST_LOGIN_OK", "FIRST_LOGIN_FAIL", undefined, undefined, {
        token,
        route: { version: 1, backend: "cloudflare", userId: "u1" },
      });
    });

    expect(await readStorage(stub, "loginInFlight")).toMatchObject({ token: "replacement" });
    expect(await readStatus(stub)).toBe("binding");
  });

  it("does not report success when the terminal state exceeds the storage guard", async () => {
    const stub = freshStub("cas-oversized-success");
    await seedSession(stub, { status: "relogging" });
    await seedCredentials(stub);
    const previous = await readState(stub);

    await runInDurableObject(stub, async (instance, durableState) => {
      await (instance as unknown as { loadState(): Promise<void> }).loadState();
      const token = "oversized-operation";
      await durableState.storage.put({
        loginInFlight: { token, startedAt: Date.now(), browserRouteVersion: 1 },
        [`browserRoute:${token}`]: {
          token,
          kind: "cas",
          route: { version: 1, backend: "cloudflare", userId: "u1" },
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
      });
      const oversized = validStorageState();
      oversized.origins = [{
        origin: "https://sso.cqu.edu.cn",
        localStorage: [{ name: "oversized", value: "x".repeat(125_000) }],
      }];
      spyBrowserFetch({
        "/health": health,
        "/code-permit": () => Response.json({ ok: true }),
        "/run": () => Response.json({ ok: true, state: oversized }),
      });

      const result = await (instance as unknown as {
        containerLogin(
          ok: string,
          fail: string,
          start: undefined,
          deadline: undefined,
          reservation: { token: string; route: { version: 1; backend: "cloudflare"; userId: string } }
        ): Promise<string>;
      }).containerLogin("RELOGIN_OK", "RELOGIN_FAIL", undefined, undefined, {
        token,
        route: { version: 1, backend: "cloudflare", userId: "u1" },
      });
      expect(result).toBe("failed");
    });

    expect(await readStatus(stub)).toBe("expired");
    expect(await readState(stub)).toEqual(previous);
  });
});
