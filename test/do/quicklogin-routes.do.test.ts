import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickloginAccountClient } from "../../src/services/quicklogin/account-client";
import {
  authorizeOfficialInstall,
  createOAuthFixture,
} from "./quicklogin-oauth-fixture";

beforeAll(async () => applyD1Migrations(env.DATABASE, env.TEST_MIGRATIONS));
beforeEach(async () => {
  for (const table of [
    "oauthAccessToken", "oauthRefreshToken", "oauthConsent", "oauthClient",
    "session", "account", "user", "jwks",
  ]) await env.DATABASE.prepare(`DELETE FROM ${table}`).run();
  env.QUICKLOGIN_DEVICE_MODE = "on";
  vi.restoreAllMocks();
});

function extensionHeaders(authorization: string): Headers {
  return new Headers({
    authorization,
    origin: env.QUICKLOGIN_EXTENSION_ORIGIN,
    "content-type": "application/json",
  });
}

describe("quicklogin device HTTP", () => {
  it("serves every v1 device operation and shares state with the exact legacy bridge", async () => {
    const fixture = await createOAuthFixture(env);
    const install = await authorizeOfficialInstall(fixture, {
      websiteSession: fixture.websiteSession,
    });
    const authorization = install.request().headers.get("authorization")!;
    const registered = await SELF.fetch(
      "http://localhost:8787/api/v1/cqu/quicklogin/devices",
      {
        method: "POST",
        headers: extensionHeaders(authorization),
        body: JSON.stringify({
          deviceName: "Route Test Chrome",
          browserFamily: "chrome",
          browserVersion: "140",
        }),
      }
    );
    expect(registered.status).toBe(200);
    expect(registered.headers.get("cache-control")).toBe("no-store");
    expect(registered.headers.get("access-control-allow-origin"))
      .toBe(env.QUICKLOGIN_EXTENSION_ORIGIN);
    const device = await registered.json<{ deviceId: string; generation: number }>();

    const websiteHeaders = new Headers(fixture.websiteSession.headers);
    websiteHeaders.set("origin", new URL(env.BETTER_AUTH_URL).origin);
    const legacyList = await SELF.fetch(
      "http://localhost:8787/api/cqu/quicklogin/devices",
      { headers: websiteHeaders }
    );
    expect(legacyList.status).toBe(200);
    await expect(legacyList.json()).resolves.toMatchObject({
      used: 0,
      devices: [expect.objectContaining({ deviceId: device.deviceId })],
    });

    const accounts = new QuickloginAccountClient(env);
    const preview = await accounts.previewQuota(fixture.websiteSession.userId, 1, Date.now());
    await accounts.applyQuota(fixture.websiteSession.userId,
      { token: preview.token, newLimit: 1 }, Date.now());
    await accounts.setMasterEnabled(fixture.websiteSession.userId, true);

    const root = await SELF.fetch("http://localhost:8787/api/v1/cqu/quicklogin", {
      headers: fixture.websiteSession.headers,
    });
    expect(root.status).toBe(200);
    await expect(root.json()).resolves.toEqual({
      data: { eligible: true, masterEnabled: true, deviceLimit: 1, used: 0 },
    });

    const enabled = await SELF.fetch(
      `http://localhost:8787/api/cqu/quicklogin/devices/${device.deviceId}`,
      {
        method: "PUT",
        headers: extensionHeaders(authorization),
        body: JSON.stringify({ enabled: true }),
      }
    );
    expect(enabled.status).toBe(200);
    const enabledBody = await enabled.json<{ generation: number; state: string }>();
    expect(enabledBody.state).toBe("preparing");

    const status = await SELF.fetch(
      `http://localhost:8787/api/v1/cqu/quicklogin/devices/${device.deviceId}/status`,
      {
        method: "POST",
        headers: extensionHeaders(authorization),
        body: JSON.stringify({
          protocolVersion: 1,
          generation: enabledBody.generation,
          appliedVersion: null,
          browserVersion: "141",
        }),
      }
    );
    expect(status.status).toBe(200);

    const refresh = await SELF.fetch(
      `http://localhost:8787/api/v1/cqu/quicklogin/devices/${device.deviceId}/refresh`,
      {
        method: "POST",
        headers: extensionHeaders(authorization),
        body: JSON.stringify({ protocolVersion: 1, generation: enabledBody.generation }),
      }
    );
    expect(refresh.status).toBe(202);

    const exported = await SELF.fetch(
      `http://localhost:8787/api/v1/cqu/quicklogin/devices/${device.deviceId}/export`,
      {
        method: "POST",
        headers: extensionHeaders(authorization),
        body: JSON.stringify({
          protocolVersion: 1,
          generation: enabledBody.generation,
          sessionVersion: 0,
        }),
      }
    );
    expect(exported.status).toBe(409);
    await expect(exported.json()).resolves.toMatchObject({ error: { code: "PREPARING" } });

    const deleted = await SELF.fetch(
      `http://localhost:8787/api/cqu/quicklogin/devices/${device.deviceId}`,
      { method: "DELETE", headers: websiteHeaders }
    );
    expect(deleted.status).toBe(204);
  });

  it("keeps session and device principals separate without bearer fallback", async () => {
    const fixture = await createOAuthFixture(env);
    const install = await authorizeOfficialInstall(fixture, {
      websiteSession: fixture.websiteSession,
    });
    const bearer = install.request().headers.get("authorization")!;

    const websiteOnDevice = await SELF.fetch(
      "http://localhost:8787/api/v1/cqu/quicklogin/devices", {
        method: "POST",
        headers: new Headers({
          cookie: fixture.websiteSession.headers.get("cookie")!,
          origin: env.QUICKLOGIN_EXTENSION_ORIGIN,
          "content-type": "application/json",
        }),
        body: JSON.stringify({ deviceName: "Chrome", browserFamily: "chrome", browserVersion: "140" }),
      });
    expect(websiteOnDevice.status).toBe(401);

    const badBearerWithSession = new Headers(fixture.websiteSession.headers);
    badBearerWithSession.set("authorization", "Bearer invalid");
    badBearerWithSession.set("origin", new URL(env.BETTER_AUTH_URL).origin);
    const root = await SELF.fetch("http://localhost:8787/api/v1/cqu/quicklogin", {
      headers: badBearerWithSession,
    });
    expect(root.status).toBe(401);

    const bearerOnRoot = await SELF.fetch("http://localhost:8787/api/v1/cqu/quicklogin", {
      headers: { authorization: bearer },
    });
    expect(bearerOnRoot.status).toBe(401);
  });

  it("returns fixed CORS, JSON 404/405, and mode-off 503", async () => {
    const allowed = await SELF.fetch(
      "http://localhost:8787/api/v1/cqu/quicklogin/devices", {
        method: "OPTIONS",
        headers: { origin: env.QUICKLOGIN_EXTENSION_ORIGIN,
          "access-control-request-method": "POST" },
      });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin"))
      .toBe(env.QUICKLOGIN_EXTENSION_ORIGIN);
    expect(allowed.headers.get("access-control-allow-methods")).toBe("GET, POST");
    const itemPreflight = await SELF.fetch(
      "http://localhost:8787/api/v1/cqu/quicklogin/devices/device-a", {
        method: "OPTIONS",
        headers: { origin: env.QUICKLOGIN_EXTENSION_ORIGIN,
          "access-control-request-method": "DELETE" },
      });
    expect(itemPreflight.status).toBe(204);
    expect(itemPreflight.headers.get("access-control-allow-methods")).toBe("PUT, DELETE");
    const statusPreflight = await SELF.fetch(
      "http://localhost:8787/api/v1/cqu/quicklogin/devices/device-a/status", {
        method: "OPTIONS",
        headers: { origin: env.QUICKLOGIN_EXTENSION_ORIGIN,
          "access-control-request-method": "POST" },
      });
    expect(statusPreflight.status).toBe(204);
    expect(statusPreflight.headers.get("access-control-allow-methods")).toBe("POST");
    const denied = await SELF.fetch(
      "http://localhost:8787/api/v1/cqu/quicklogin/devices", {
        method: "OPTIONS",
        headers: { origin: "https://attacker.example",
          "access-control-request-method": "POST" },
      });
    expect(denied.status).toBe(403);

    const wrongMethod = await SELF.fetch(
      "http://localhost:8787/api/v1/cqu/quicklogin/devices", { method: "PATCH" });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toContain("POST");
    const unknown = await SELF.fetch(
      "http://localhost:8787/api/cqu/quicklogin/devices/private/raw/path");
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("content-type")).toContain("json");

    env.QUICKLOGIN_DEVICE_MODE = "off";
    const unavailable = await SELF.fetch(
      "http://localhost:8787/api/v1/cqu/quicklogin/devices", {
        method: "POST",
        headers: { origin: env.QUICKLOGIN_EXTENSION_ORIGIN },
      });
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("access-control-allow-origin"))
      .toBe(env.QUICKLOGIN_EXTENSION_ORIGIN);
    await expect(unavailable.json()).resolves.toMatchObject({
      error: { code: "TEMPORARY_UNAVAILABLE" },
    });

    const offPreflight = await SELF.fetch(
      "http://localhost:8787/api/v1/cqu/quicklogin/devices", {
        method: "OPTIONS",
        headers: {
          origin: env.QUICKLOGIN_EXTENSION_ORIGIN,
          "access-control-request-method": "POST",
        },
      });
    expect(offPreflight.status).toBe(204);
    expect(offPreflight.headers.get("access-control-allow-origin"))
      .toBe(env.QUICKLOGIN_EXTENSION_ORIGIN);

    const offWrongMethod = await SELF.fetch(
      "http://localhost:8787/api/v1/cqu/quicklogin/devices", {
        method: "PATCH",
        headers: { origin: env.QUICKLOGIN_EXTENSION_ORIGIN },
      });
    expect(offWrongMethod.status).toBe(405);
    expect(offWrongMethod.headers.get("allow")).toContain("POST");

    const offUnknown = await SELF.fetch(
      "http://localhost:8787/api/v1/cqu/quicklogin/devices/private/raw/path", {
        headers: { origin: env.QUICKLOGIN_EXTENSION_ORIGIN },
      });
    expect(offUnknown.status).toBe(404);
    expect(offUnknown.headers.get("content-type")).toContain("json");
  });
});
