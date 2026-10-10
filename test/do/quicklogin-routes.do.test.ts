import { applyD1Migrations, env, runInDurableObject, SELF } from "cloudflare:test";
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

function extensionHeaders(authorization: string, origin = env.QUICKLOGIN_EXTENSION_ORIGIN): Headers {
  return new Headers({
    authorization,
    origin,
    "content-type": "application/json",
  });
}

async function flushProjection(userId: string) {
  const stub = env.CQU_QUICKLOGIN_ACCOUNT.get(
    env.CQU_QUICKLOGIN_ACCOUNT.idFromName(userId)
  );
  await runInDurableObject(stub, async (instance) => {
    await (instance as unknown as { alarm(): Promise<void> }).alarm();
  });
}

describe("quicklogin device HTTP", () => {
  it("serves v2 device payloads on the canonical API and reconciles stale status", async () => {
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
    await flushProjection(fixture.websiteSession.userId);
    // 自助注册只落 0/0 投影行:正信号缺失,准入门保持关闭。
    const bootstrapped = await SELF.fetch(
      "http://localhost:8787/api/v1/cqu/quicklogin/devices",
      { headers: websiteHeaders }
    );
    expect(bootstrapped.status).toBe(403);

    const accounts = new QuickloginAccountClient(env);
    const preview = await accounts.previewQuota(fixture.websiteSession.userId, 1, Date.now());
    await accounts.applyQuota(fixture.websiteSession.userId,
      { token: preview.token, newLimit: 1 }, Date.now());
    await accounts.setMasterEnabled(fixture.websiteSession.userId, true);
    await flushProjection(fixture.websiteSession.userId);

    const canonicalList = await SELF.fetch(
      "http://localhost:8787/api/v1/cqu/quicklogin/devices",
      { headers: websiteHeaders }
    );
    expect(canonicalList.status).toBe(200);
    await expect(canonicalList.json()).resolves.toMatchObject({
      used: 0,
      devices: [expect.objectContaining({ deviceId: device.deviceId })],
    });

    const root = await SELF.fetch("http://localhost:8787/api/v1/cqu/quicklogin", {
      headers: fixture.websiteSession.headers,
    });
    expect(root.status).toBe(200);
    await expect(root.json()).resolves.toEqual({
      data: { eligible: true, masterEnabled: true, deviceLimit: 1, used: 0 },
    });

    const enabled = await SELF.fetch(
      `http://localhost:8787/api/v1/cqu/quicklogin/devices/${device.deviceId}`,
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
          protocolVersion: 2,
          observedGeneration: enabledBody.generation,
          appliedVersion: null,
          browserVersion: "141",
        }),
      }
    );
    expect(status.status).toBe(200);

    await accounts.setMasterEnabled(fixture.websiteSession.userId, false);
    await accounts.setMasterEnabled(fixture.websiteSession.userId, true);
    const reconciled = await SELF.fetch(
      `http://localhost:8787/api/v1/cqu/quicklogin/devices/${device.deviceId}/status`,
      {
        method: "POST",
        headers: extensionHeaders(authorization),
        body: JSON.stringify({
          protocolVersion: 2,
          observedGeneration: enabledBody.generation,
          appliedVersion: null,
          browserVersion: "141",
        }),
      }
    );
    expect(reconciled.status).toBe(200);
    const reconciledBody = await reconciled.json<{
      generation: number;
      lastSeenAt: number | null;
    }>();
    expect(reconciledBody.generation).toBe(enabledBody.generation + 2);
    expect(reconciledBody.lastSeenAt).not.toBeNull();

    const refresh = await SELF.fetch(
      `http://localhost:8787/api/v1/cqu/quicklogin/devices/${device.deviceId}/refresh`,
      {
        method: "POST",
        headers: extensionHeaders(authorization),
        body: JSON.stringify({ protocolVersion: 2, generation: reconciledBody.generation }),
      }
    );
    expect(refresh.status).toBe(202);

    const exported = await SELF.fetch(
      `http://localhost:8787/api/v1/cqu/quicklogin/devices/${device.deviceId}/export`,
      {
        method: "POST",
        headers: extensionHeaders(authorization),
        body: JSON.stringify({
          protocolVersion: 2,
          generation: reconciledBody.generation,
          sessionVersion: 0,
        }),
      }
    );
    expect(exported.status).toBe(409);
    await expect(exported.json()).resolves.toMatchObject({ error: { code: "PREPARING" } });

    const deleted = await SELF.fetch(
      `http://localhost:8787/api/v1/cqu/quicklogin/devices/${device.deviceId}`,
      { method: "DELETE", headers: websiteHeaders }
    );
    expect(deleted.status).toBe(204);
  });

  it("does not let self-service registration bootstrap the device-mode admission gate", async () => {
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
          deviceName: "Self Bootstrap Chrome",
          browserFamily: "chrome",
          browserVersion: "140",
        }),
      }
    );
    expect(registered.status).toBe(200);

    await flushProjection(fixture.websiteSession.userId);
    const row = await env.DATABASE.prepare(
      "SELECT device_limit, master_enabled FROM quicklogin_account_projection WHERE user_id = ?"
    )
      .bind(fixture.websiteSession.userId)
      .first<{ device_limit: number; master_enabled: number }>();
    expect(row).toEqual({ device_limit: 0, master_enabled: 0 });

    const root = await SELF.fetch("http://localhost:8787/api/v1/cqu/quicklogin", {
      headers: fixture.websiteSession.headers,
    });
    expect(root.status).toBe(200);
    await expect(root.json()).resolves.toEqual({ data: { eligible: false } });

    const websiteHeaders = new Headers(fixture.websiteSession.headers);
    websiteHeaders.set("origin", new URL(env.BETTER_AUTH_URL).origin);
    const list = await SELF.fetch(
      "http://localhost:8787/api/v1/cqu/quicklogin/devices",
      { headers: websiteHeaders }
    );
    expect(list.status).toBe(403);

    const accounts = new QuickloginAccountClient(env);
    const preview = await accounts.previewQuota(fixture.websiteSession.userId, 1, Date.now());
    await accounts.applyQuota(fixture.websiteSession.userId,
      { token: preview.token, newLimit: 1 }, Date.now());
    await flushProjection(fixture.websiteSession.userId);
    const opened = await SELF.fetch("http://localhost:8787/api/v1/cqu/quicklogin", {
      headers: fixture.websiteSession.headers,
    });
    expect(opened.status).toBe(200);
    await expect(opened.json()).resolves.toEqual({
      data: { eligible: true, masterEnabled: false, deviceLimit: 1, used: 0 },
    });
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
    const retired = await SELF.fetch(
      "http://localhost:8787/api/cqu/quicklogin/devices");
    expect(retired.status).toBe(404);

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

