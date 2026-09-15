import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { QuickloginLoginBrokerClient } from "../../src/services/quicklogin/login-broker-client";
import type { DeviceLoginResult } from "../../src/services/quicklogin/contracts";
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

function health() {
  return Response.json({
    ok: true,
    bootId: "quicklogin-boot",
    browserProfile: "cloudflare",
    capabilities: ["browser-route-v1", "operation-deadline-v1"],
  });
}

function freshDeviceState(marker: string) {
  const state = validStorageState();
  state.cookies = state.cookies.map((cookie) => ({
    ...cookie,
    value: `${cookie.value}-${marker}`,
  }));
  return state;
}

async function broker(stub: DurableObjectStub) {
  return new QuickloginLoginBrokerClient({
    CQU_SESSION: {
      idFromName: () => "test-id",
      get: () => stub,
    },
  } as never);
}

describe("quicklogin login broker", () => {
  it("returns an isolated device session without changing the schedule session", async () => {
    const stub = freshStub("quicklogin-broker-success");
    await seedSession(stub, { status: "active", loginAt: 123_456 });
    await seedCredentials(stub);
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put({
        quickloginTransientFailures: 3,
        reloginRetryAt: Date.now() - 1,
      });
    });
    const before = await readState(stub);
    let runBody: Record<string, unknown> | null = null;
    spyBrowserFetch({
      "/health": health,
      "/code-permit": () => Response.json({ ok: true }),
      "/run": async (request) => {
        runBody = await request.json<Record<string, unknown>>();
        return Response.json({ ok: true, state: freshDeviceState("device") });
      },
    });

    const result = await (await broker(stub)).quickloginLogin({
      ownerUserId: "u1",
      deviceId: "device-a",
      generation: 4,
    });

    expect(result).toMatchObject({
      kind: "success",
      bindingEpoch: 0,
    });
    expect(JSON.parse((result as Extract<DeviceLoginResult, { kind: "success" }>).storageState))
      .toMatchObject({ cookies: expect.any(Array) });
    expect(await readState(stub)).toEqual(before);
    expect(runBody).not.toBeNull();
    expect((runBody as unknown as Record<string, unknown>).seedState).toBeUndefined();
    expect(await readStatus(stub)).toBe("active");
    expect(await readStorage(stub, "quickloginLogin:device-a")).toBeUndefined();
    expect(await readStorage(stub, "quickloginTransientFailures")).toBeUndefined();
    expect(await readStorage(stub, "reloginRetryAt")).toBeUndefined();
  });

  it("coalesces the same device generation into one container run", async () => {
    const stub = freshStub("quicklogin-broker-merge");
    await seedSession(stub, { status: "active" });
    await seedCredentials(stub);
    let runStarted = false;
    const fetchMock = spyBrowserFetch({
      "/health": health,
      "/code-permit": () => Response.json({ ok: true }),
      "/run": async () => {
        runStarted = true;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return Response.json({ ok: true, state: freshDeviceState("merged") });
      },
    });
    const client = await broker(stub);
    const input = {
      ownerUserId: "u1",
      deviceId: "device-a",
      generation: 4,
    };
    const firstPromise = client.quickloginLogin(input);
    for (let attempt = 0; attempt < 20 && !runStarted; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(runStarted).toBe(true);
    const secondPromise = client.quickloginLogin(input);
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(second).toEqual(first);
    expect(
      fetchMock.mock.calls.filter(
        (call) => new URL((call[0] as Request).url).pathname === "/run"
      )
    ).toHaveLength(1);
  });

  it("cancels a late result after the binding epoch changes", async () => {
    const stub = freshStub("quicklogin-broker-epoch");
    await seedSession(stub, { status: "active" });
    await seedCredentials(stub);
    let instanceState: DurableObjectState | null = null;
    spyBrowserFetch({
      "/health": health,
      "/code-permit": () => Response.json({ ok: true }),
      "/run": async () => {
        await instanceState!.storage.put("quickloginBindingEpoch", 1);
        return Response.json({ ok: true, state: freshDeviceState("late") });
      },
    });
    const result = await runInDurableObject(stub, async (instance, state) => {
      instanceState = state;
      return (
        instance as unknown as {
          quickloginLogin(input: {
            ownerUserId: string;
            deviceId: string;
            generation: number;
          }): Promise<DeviceLoginResult>;
        }
      ).quickloginLogin({
        ownerUserId: "u1",
        deviceId: "device-a",
        generation: 4,
      });
    });

    expect(result).toEqual({ kind: "cancelled" });
    expect(await readStorage(stub, "quickloginLogin:device-a")).toBeUndefined();
  });

  it("rejects a cached success after the binding epoch changes", async () => {
    const stub = freshStub("quicklogin-broker-stale-cache");
    await seedSession(stub, { status: "active" });
    await seedCredentials(stub);
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put({
        quickloginBindingEpoch: 2,
        "quickloginResult:device-a:4": {
          result: {
            kind: "success",
            storageState: JSON.stringify(freshDeviceState("cached")),
            loginAt: Date.now(),
            bindingEpoch: 1,
          },
          expiresAt: Date.now() + 60_000,
        },
      });
    });

    await expect(
      (await broker(stub)).quickloginLogin({
        ownerUserId: "u1",
        deviceId: "device-a",
        generation: 4,
      })
    ).resolves.toEqual({ kind: "cancelled" });
    expect(await readStorage(stub, "quickloginResult:device-a:4")).toBeUndefined();
  });

  it("revalidates an otherwise successful result at the cache commit", async () => {
    const stub = freshStub("quicklogin-broker-cache-commit-race");
    await seedSession(stub, { status: "active" });
    await seedCredentials(stub);

    const result = await runInDurableObject(stub, async (instance, state) => {
      const target = instance as unknown as {
        quickloginLogin(input: {
          ownerUserId: string;
          deviceId: string;
          generation: number;
        }): Promise<DeviceLoginResult>;
        runQuickloginLogin: () => Promise<DeviceLoginResult>;
      };
      target.runQuickloginLogin = async () => {
        await state.storage.put("quickloginBindingEpoch", 1);
        return {
          kind: "success",
          storageState: JSON.stringify(freshDeviceState("late-cache")),
          loginAt: Date.now(),
          bindingEpoch: 0,
        };
      };
      return target.quickloginLogin({
        ownerUserId: "u1",
        deviceId: "device-a",
        generation: 4,
      });
    });

    expect(result).toEqual({ kind: "cancelled" });
    expect(await readStorage(stub, "quickloginResult:device-a:4")).toBeUndefined();
  });

  it("returns explicit reauth results for unbound and rejected credentials", async () => {
    const unbound = freshStub("quicklogin-broker-unbound");
    await expect(
      (await broker(unbound)).quickloginLogin({
        ownerUserId: "u1",
        deviceId: "device-a",
        generation: 1,
      })
    ).resolves.toEqual({ kind: "needs_reauth", reason: "unbound" });

    const rejected = freshStub("quicklogin-broker-rejected");
    await seedSession(rejected, { status: "active" });
    await seedCredentials(rejected);
    spyBrowserFetch({
      "/health": health,
      "/code-permit": () => Response.json({ ok: true }),
      "/run": () =>
        Response.json({ ok: false, error: "PASSWORD_REJECTED" }, { status: 401 }),
    });
    await expect(
      (await broker(rejected)).quickloginLogin({
        ownerUserId: "u1",
        deviceId: "device-a",
        generation: 1,
      })
    ).resolves.toEqual({
      kind: "needs_reauth",
      reason: "credentials_rejected",
    });
  });
});

