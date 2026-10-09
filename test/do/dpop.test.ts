import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { SignJWT, generateKeyPair, exportJWK } from "jose";
import { deriveDpopAth } from "better-auth/oauth2";
import { verifyAuthAccessToken, verifyAuthAccessTokenRequest } from "../../src/services/auth-access-token";
import { verifyQuickloginBearer } from "../../src/middleware/quicklogin-device-auth";
import { authorizeOfficialInstall, createOAuthFixture } from "./quicklogin-oauth-fixture";

beforeAll(() => applyD1Migrations(env.DATABASE, env.TEST_MIGRATIONS));
beforeEach(async () => {
  for (const table of ["oauthAccessToken", "oauthRefreshToken", "oauthConsent", "oauthClient", "session", "account", "user", "jwks", "verification"])
    await env.DATABASE.prepare(`DELETE FROM ${table}`).run();
});
async function key() {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(pair.publicKey);
  return { pair, jwk };
}
async function proof(k: Awaited<ReturnType<typeof key>>, request: Request, token?: string, claims = {}) {
  return new SignJWT({ htm: request.method, htu: request.url.split("?")[0],
    ...(token ? { ath: await deriveDpopAth(token) } : {}), ...claims })
    .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: k.jwk })
    .setIssuedAt((claims as { iat?: number }).iat ?? Math.floor(Date.now() / 1000)).setJti(crypto.randomUUID()).sign(k.pair.privateKey);
}
it("issues opt-in DPoP, rejects bare-token downgrade and accepts proof on QuickLogin", async () => {
  const fixture = await createOAuthFixture(env);
  const k = await key();
  const handler = fixture.authHandler;
  fixture.authHandler = async request => {
    if (request.url.endsWith("/token")) request.headers.set("DPoP", await proof(k, request));
    return handler(request);
  };
  const install = await authorizeOfficialInstall(fixture, { websiteSession: fixture.websiteSession });
  const request = install.request();
  const token = request.headers.get("authorization")!.slice(7);
  await expect(verifyAuthAccessToken(token, env)).rejects.toThrow();
  request.headers.set("authorization", `DPoP ${token}`);
  request.headers.set("DPoP", await proof(k, request, token));
  await expect(verifyQuickloginBearer(request, env)).resolves.toMatchObject({ userId: fixture.websiteSession.userId });
  const { createApp } = await import("../../src/app");
  const userinfo = new Request(`${env.BETTER_AUTH_URL}/api/v1/auth/oauth2/userinfo`, { headers: { authorization: `DPoP ${token}` } });
  userinfo.headers.set("dpop", await proof(k, userinfo, token));
  expect((await createApp().fetch(userinfo.clone(), env)).status).toBe(200);
  expect((await createApp().fetch(userinfo.clone(), env)).status).toBe(401);
  await env.DATABASE.prepare("DELETE FROM session WHERE userId = ?").bind(fixture.websiteSession.userId).run();
  userinfo.headers.set("dpop", await proof(k, userinfo, token));
  expect((await createApp().fetch(userinfo, env)).status).toBe(401);
  request.headers.set("dpop", await proof(k, request, token));
  await expect(verifyQuickloginBearer(request, env)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});

it("atomically rejects duplicate proofs across fresh verifier contexts and rejects request/key/hash tampering", async () => {
  const fixture = await createOAuthFixture(env);
  const k = await key();
  const handler = fixture.authHandler;
  fixture.authHandler = async request => {
    if (request.url.endsWith("/token")) request.headers.set("DPoP", await proof(k, request));
    return handler(request);
  };
  const install = await authorizeOfficialInstall(fixture, { websiteSession: fixture.websiteSession });
  const base = install.request();
  const token = base.headers.get("authorization")!.slice(7);
  base.headers.set("authorization", `DPoP ${token}`);
  for (const claims of [{ htm: "POST" }, { htu: "https://attacker.invalid/" }, { ath: "wrong" }, { iat: Math.floor(Date.now() / 1000) - 600 }]) {
    base.headers.set("dpop", await proof(k, base, token, claims));
    await expect(verifyAuthAccessTokenRequest(base.clone(), env)).rejects.toThrow();
  }
  base.headers.set("dpop", await proof(await key(), base, token));
  await expect(verifyAuthAccessTokenRequest(base.clone(), env)).rejects.toThrow();
  base.headers.delete("dpop");
  await expect(verifyAuthAccessTokenRequest(base.clone(), env)).rejects.toThrow();
  base.headers.set("dpop", await proof(k, base, token));
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => verifyAuthAccessTokenRequest(base.clone(), env)));
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(result => result.status === "rejected")).toHaveLength(7);
  const reservations = await env.DATABASE.prepare("SELECT id FROM verification WHERE identifier LIKE 'dpop-proof:%'").all();
  expect(reservations.results.length).toBeGreaterThan(0);
  const refreshed = await install.refresh();
  const refreshedToken = refreshed.request().headers.get("authorization")!.slice(7);
  await expect(verifyAuthAccessToken(refreshedToken, env)).rejects.toThrow();
  const wrong = await key();
  fixture.authHandler = async request => {
    if (request.url.endsWith("/token")) request.headers.set("DPoP", await proof(wrong, request));
    return handler(request);
  };
  await expect(refreshed.refresh()).rejects.toMatchObject({ stage: "refresh" });
  fixture.authHandler = handler;
  await expect(refreshed.refresh()).rejects.toMatchObject({ stage: "refresh" });
});