describe('QuickLogin v3 HTTP contracts', () => {
 it.each([env.QUICKLOGIN_EXTENSION_ORIGIN, 'chrome-extension://ainapeknaclcpoioimonkodmoakhacjd'])('serves capabilities and registers the existing bearer device with a parsed v3 snapshot for %s', async origin => {
  const { parseApiResponse, parseCapabilities, parseRegistrationResponse, parseReconcileResponse } = await import('../../src/services/quicklogin/protocol-v3');
  const capabilities = await SELF.fetch('http://localhost:8787/api/v1/cqu/quicklogin/capabilities', { headers: { Origin: origin } });
  expect(capabilities.status).toBe(200);
  expect(parseApiResponse(await capabilities.json(), parseCapabilities).data.supportedProtocolVersions).toEqual([2,3]);
  const fixture = await createOAuthFixture(env), install = await authorizeOfficialInstall(fixture, { websiteSession: fixture.websiteSession });
  const authorization = install.request().headers.get('authorization')!;
  const client = { installationId:'http-install', extensionVersion:'0.2.0', buildId:'test', browserVersion:'152' };
  const request = { protocolVersion:3, requestId:'http-r', registrationId:'http-reg', client, deviceName:'HTTP Chrome' };
  const registered = await SELF.fetch('http://localhost:8787/api/v1/cqu/quicklogin/registrations',{method:'POST',headers:extensionHeaders(authorization, origin),body:JSON.stringify(request)});
  expect(registered.status).toBe(200);
  const data = parseApiResponse(await registered.json(),parseRegistrationResponse).data;
  const replay = await SELF.fetch('http://localhost:8787/api/v1/cqu/quicklogin/registrations',{method:'POST',headers:extensionHeaders(authorization, origin),body:JSON.stringify(request)});
  expect(parseApiResponse(await replay.json(),parseRegistrationResponse).data.deviceId).toBe(data.deviceId);
  const reconciled=await SELF.fetch(`http://localhost:8787/api/v1/cqu/quicklogin/devices/${data.deviceId}/reconcile`,{method:'POST',headers:extensionHeaders(authorization, origin),body:JSON.stringify({protocolVersion:3,requestId:'http-sync',client,observed:null,reportEpoch:'http-epoch',clientReportSeq:1,local:{enabledIntent:true,mode:'automatic',cookieState:'missing',receipt:null}})});
  expect(reconciled.status).toBe(200);
  expect(parseApiResponse(await reconciled.json(),parseReconcileResponse).data.snapshot.identity.installationId).toBe('http-install');
 });
 it('enforces Origin on v3 routes and exposes structured protocol failures',async()=>{
  const response=await SELF.fetch('http://localhost:8787/api/v1/cqu/quicklogin/registrations',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},body:'{}'});
  expect(response.status).toBe(403); expect(await response.json()).toMatchObject({code:'FORBIDDEN',action:'reconcile',retryAt:null});
  const ticket=await SELF.fetch('http://localhost:8787/api/v1/cqu/quicklogin/devices/any/resume-ticket',{method:'POST',headers:{Origin:env.QUICKLOGIN_EXTENSION_ORIGIN}});
  expect(ticket.status).toBe(403);
  expect(ticket.headers.get('access-control-allow-origin')).toBeNull();
 });
});
