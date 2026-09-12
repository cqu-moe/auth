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
    "session", "account", "user", "jwks",
  ]) await env.DATABASE.prepare(`DELETE FROM ${table}`).run();
});
afterEach(() => vi.restoreAllMocks());

describe("quicklogin OAuth grants", () => {
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
    await expect(verifyQuickloginBearer((await first.refresh()).request(), env))
      .resolves.toMatchObject({ grantId: firstPrincipal.grantId });
    await expect(first.refresh()).rejects.toMatchObject({ stage: "refresh" });
    await expect(second.refresh()).resolves.toBeDefined();
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
    await expect(verifyQuickloginBearer((await second.refresh()).request(), env))
      .resolves.toMatchObject({ grantId: secondPrincipal.grantId });
    const session = await fixture.authHandler(new Request(
      "http://localhost:8787/api/v1/auth/get-session", { headers: fixture.websiteSession.headers }
    ));
    expect(session.status).toBe(200);
  });
});
