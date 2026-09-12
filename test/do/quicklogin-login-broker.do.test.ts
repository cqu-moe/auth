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
    const before = await readState(stub);
    spyBrowserFetch({
      "/health": health,
      "/code-permit": () => Response.json({ ok: true }),
      "/run": () =>
        Response.json({ ok: true, state: freshDeviceState("device") }),
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
    expect(await readStatus(stub)).toBe("active");
    expect(await readStorage(stub, "quickloginLogin:device-a")).toBeUndefined();
  });

  it("coalesces the same device generation into one container run", async () => {
    const stub = freshStub("quicklogin-broker-merge");
    await seedSession(stub, { status: "active" });
    await seedCredentials(stub);
    const fetchMock = spyBrowserFetch({
      "/health": health,
      "/code-permit": () => Response.json({ ok: true }),
      "/run": () =>
        Response.json({ ok: true, state: freshDeviceState("merged") }),
    });
    const client = await broker(stub);
    const input = {
      ownerUserId: "u1",
      deviceId: "device-a",
      generation: 4,
    };
    const first = await client.quickloginLogin(input);
    const second = await client.quickloginLogin(input);
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
