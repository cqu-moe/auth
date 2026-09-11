import { applyD1Migrations, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickloginAccountClient } from "../../src/services/quicklogin/account-client";
import { revokeProviderGrantFamily } from "../../src/services/quicklogin/oauth-grants";
import { verifyQuickloginBearer } from "../../src/middleware/quicklogin-device-auth";
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
  type OAuthFixture,
} from "./quicklogin-oauth-fixture";

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of [
    "oauthAccessToken",
    "oauthRefreshToken",
    "oauthConsent",
    "oauthClient",
    "session",
    "account",
    "user",
    "jwks",
  ]) {
    await env.DATABASE.prepare(`DELETE FROM ${table}`).run();
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

function routeJwks(fixture: OAuthFixture): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (
      url.origin === "http://localhost:8787" &&
      url.pathname === "/api/auth/jwks"
    ) {
      return fixture.authHandler(request);
    }
    throw new Error(`unexpected fetch target: ${url.origin}${url.pathname}`);
  });
}

describe("quicklogin OAuth grants", () => {
  it("creates distinct grants for two installs in one website session and preserves each on refresh", async () => {
    const fixture = await createOAuthFixture(env);
    routeJwks(fixture);

    const first = await authorizeOfficialInstall(fixture, {
      websiteSession: fixture.websiteSession,
    });
    const second = await authorizeOfficialInstall(fixture, {
      websiteSession: fixture.websiteSession,
    });
    expect(accessTokenPayload(first)).toMatchObject({
      iss: env.BETTER_AUTH_URL,
      aud: expect.arrayContaining([env.BETTER_AUTH_URL]),
      azp: OFFICIAL_CLIENT_ID,
      scope: expect.stringContaining("cqu:quicklogin:device"),
    });
    const firstPrincipal = await verifyQuickloginBearer(first.request(), env);
    const secondPrincipal = await verifyQuickloginBearer(second.request(), env);

    expect(firstPrincipal.grantId).not.toBe(secondPrincipal.grantId);
    const refreshed = await first.refresh();
    await expect(verifyQuickloginBearer(refreshed.request(), env)).resolves.toMatchObject({
      grantId: firstPrincipal.grantId,
    });
    await expect(first.refresh()).rejects.toMatchObject({ stage: "refresh" });
    await expect(second.refresh()).resolves.toBeDefined();
  });

  it("verifies an issued device token without fetching JWKS through the public WAF", async () => {
    const fixture = await createOAuthFixture(env);
    const install = await authorizeOfficialInstall(fixture, {
      websiteSession: fixture.websiteSession,
    });
    const publicFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("challenge", { status: 403 })
    );

    await expect(verifyQuickloginBearer(install.request(), env)).resolves
      .toMatchObject({ clientId: OFFICIAL_CLIENT_ID });
    expect(publicFetch).not.toHaveBeenCalled();
  });

  it("rejects missing PKCE, a wrong verifier, and an unregistered redirect", async () => {
    const fixture = await createOAuthFixture(env);

    await expect(
      authorizeWithOverrides(fixture, {
        websiteSession: fixture.websiteSession,
        verifier: null,
      })
    ).rejects.toMatchObject({ stage: "authorize" });
    await expect(
      authorizeWithOverrides(fixture, {
        websiteSession: fixture.websiteSession,
        exchangeVerifier: "wrong-verifier-which-is-long-enough-0123456789",
      })
    ).rejects.toMatchObject({ stage: "token" });
    await expect(
      authorizeWithOverrides(fixture, {
        websiteSession: fixture.websiteSession,
        redirectUri: "https://attacker.example/callback",
      })
    ).rejects.toBeInstanceOf(OAuthFixtureError);
  });

  it("does not issue a device token to a non-official client", async () => {
    const fixture = await createOAuthFixture(env);

    await expect(
      authorizeWithOverrides(fixture, {
        websiteSession: fixture.websiteSession,
        clientId: OTHER_CLIENT_ID,
        redirectUri: OTHER_REDIRECT_URI,
      })
    ).rejects.toMatchObject({ stage: "token" });
  });

  it("keeps an ordinary OAuth client flow free of ql_grant", async () => {
    const fixture = await createOAuthFixture(env);
    routeJwks(fixture);
    const ordinary = await authorizeWithOverrides(fixture, {
      websiteSession: fixture.websiteSession,
      clientId: OTHER_CLIENT_ID,
      redirectUri: OTHER_REDIRECT_URI,
      scopes: ["openid", "offline_access"],
    });

    const payload = accessTokenPayload(ordinary);
    expect(payload).not.toHaveProperty("ql_grant");
    expect(payload.caps).toHaveProperty("calendar");
    await expect(
      verifyQuickloginBearer(ordinary.request(), env)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects the target grant immediately while preserving another install and the website session", async () => {
    const fixture = await createOAuthFixture(env);
    routeJwks(fixture);
    const first = await authorizeOfficialInstall(fixture, {
      websiteSession: fixture.websiteSession,
    });
    const second = await authorizeOfficialInstall(fixture, {
      websiteSession: fixture.websiteSession,
    });
    const firstPrincipal = await verifyQuickloginBearer(first.request(), env);
    const secondPrincipal = await verifyQuickloginBearer(second.request(), env);
    const accounts = new QuickloginAccountClient(env);
    const firstDevice = await accounts.registerDevice(
      fixture.websiteSession.userId,
      firstPrincipal.grantId,
      {
        deviceName: "First Synthetic Chrome",
        browserFamily: "chrome",
        browserVersion: "140",
      }
    );

    await accounts.revokeDevice(
      fixture.websiteSession.userId,
      firstDevice.deviceId,
      Date.now()
    );
    await revokeProviderGrantFamily(
      env,
      fixture.websiteSession.userId,
      OFFICIAL_CLIENT_ID,
      firstPrincipal.grantId
    );

    await expect(verifyQuickloginBearer(first.request(), env)).rejects.toMatchObject({
      code: "DEVICE_REVOKED",
    });
    await expect(first.refresh()).rejects.toMatchObject({ stage: "refresh" });
    await expect(second.refresh()).resolves.toBeDefined();
    await expect(verifyQuickloginBearer(second.request(), env)).resolves.toMatchObject({
      grantId: secondPrincipal.grantId,
    });

    const sessionResponse = await fixture.authHandler(
      new Request("http://localhost:8787/api/auth/get-session", {
        headers: fixture.websiteSession.headers,
      })
    );
    expect(sessionResponse.ok).toBe(true);
    await expect(sessionResponse.json()).resolves.toMatchObject({
      user: { id: fixture.websiteSession.userId },
      session: { userId: fixture.websiteSession.userId },
      caps: expect.not.objectContaining({ cqu: expect.anything() }),
    });
  });

  it("revokes every provider row across pages for only the selected grant", async () => {
    const fixture = await createOAuthFixture(env);
    routeJwks(fixture);
    const install = await authorizeOfficialInstall(fixture, {
      websiteSession: fixture.websiteSession,
    });
    const principal = await verifyQuickloginBearer(install.request(), env);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60 * 60_000);

    const statements = [];
    for (let index = 0; index < 100; index += 1) {
      statements.push(
        env.DATABASE.prepare(
          `INSERT INTO oauthRefreshToken
             (id, token, clientId, sessionId, userId, referenceId,
              expiresAt, createdAt, revoked, authTime, scopes)
           VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, ?)`
        ).bind(
          crypto.randomUUID(),
          `synthetic-refresh-hash-${index}-${crypto.randomUUID()}`,
          OFFICIAL_CLIENT_ID,
          fixture.websiteSession.userId,
          principal.grantId,
          expiresAt.toISOString(),
          now.toISOString(),
          JSON.stringify(["openid", "offline_access", "cqu:quicklogin:device"])
        )
      );
    }
    await env.DATABASE.batch(statements);

    await revokeProviderGrantFamily(
      env,
      fixture.websiteSession.userId,
      OFFICIAL_CLIENT_ID,
      principal.grantId
    );

    const remaining = await env.DATABASE.prepare(
      `SELECT COUNT(*) AS count FROM oauthRefreshToken
       WHERE userId = ? AND clientId = ? AND referenceId = ? AND revoked IS NULL`
    )
      .bind(
        fixture.websiteSession.userId,
        OFFICIAL_CLIENT_ID,
        principal.grantId
      )
      .first<{ count: number }>();
    expect(remaining?.count).toBe(0);
  });

  it("keeps a revoked grant denied when refresh races provider cleanup", async () => {
    const fixture = await createOAuthFixture(env);
    routeJwks(fixture);
    const install = await authorizeOfficialInstall(fixture, {
      websiteSession: fixture.websiteSession,
    });
    const principal = await verifyQuickloginBearer(install.request(), env);
    const accounts = new QuickloginAccountClient(env);
    const device = await accounts.registerDevice(
      fixture.websiteSession.userId,
      principal.grantId,
      {
        deviceName: "Race Synthetic Chrome",
        browserFamily: "chrome",
        browserVersion: "140",
      }
    );
    await accounts.revokeDevice(
      fixture.websiteSession.userId,
      device.deviceId,
      Date.now()
    );

    const [, refresh] = await Promise.allSettled([
      revokeProviderGrantFamily(
        env,
        fixture.websiteSession.userId,
        OFFICIAL_CLIENT_ID,
        principal.grantId
      ),
      install.refresh(),
    ]);
    const request =
      refresh.status === "fulfilled" ? refresh.value.request() : install.request();
    await expect(verifyQuickloginBearer(request, env)).rejects.toMatchObject({
      code: "DEVICE_REVOKED",
    });
    await revokeProviderGrantFamily(
      env,
      fixture.websiteSession.userId,
      OFFICIAL_CLIENT_ID,
      principal.grantId
    );
  });
});
