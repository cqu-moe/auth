import { applyD1Migrations, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickloginAccountClient } from "../../src/services/quicklogin/account-client";
import { revokeProviderGrantFamily } from "../../src/services/quicklogin/oauth-grants";
import { verifyQuickloginBearer } from "../../src/middleware/quicklogin-device-auth";
import { verifyAuthAccessToken } from "../../src/services/auth-access-token";
import {
  accessTokenPayload,
  authorizeOfficialInstall,
  authorizeWithOverrides,
  createOAuthFixture,
  OAuthFixtureError,
  OFFICIAL_CLIENT_ID,
  OFFICIAL_REDIRECT_URI,
  OTHER_CLIENT_ID,
  OTHER_REDIRECT_URI,
} from "./quicklogin-oauth-fixture";

beforeAll(async () => applyD1Migrations(env.DATABASE, env.TEST_MIGRATIONS));
beforeEach(async () => {
  for (const table of [
    "oauthAccessToken", "oauthRefreshToken", "oauthConsent", "oauthClient",
    "session", "account", "user", "jwks", "rateLimit",
  ]) await env.DATABASE.prepare(`DELETE FROM ${table}`).run();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("quicklogin OAuth grants", () => {
  it("keeps valid device tokens usable after repeated local JWKS verification", async () => {
    const fixture = await createOAuthFixture(env);
    const install = await authorizeOfficialInstall(fixture, { websiteSession: fixture.websiteSession });
    for (let attempt = 1; attempt <= 35; attempt++) {
      const outcome = await verifyQuickloginBearer(install.request(), env)
        .then(principal => ({ userId: principal.userId }), error => ({ code: error.code }));
      expect(outcome, `verification ${attempt}`).toEqual({ userId: fixture.websiteSession.userId });
    }
    // Public traffic keeps its protection, even when its bucket is exhausted.
    const jwksRequest = () => new Request(`${env.BETTER_AUTH_URL}/api/v1/auth/jwks`);
    for (let attempt = 0; attempt < 30; attempt++) {
      expect((await fixture.authHandler(jwksRequest())).status).toBe(200);
    }
    expect((await fixture.authHandler(jwksRequest())).status).toBe(429);
    await expect(verifyQuickloginBearer(install.request(), env)).resolves
      .toMatchObject({ userId: fixture.websiteSession.userId });
  });

  it("creates a distinct live grant per consent and preserves it across refresh", async () => {
    const fixture = await createOAuthFixture(env);
    const first = await authorizeOfficialInstall(fixture, { websiteSession: fixture.websiteSession });
    const second = await authorizeOfficialInstall(fixture, { websiteSession: fixture.websiteSession });
    const claims = accessTokenPayload(first);
    expect(claims).toMatchObject({
      iss: `${env.BETTER_AUTH_URL}/api/auth`,
      aud: expect.arrayContaining([`${env.BETTER_AUTH_URL}/api/auth`]),
      azp: OFFICIAL_CLIENT_ID,
      scope: expect.stringContaining("cqu:quicklogin:device"),
      ql_grant: expect.any(String),
    });
    expect((claims.ql_grant as string).length).toBeGreaterThan(0);
    const token = first.request().headers.get("authorization")!.slice("Bearer ".length);
    await expect(verifyAuthAccessToken(token, env)).resolves.toMatchObject({
      iss: `${env.BETTER_AUTH_URL}/api/auth`,
      azp: OFFICIAL_CLIENT_ID,
      ql_grant: claims.ql_grant,
    });
    const firstPrincipal = await verifyQuickloginBearer(first.request(), env);
    const secondPrincipal = await verifyQuickloginBearer(second.request(), env);
    expect(firstPrincipal.grantId).not.toBe(secondPrincipal.grantId);
    const rotated = await first.refresh();
    await expect(verifyQuickloginBearer(rotated.request(), env))
      .resolves.toMatchObject({ grantId: firstPrincipal.grantId });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 51_000);
    const replayed = await first.refresh();
    expect(replayed.request().headers.get("authorization"))
      .toBe(rotated.request().headers.get("authorization"));
    const counts = await env.DATABASE.prepare(`SELECT COUNT(*) AS total, SUM(revoked IS NULL) AS live
      FROM oauthRefreshToken WHERE referenceId = ?`).bind(firstPrincipal.grantId).first();
    expect(counts).toEqual({ total: 2, live: 1 });
    vi.setSystemTime(Date.now() + 10_000);
    await expect(first.refresh()).rejects.toMatchObject({ stage: "refresh" });
    await expect(second.refresh()).resolves.toBeDefined();
  });

  it.each(["session-ended", "session-expired", "user-banned"])(
    "rejects cached refresh responses after %s", async (change) => {
      const fixture = await createOAuthFixture(env);
      const install = await authorizeOfficialInstall(fixture, { websiteSession: fixture.websiteSession });
      const rotated = await install.refresh();
      if (change === "session-ended") {
        await env.DATABASE.prepare('DELETE FROM session WHERE userId = ?')
          .bind(fixture.websiteSession.userId).run();
      } else if (change === "session-expired") {
        await env.DATABASE.prepare('UPDATE session SET expiresAt = ? WHERE userId = ?')
          .bind(Date.now() - 1_000, fixture.websiteSession.userId).run();
      } else {
        await env.DATABASE.prepare('UPDATE user SET banned = 1 WHERE id = ?')
          .bind(fixture.websiteSession.userId).run();
      }
      await expect(install.refresh()).rejects.toMatchObject({ stage: "refresh" });
      await expect(rotated.refresh()).rejects.toMatchObject({ stage: "refresh" });
    }
  );

  it.each([
    ["scope", "openid"], ["resource", "https://unregistered.example"], ["client_id", OTHER_CLIENT_ID],
  ])("rejects changed %s during response replay", async (field, value) => {
    const fixture = await createOAuthFixture(env);
    const install = await authorizeOfficialInstall(fixture, { websiteSession: fixture.websiteSession });
    const rotated = await install.refresh();
    const handler = fixture.authHandler;
    fixture.authHandler = async request => {
      const body = new URLSearchParams();
      for (const [key, entry] of await request.formData()) body.append(key, String(entry));
      body.set(field, value);
      return handler(new Request(request.url, { method: "POST", headers: request.headers, body }));
    };
    await expect(install.refresh()).rejects.toMatchObject({ stage: "refresh" });
    fixture.authHandler = handler;
    expect((await install.refresh()).request().headers.get("authorization"))
      .toBe(rotated.request().headers.get("authorization"));
  });

  it("does not replay a response after native OAuth revocation", async () => {
    const fixture = await createOAuthFixture(env);
    const handler = fixture.authHandler;
    let currentRefresh = "";
    fixture.authHandler = async request => {
      const result = await handler(request);
      if (request.url.endsWith("/token") && result.ok) {
        currentRefresh = (await result.clone().json<{ refresh_token: string }>()).refresh_token;
      }
      return result;
    };
    const install = await authorizeOfficialInstall(fixture, { websiteSession: fixture.websiteSession });
    const rotated = await install.refresh();
    const result = await handler(new Request(`${env.BETTER_AUTH_URL}/api/v1/auth/oauth2/revoke`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: OFFICIAL_CLIENT_ID,
        token: currentRefresh, token_type_hint: "refresh_token" }),
    }));
    expect(result.status).toBe(200);
    await expect(install.refresh()).rejects.toMatchObject({ stage: "refresh" });
    await expect(rotated.refresh()).rejects.toMatchObject({ stage: "refresh" });
  });

  it("keeps ordinary clients on strict refresh rotation", async () => {
    const fixture = await createOAuthFixture(env);
    const install = await authorizeWithOverrides(fixture, {
      websiteSession: fixture.websiteSession, clientId: OTHER_CLIENT_ID,
      redirectUri: OTHER_REDIRECT_URI, scopes: ["openid", "offline_access"],
    });
    const rotated = await install.refresh();
    await expect(install.refresh()).rejects.toMatchObject({
      stage: "refresh", status: 400, oauthError: "invalid_grant",
    });
    await expect(rotated.refresh()).rejects.toMatchObject({
      stage: "refresh", status: 400, oauthError: "invalid_grant",
    });
  });

  it("rejects missing PKCE, wrong verifier, unregistered redirect, and non-official azp", async () => {
    const fixture = await createOAuthFixture(env);
    await expect(authorizeWithOverrides(fixture, {
      websiteSession: fixture.websiteSession, verifier: null,
    })).rejects.toMatchObject({ stage: "authorize" });
    await expect(authorizeWithOverrides(fixture, {
      websiteSession: fixture.websiteSession,
      exchangeVerifier: "wrong-verifier-which-is-long-enough-0123456789",
    })).rejects.toMatchObject({ stage: "token" });
    await expect(authorizeWithOverrides(fixture, {
      websiteSession: fixture.websiteSession,
      redirectUri: "https://attacker.example/callback",
    })).rejects.toBeInstanceOf(OAuthFixtureError);
    await expect(authorizeWithOverrides(fixture, {
      websiteSession: fixture.websiteSession,
      clientId: OTHER_CLIENT_ID,
      redirectUri: OTHER_REDIRECT_URI,
    })).rejects.toMatchObject({ stage: "token" });
  });

  it("keeps ordinary OAuth claims and rejects them as device principals", async () => {
    const fixture = await createOAuthFixture(env);
    const ordinary = await authorizeWithOverrides(fixture, {
      websiteSession: fixture.websiteSession,
      clientId: OTHER_CLIENT_ID,
      redirectUri: OTHER_REDIRECT_URI,
      scopes: ["openid", "offline_access"],
    });
    const payload = accessTokenPayload(ordinary);
    expect(payload).not.toHaveProperty("ql_grant");
    expect(payload.caps).toHaveProperty("calendar");
    await expect(verifyQuickloginBearer(ordinary.request(), env))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("revokes only one OAuth family while leaving website session and sibling grant live", async () => {
    const fixture = await createOAuthFixture(env);
    const first = await authorizeOfficialInstall(fixture, { websiteSession: fixture.websiteSession });
    const second = await authorizeOfficialInstall(fixture, { websiteSession: fixture.websiteSession });
    const firstPrincipal = await verifyQuickloginBearer(first.request(), env);
    const secondPrincipal = await verifyQuickloginBearer(second.request(), env);
    const rotated = await first.refresh();
    const accounts = new QuickloginAccountClient(env);
    const device = await accounts.registerDevice(fixture.websiteSession.userId, firstPrincipal.grantId, {
      deviceName: "First Synthetic Chrome", browserFamily: "chrome", browserVersion: "140",
    });
    await accounts.revokeDevice(fixture.websiteSession.userId, device.deviceId, Date.now());
    await revokeProviderGrantFamily(env, fixture.websiteSession.userId,
      OFFICIAL_CLIENT_ID, firstPrincipal.grantId);
    await expect(verifyQuickloginBearer(first.request(), env))
      .rejects.toMatchObject({ code: "DEVICE_REVOKED" });
    await expect(first.refresh()).rejects.toMatchObject({ stage: "refresh" });
    await expect(rotated.refresh()).rejects.toMatchObject({ stage: "refresh" });
    await expect(verifyQuickloginBearer((await second.refresh()).request(), env))
      .resolves.toMatchObject({ grantId: secondPrincipal.grantId });
    const session = await fixture.authHandler(new Request(
      "http://localhost:8787/api/v1/auth/get-session", { headers: fixture.websiteSession.headers }
    ));
    expect(session.status).toBe(200);
  });
});
