import { applyD1Migrations, env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickloginAccountClient } from "../../src/services/quicklogin/account-client";
import type { OutboxEvent } from "../../src/services/quicklogin/outbox";
import {
  authorizeOfficialInstall,
  createOAuthFixture,
  OAuthFixtureError,
  type OAuthFixture,
} from "./quicklogin-oauth-fixture";

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of [
    "oauthAccessToken", "oauthRefreshToken", "oauthConsent", "oauthClient",
    "session", "account", "user", "jwks",
  ]) {
    await env.DATABASE.prepare(`DELETE FROM ${table}`).run();
  }
  vi.restoreAllMocks();
});

function routeJwks(fixture: OAuthFixture): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (new URL(request.url).pathname === "/api/auth/jwks") {
      return fixture.authHandler(request);
    }
    throw new Error(`unexpected fetch: ${request.url}`);
  });
}

async function register(install: Awaited<ReturnType<typeof authorizeOfficialInstall>>) {
  const request = install.request();
  const response = await SELF.fetch(
    "http://localhost:8787/api/cqu/quicklogin/devices",
    {
      method: "POST",
      headers: {
        authorization: request.headers.get("authorization")!,
        origin: env.QUICKLOGIN_EXTENSION_ORIGIN,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        deviceName: "Revocation Test Chrome",
        browserFamily: "chrome",
        browserVersion: "140",
      }),
    }
  );
  expect(response.status).toBe(200);
  return response.json<{ deviceId: string }>();
}

describe("quicklogin revocation", () => {
  it("revokes one grant family without revoking a sibling install or website session", async () => {
    const fixture = await createOAuthFixture(env);
    routeJwks(fixture);
    const first = await authorizeOfficialInstall(fixture, {
      websiteSession: fixture.websiteSession,
    });
    const second = await authorizeOfficialInstall(fixture, {
      websiteSession: fixture.websiteSession,
    });
    const firstDevice = await register(first);
    await register(second);

    const headers = new Headers(fixture.websiteSession.headers);
    headers.set("origin", new URL(env.BETTER_AUTH_URL).origin);
    const deleted = await SELF.fetch(
      `http://localhost:8787/api/cqu/quicklogin/devices/${firstDevice.deviceId}`,
      { method: "DELETE", headers }
    );
    expect(deleted.status).toBe(204);

    const rejected = await SELF.fetch(
      `http://localhost:8787/api/cqu/quicklogin/devices/${firstDevice.deviceId}/status`,
      {
        method: "POST",
        headers: {
          authorization: first.request().headers.get("authorization")!,
          origin: env.QUICKLOGIN_EXTENSION_ORIGIN,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          protocolVersion: 1,
          generation: 1,
          appliedVersion: null,
          browserVersion: "140",
        }),
      }
    );
    expect(rejected.status).toBe(403);
    await expect(rejected.json()).resolves.toMatchObject({
      error: { code: "DEVICE_REVOKED" },
    });

    const accountStub = env.CQU_QUICKLOGIN_ACCOUNT.get(
      env.CQU_QUICKLOGIN_ACCOUNT.idFromName(fixture.websiteSession.userId)
    );
    await runInDurableObject(accountStub, async (instance, state) => {
      const events = (await state.storage.get<OutboxEvent[]>("outbox")) ?? [];
      await state.storage.put(
        "outbox",
        events.map((event) => ({ ...event, nextAttemptAt: Date.now() - 1 }))
      );
      await (instance as unknown as { alarm(): Promise<void> }).alarm();
    });

    await expect(first.refresh()).rejects.toBeInstanceOf(OAuthFixtureError);
    await expect(second.refresh()).resolves.toBeDefined();
    await expect(
      fixture.authHandler(new Request("http://localhost:8787/api/auth/get-session", {
        headers: fixture.websiteSession.headers,
      })).then((response) => response.status)
    ).resolves.toBe(200);
  });

  it("fences every live device when the school binding changes", async () => {
    const client = new QuickloginAccountClient(env);
    const userId = `binding-change-${crypto.randomUUID()}`;
    await client.setMasterEnabled(userId, true);
    const preview = await client.previewQuota(userId, 2, Date.now());
    await client.applyQuota(userId, { token: preview.token, newLimit: 2 }, Date.now());

    const devices = [];
    for (const suffix of ["a", "b"]) {
      const grant = await client.createPendingGrant(userId, `client-${suffix}`, Date.now());
      await client.activateGrant(userId, grant.grantId, Date.now());
      const device = await client.registerDevice(userId, grant.grantId, {
        deviceName: `Chrome ${suffix}`,
        browserFamily: "chrome",
        browserVersion: "140",
      });
      devices.push(device);
    }

    await client.notifyBindingChanged(userId);

    for (const device of devices) {
      const authority = await client.getDeviceAuthority(userId, device.deviceId);
      expect(authority.generation).toBe(device.generation + 1);
      expect(authority.reason).toBe("DEVICE_DISABLED");
    }
  });
});
