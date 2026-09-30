import { makeSignature } from "better-auth/crypto";
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuth } from "../../src/auth";
import {
  authorizeWithOverrides,
  createOAuthFixture,
  type OAuthFixture,
  OTHER_CLIENT_ID,
  OTHER_REDIRECT_URI,
} from "./quicklogin-oauth-fixture";
import { createApiFixture } from "./api-fixture";

const SCOPES = ["openid", "offline_access"];

beforeAll(async () => applyD1Migrations(env.DATABASE, env.TEST_MIGRATIONS));
beforeEach(async () => {
  for (const table of [
    "oauthAccessToken", "oauthRefreshToken", "oauthConsent", "oauthClient",
    "session", "account", "user", "jwks",
  ]) await env.DATABASE.prepare(`DELETE FROM ${table}`).run();
});

async function authorizeInstall(fixture: OAuthFixture) {
  return authorizeWithOverrides(fixture, {
    websiteSession: fixture.websiteSession,
    clientId: OTHER_CLIENT_ID,
    redirectUri: OTHER_REDIRECT_URI,
    scopes: SCOPES,
  });
}

// The fixture user has no password account, so grant it superAdmin and mint a
// fresh session cookie to call admin endpoints (same trick the fixture uses).
async function superAdminHeaders(): Promise<Headers> {
  const auth = createAuth(env, new Request(`${env.BETTER_AUTH_URL}/api/v1/auth/get-session`));
  const ctx = await auth.$context;
  const now = new Date();
  const adminId = crypto.randomUUID();
  await ctx.adapter.create({
    model: "user",
    forceAllowId: true,
    data: {
      id: adminId,
      name: "Ban Admin",
      email: `${adminId}@example.com`,
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
      role: "superAdmin",
      banned: false,
      banReason: null,
      banExpires: null,
      twoFactorEnabled: false,
    },
  });
  const session = await ctx.internalAdapter.createSession(adminId);
  if (!session) throw new Error("failed to create admin session");
  const signature = await makeSignature(session.token, env.BETTER_AUTH_SECRET);
  return new Headers({
    cookie: `${ctx.authCookies.sessionToken.name}=${session.token}.${signature}`,
  });
}

async function tokenRows(userId: string) {
  const access = await env.DATABASE
    .prepare("SELECT COUNT(*) AS n FROM oauthAccessToken WHERE userId = ?")
    .bind(userId).first<{ n: number }>();
  const refresh = await env.DATABASE
    .prepare(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN revoked IS NULL THEN 1 ELSE 0 END) AS live " +
      "FROM oauthRefreshToken WHERE userId = ?"
    )
    .bind(userId).first<{ total: number; live: number }>();
  return { access: access?.n ?? 0, refresh };
}

async function banViaNativeEndpoint(fixture: OAuthFixture, userId: string) {
  const headers = await superAdminHeaders();
  headers.set("content-type", "application/json");
  headers.set("origin", env.BETTER_AUTH_URL);
  const response = await fixture.authHandler(
    new Request(`${env.BETTER_AUTH_URL}/api/v1/auth/admin/ban-user`, {
      method: "POST",
      headers,
      body: JSON.stringify({ userId }),
    })
  );
  expect(response.status, await response.clone().text()).toBe(200);
}

describe("ban revokes OAuth tokens (issue #22)", () => {
  it("native /admin/ban-user cascades tokens and blocks the refresh grant", async () => {
    const fixture = await createOAuthFixture(env);
    const userId = fixture.websiteSession.userId;
    const install = await authorizeInstall(fixture);
    const live = await install.refresh();
    const before = await tokenRows(userId);
    expect(before.refresh?.total).toBeGreaterThan(0);

    await banViaNativeEndpoint(fixture, userId);

    const after = await tokenRows(userId);
    expect(after.access).toBe(0);
    expect(after.refresh?.live).toBe(0);
    await expect(live.refresh()).rejects.toMatchObject({ stage: "refresh", status: 400 });

    // Defense in depth: even a surviving (pre-cascade) refresh row must fail
    // closed for a banned user at the /oauth2/token gate.
    await env.DATABASE
      .prepare("UPDATE oauthRefreshToken SET revoked = NULL WHERE userId = ?")
      .bind(userId).run();
    await expect(live.refresh()).rejects.toMatchObject({ stage: "refresh", status: 400 });
  });

  it("v1 admin PATCH banned:true cascades tokens and blocks the refresh grant", async () => {
    const fixture = await createOAuthFixture(env);
    const userId = fixture.websiteSession.userId;
    const install = await authorizeInstall(fixture);
    const live = await install.refresh();

    const api = await createApiFixture();
    const headers = await api.signIn("superAdmin");
    headers.set("content-type", "application/json");
    const response = await api.request(`/api/v1/admin/users/${userId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ banned: true }),
    });
    expect(response.status).toBe(200);

    const after = await tokenRows(userId);
    expect(after.access).toBe(0);
    expect(after.refresh?.live).toBe(0);
    await expect(live.refresh()).rejects.toMatchObject({ stage: "refresh", status: 400 });
  });
});