it('does not reuse another v3 operation success when an explicit retry asks for a new login', async () => {
 const stub = freshStub('quicklogin-operation-cache');
 await seedSession(stub,{status:'active'});await seedCredentials(stub);
 let runs=0;
 spyBrowserFetch({'/health':health,'/code-permit':()=>Response.json({ok:true}),'/run':()=>{runs++;return Response.json({ok:true,state:freshDeviceState(`operation-${runs}`)});}});
 const client=await broker(stub),base={ownerUserId:'u1',deviceId:'device-operation',generation:3};
 expect((await client.quickloginLogin({...base,operationId:'operation-a'})).kind).toBe('success');
 expect((await client.quickloginLogin({...base,operationId:'operation-b'})).kind).toBe('success');
 expect(runs).toBe(2);
});

// The Python /run response test verifies this same fixture against raw-CDP errors.
import loginFailureFixtures from '../../container/fixtures/login-failures.json';
it.each(loginFailureFixtures)('classifies production /run $id results and legacy raw responses', async fixture => {
 for (const response of [fixture.response, {ok:false,error:fixture.raw}]) {
  const stub=freshStub(`producer-contract-${fixture.id}`);
  await seedSession(stub,{status:'active'});await seedCredentials(stub);
  spyBrowserFetch({'/health':health,'/code-permit':()=>Response.json({ok:true}),'/run':()=>Response.json(response,{status:500})});
  const result=await (await broker(stub)).quickloginLogin({ownerUserId:'u1',deviceId:'producer-contract',generation:1});
  expect(result).toMatchObject(fixture.workerKind==='needs_reauth' ? {kind:fixture.workerKind,reason:fixture.workerReason} : {kind:fixture.workerKind,reasonCode:fixture.workerReason});
  const binding=await (await broker(stub)).getBindingSnapshot('u1');
  expect(binding.credentialsState).toBe(fixture.workerReason==='credentials_rejected' ? 'rejected' : 'unknown');
 }
});