it("interoperates with oauth4webapi code exchange, same-key refresh and HTTP resource requests", async () => {
  const oauth = await import("oauth4webapi");
  const { createApp } = await import("../../src/app");
  const app = createApp();
  const fixture = await createOAuthFixture(env);
  const client = { client_id: "quicklogin-test-client", [oauth.clockSkew]: 0, id_token_signed_response_alg: "EdDSA" };
  const as = { issuer: `${env.BETTER_AUTH_URL}/api/auth`, token_endpoint: `${env.BETTER_AUTH_URL}/api/v1/auth/oauth2/token` };
  const DPoP = oauth.DPoP(client, await oauth.generateKeyPair("ES256"));
  const handler = fixture.authHandler;
  const tokenTypes: string[] = [];
  fixture.authHandler = async request => {
    if (!request.url.endsWith("/token")) return handler(request);
    const body = new URLSearchParams(await request.text());
    const options = { DPoP, [oauth.allowInsecureRequests]: true,
      [oauth.customFetch]: async (url: string, init: RequestInit) => {
        const internal = new URL(url); internal.host = "internal.worker:3000";
        return app.fetch(new Request(internal, init), env);
      },
      additionalParameters: { resource: `${env.BETTER_AUTH_URL}/api/auth` } };
    let response: Response;
    if (body.get("grant_type") === "authorization_code") {
      const callback = new URL(`https://quicklogin-test.chromiumapp.org/?code=${body.get("code")}`);
      const params = oauth.validateAuthResponse(as, client, callback, oauth.expectNoState);
      response = await oauth.authorizationCodeGrantRequest(as, client, oauth.None(), params,
        body.get("redirect_uri")!, body.get("code_verifier")!, options);
      const result = await oauth.processAuthorizationCodeResponse(as, client, response.clone());
      tokenTypes.push(result.token_type);
    } else {
      response = await oauth.refreshTokenGrantRequest(as, client, oauth.None(), body.get("refresh_token")!, options);
      const result = await oauth.processRefreshTokenResponse(as, client, response.clone());
      tokenTypes.push(result.token_type);
    }
    return response;
  };
  const install = await authorizeOfficialInstall(fixture, { websiteSession: fixture.websiteSession });
  const refreshed = await install.refresh();
  expect(tokenTypes).toEqual(["dpop", "dpop"]);
  for (const entry of [install, refreshed]) {
    const resource = new Request(`${env.BETTER_AUTH_URL}/api/v1/cqu/quicklogin/devices`, { headers: entry.request().headers });
    const token = resource.headers.get("authorization")!.slice(7);
    const response = await oauth.protectedResourceRequest(token, "POST", new URL(resource.url), new Headers({ "content-type": "application/json", origin: env.QUICKLOGIN_EXTENSION_ORIGIN }), JSON.stringify({ deviceName: "DPoP Chrome", browserFamily: "chrome", browserVersion: "140" }), {
      DPoP, [oauth.allowInsecureRequests]: true,
      [oauth.customFetch]: async (url, init) => app.fetch(new Request(url, init), env),
    });
    expect(response.status).toBe(200);
  }
});

it("enforces opt-in client policy, atomically reserves AS proofs and cleans expired reservations", async () => {
  const { createAuth } = await import("../../src/auth");
  const fixture = await createOAuthFixture(env);
  const { internalAdapter } = await createAuth(env, new Request(env.BETTER_AUTH_URL)).$context;
  const { createApiFixture } = await import("./api-fixture");
  const api = await createApiFixture();
  const admin = await api.signIn("superAdmin");
  admin.set("content-type", "application/json");
  const configured = await api.request("/api/v1/admin/oauth-clients/quicklogin-test-client", {
    method: "PATCH", headers: admin, body: JSON.stringify({ dpop_bound_access_tokens: true }),
  });
  expect(configured.status).toBe(200);
  await expect(authorizeOfficialInstall(fixture, { websiteSession: fixture.websiteSession })).rejects.toMatchObject({ stage: "token" });
  const k = await key();
  const handler = fixture.authHandler;
  let successes = 0;
  fixture.authHandler = async request => {
    if (!request.url.endsWith("/token")) return handler(request);
    request.headers.set("DPoP", await proof(k, request));
    const results = await Promise.all([handler(request.clone()), handler(request.clone())]);
    successes += results.filter(r => r.ok).length;
    expect(results.filter(r => r.ok)).toHaveLength(1);
    return results.find(r => r.ok)!;
  };
  const install = await authorizeOfficialInstall(fixture, { websiteSession: fixture.websiteSession });
  await install.refresh();
  expect(successes).toBe(2);
  await env.DATABASE.prepare("UPDATE verification SET expiresAt = ? WHERE identifier LIKE 'dpop-proof:%'").bind(Date.now() - 1000).run();
  await internalAdapter.findVerificationValue("cleanup-trigger");
  expect(await env.DATABASE.prepare("SELECT COUNT(*) AS count FROM verification WHERE identifier LIKE 'dpop-proof:%'").first("count")).toBe(0);
});
