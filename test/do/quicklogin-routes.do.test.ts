import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authorizeOfficialInstall,
  createOAuthFixture,
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
    const url = new URL(request.url);
    if (url.pathname === "/api/auth/jwks") return fixture.authHandler(request);
    throw new Error(`unexpected fetch: ${url.pathname}`);
  });
}

describe("quicklogin device routes", () => {
  it("registers an official extension grant outside the session-only root route", async () => {
    const fixture = await createOAuthFixture(env);
    routeJwks(fixture);
    const install = await authorizeOfficialInstall(fixture, {
      websiteSession: fixture.websiteSession,
    });
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
          deviceName: "Route Test Chrome",
          browserFamily: "chrome",
          browserVersion: "140",
        }),
      }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe(
      env.QUICKLOGIN_EXTENSION_ORIGIN
    );
    await expect(response.json()).resolves.toMatchObject({
      protocolVersion: 1,
      enabled: false,
      state: "disabled",
      sessionVersion: 0,
    });
  });

  it("rejects a cross-device operation without revealing existence", async () => {
    const fixture = await createOAuthFixture(env);
    routeJwks(fixture);
    const install = await authorizeOfficialInstall(fixture, {
      websiteSession: fixture.websiteSession,
    });
    const response = await SELF.fetch(
      "http://localhost:8787/api/cqu/quicklogin/devices/not-my-device",
      {
        method: "PUT",
        headers: {
          authorization: install.request().headers.get("authorization")!,
          origin: env.QUICKLOGIN_EXTENSION_ORIGIN,
          "content-type": "application/json",
        },
        body: JSON.stringify({ enabled: false }),
      }
    );
    expect(response.status).toBe(403);
  });

  it("requires the exact extension origin on device APIs", async () => {
    const fixture = await createOAuthFixture(env);
    routeJwks(fixture);
    const install = await authorizeOfficialInstall(fixture, {
      websiteSession: fixture.websiteSession,
    });
    const response = await SELF.fetch(
      "http://localhost:8787/api/cqu/quicklogin/devices",
      {
        method: "POST",
        headers: {
          authorization: install.request().headers.get("authorization")!,
          origin: "https://attacker.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          deviceName: "Route Test Chrome",
          browserFamily: "chrome",
          browserVersion: "140",
        }),
      }
    );
    expect(response.status).toBe(403);
  });

  it("rejects unknown origins for website writes", async () => {
    const fixture = await createOAuthFixture(env);
    const headers = new Headers(fixture.websiteSession.headers);
    headers.set("origin", "https://attacker.example");
    headers.set("content-type", "application/json");
    const response = await SELF.fetch(
      "http://localhost:8787/api/cqu/quicklogin",
      {
        method: "PUT",
        headers,
        body: JSON.stringify({ enabled: false }),
      }
    );
    expect(response.status).toBe(403);
  });
});
