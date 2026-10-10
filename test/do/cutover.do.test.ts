import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { createApiFixture } from "./api-fixture";
import { createApp } from "../../src/app";

it("issues a new host-only production credential and refuses old root-domain names and sibling mutation origins", async () => {
  const fixture = await createApiFixture(); const headers = await fixture.signIn("user");
  const session = await (await fixture.request("/api/v1/auth/get-session", { headers })).json() as { user: { email: string } };
  const origin = "https://auth.cqu.moe"; const app = createApp(); const production = { ...env, BETTER_AUTH_URL: origin };
  const signin = await app.request(`${origin}/api/v1/auth/sign-in/email`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ email: session.user.email, password: "local-test-password" }) }, production);
  expect(signin.status).toBe(200);
  const cookies = (signin.headers as Headers & { getSetCookie(): string[] }).getSetCookie();
  const credential = cookies.find(cookie => cookie.startsWith("__Host-auth-v2.session_token="));
  expect(credential).toBeDefined(); expect(credential).toContain("Secure"); expect(credential).toContain("HttpOnly"); expect(credential).toContain("Path=/"); expect(credential).not.toMatch(/Domain=/i);
  const signed = credential!.split(";")[0].split(/=(.*)/s)[1];
  const legacy = `__Secure-better-auth.session_token=${signed}`;
  const rejected = await app.request(`${origin}/api/v1/auth/get-session`, { headers: { cookie: legacy } }, production);
  expect(await rejected.json()).toBeNull();
  expect(rejected.headers.get("set-cookie")).toContain("Domain=cqu.moe");
  for (const cookie of [`${legacy}; ${credential!.split(";")[0]}`, `${credential!.split(";")[0]}; ${legacy}`]) {
    expect(await (await app.request(`${origin}/api/v1/auth/get-session`, { headers: { cookie } }, production)).json()).not.toBeNull();
  }
  const denied = await app.request(`${origin}/api/v1/auth/sign-out`, { method: "POST", headers: { origin: "https://compromised.cqu.moe", cookie: credential!.split(";")[0], "content-type": "application/json" }, body: "{}" }, production);
  expect(denied.status).toBe(403);
  const jsonHeaders = { origin, cookie: credential!.split(";")[0], "content-type": "application/json" };
  const post = (path: string, body: unknown, headers = jsonHeaders) => app.request(`${origin}/api/v1/auth${path}`, { method: "POST", headers, body: JSON.stringify(body) }, production);
  expect((await post("/security/challenge", { password: "local-test-password", purpose: "mfa" })).status).toBe(200);
  const options = await app.request(`${origin}/api/v1/auth/passkey/generate-register-options`, { headers: jsonHeaders }, production);
  const challengeCookie = (options.headers as Headers & { getSetCookie(): string[] }).getSetCookie().find(cookie => cookie.startsWith("__Host-auth-v2.better-auth-passkey="));
  expect(challengeCookie).toContain("Secure"); expect(challengeCookie).not.toMatch(/Domain=/i);
  const enrollment = await post("/two-factor/enable", { password: "local-test-password" });
  const { totpURI } = await enrollment.json() as { totpURI: string };
  const { base32 } = await import("@better-auth/utils/base32"); const { createOTP } = await import("@better-auth/utils/otp");
  const secret = new TextDecoder().decode(base32.decode(new URL(totpURI).searchParams.get("secret")!));
  const code = await createOTP(secret).totp();
  expect((await post("/two-factor/verify-totp", { code })).status).toBe(200);
  const pending = await post("/sign-in/email", { email: session.user.email, password: "local-test-password" }, { ...jsonHeaders, cookie: "" });
  const factorCookie = (pending.headers as Headers & { getSetCookie(): string[] }).getSetCookie().find(cookie => cookie.startsWith("__Host-auth-v2.two_factor="));
  expect(factorCookie).toContain("Secure"); expect(factorCookie).not.toMatch(/Domain=/i);
  const trusted = await post("/two-factor/verify-totp", { code, trustDevice: true }, { ...jsonHeaders, cookie: factorCookie!.split(";")[0] });
  const trustCookie = (trusted.headers as Headers & { getSetCookie(): string[] }).getSetCookie().find(cookie => cookie.startsWith("__Host-auth-v2.trust_device="));
  expect(trustCookie).toContain("Secure"); expect(trustCookie).not.toMatch(/Domain=/i);
  const oldTrust = trustCookie!.split(";")[0].replace("__Host-auth-v2.", "__Secure-better-auth.");
  const login = await post("/sign-in/email", { email: session.user.email, password: "local-test-password" }, { ...jsonHeaders, cookie: oldTrust });
  expect(await login.json()).toMatchObject({ twoFactorRedirect: true });

});

it("honors approved first-party authorization despite the installed plugin's prompt=consent and still issues a live device grant", async () => {
  const { createOAuthFixture, authorizeWithOverrides, OTHER_CLIENT_ID, OTHER_REDIRECT_URI, OFFICIAL_CLIENT_ID, OFFICIAL_REDIRECT_URI } = await import("./quicklogin-oauth-fixture");
  const { createAuth } = await import("../../src/auth");
  const extensionOrigin = "chrome-extension://igfidegfgfoofnoncpmbcokbffjmmook";
  const storeOrigin = "chrome-extension://ainapeknaclcpoioimonkodmoakhacjd";
  const extensionEnv = { ...env, QUICKLOGIN_EXTENSION_ORIGIN: extensionOrigin, QUICKLOGIN_STORE_EXTENSION_ORIGIN: storeOrigin };
  const app = createApp();
  const tokenUrl = `${env.BETTER_AUTH_URL}/api/v1/auth/oauth2/token`;
  for (const origin of [extensionOrigin, storeOrigin]) {
  const preflight = await app.request(tokenUrl, { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } }, extensionEnv);
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);
  }
  await createApiFixture();
  const fixture = await createOAuthFixture(env);
  const adapter = (await createAuth(env, new Request(env.BETTER_AUTH_URL)).$context).adapter;
  await adapter.update({ model: "oauthClient", where: [{ field: "clientId", value: OFFICIAL_CLIENT_ID }], update: { skipConsent: true } });
  const verifier = "test-verifier-0123456789012345678901234567890123456789";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const query = new URLSearchParams({ client_id: OFFICIAL_CLIENT_ID, redirect_uri: OFFICIAL_REDIRECT_URI, response_type: "code", scope: "openid offline_access cqu:quicklogin:device", resource: `${env.BETTER_AUTH_URL}/api/auth`, state: "unchanged", prompt: "consent", code_challenge: challenge, code_challenge_method: "S256" });
  for (const [method, origin] of [["GET", extensionOrigin], ["POST", storeOrigin]]) {
    const headers = new Headers(fixture.websiteSession.headers); headers.set("origin", env.BETTER_AUTH_URL); headers.set("content-type", "application/x-www-form-urlencoded");
    const request = new Request(`${env.BETTER_AUTH_URL}/api/v1/auth/oauth2/authorize${method === "GET" ? `?${query}` : ""}`, { method, headers, ...(method === "POST" ? { body: query } : {}) });
    const response = await fixture.authHandler(request);
    const body = await response.clone().json().catch(() => ({})) as { url?: string; redirect_uri?: string };
    const location = response.headers.get("location") ?? body.url ?? body.redirect_uri;
    expect(location, `${method} ${response.status} ${JSON.stringify(body)}`).toBeTruthy();
    const redirect = new URL(location!, env.BETTER_AUTH_URL); expect(redirect.origin, location).toBe(new URL(OFFICIAL_REDIRECT_URI).origin); expect(redirect.searchParams.get("state")).toBe("unchanged");
    expect(redirect.searchParams.get("code"), location).toBeTruthy();
    const token = await app.request(tokenUrl, { method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: OFFICIAL_CLIENT_ID, redirect_uri: OFFICIAL_REDIRECT_URI, code: redirect.searchParams.get("code")!, code_verifier: verifier, resource: `${env.BETTER_AUTH_URL}/api/auth` }) }, extensionEnv);
    expect(token.status, await token.clone().text()).toBe(200);
    expect(token.headers.get("access-control-allow-origin")).toBe(origin);
    expect(token.headers.get("access-control-allow-credentials")).toBeNull();
    const tokens = await token.json() as { access_token: string; refresh_token: string };
    const refreshed = await app.request(tokenUrl, { method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: OFFICIAL_CLIENT_ID, refresh_token: tokens.refresh_token }) }, extensionEnv);
    expect(refreshed.status, await refreshed.clone().text()).toBe(200);
    expect(refreshed.headers.get("access-control-allow-origin")).toBe(origin);
    const refreshedTokens = await refreshed.json() as { access_token: string };
    const deviceUrl = `${env.BETTER_AUTH_URL}/api/v1/cqu/quicklogin/devices`;
    const devicePreflight = await app.request(deviceUrl, { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" } }, extensionEnv);
    expect(devicePreflight.status).toBe(204);
    expect(devicePreflight.headers.get("access-control-allow-origin")).toBe(origin);
    const device = await app.request(deviceUrl, { method: "POST", headers: { origin, authorization: `Bearer ${refreshedTokens.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ deviceName: "Cutover Chrome", browserFamily: "chrome", browserVersion: "140" }) }, extensionEnv);
    expect(device.status, await device.clone().text()).toBe(200);
    expect(device.headers.get("access-control-allow-origin")).toBe(origin);
    expect(device.headers.get("access-control-allow-credentials")).toBeNull();

  }
  // A real third-party consent remains editable; an existing consent becomes
  // non-revocable once the administrator approves that client as first party.
  await authorizeWithOverrides(fixture, { websiteSession: fixture.websiteSession, clientId: OTHER_CLIENT_ID, redirectUri: OTHER_REDIRECT_URI, scopes: ["openid", "offline_access"] });
  const consents = await adapter.findMany<{ id: string; clientId: string }>({ model: "oauthConsent", where: [{ field: "userId", value: fixture.websiteSession.userId }] });
  const consent = consents.find(row => row.clientId === OTHER_CLIENT_ID)!; expect(consent).toBeDefined();
  const consentHeaders = new Headers(fixture.websiteSession.headers); consentHeaders.set("origin", env.BETTER_AUTH_URL); consentHeaders.set("content-type", "application/json");
  const mutateConsent = (path: string, headers = consentHeaders) => fixture.authHandler(new Request(`${env.BETTER_AUTH_URL}/api/v1/auth/oauth2/${path}-consent`, { method: "POST", headers, body: JSON.stringify({ id: consent.id, update: { scopes: ["openid"] } }) }));
  expect((await mutateConsent("update")).status).toBe(200);
  await adapter.update({ model: "oauthClient", where: [{ field: "clientId", value: OTHER_CLIENT_ID }], update: { skipConsent: true } });
  expect((await mutateConsent("update")).status).toBe(403); expect((await mutateConsent("delete")).status).toBe(403);
  const other = await (await createApiFixture()).signIn("user"); other.set("origin", env.BETTER_AUTH_URL); other.set("content-type", "application/json");
  expect((await mutateConsent("delete", other)).status).toBe(401);
  await adapter.update({ model: "oauthClient", where: [{ field: "clientId", value: OTHER_CLIENT_ID }], update: { skipConsent: false } });
  expect((await mutateConsent("delete")).status).toBe(200);
  query.set("prompt", "none consent");
  const invalid = await fixture.authHandler(new Request(`${env.BETTER_AUTH_URL}/api/v1/auth/oauth2/authorize?${query}`, { headers: fixture.websiteSession.headers }));
  expect((invalid.headers.get("location") ?? await invalid.text())).not.toContain("code=");
});

it("the cutover migration invalidates pre-cutover credentials even if their cookie is renamed", async () => {
  const fixture = await createApiFixture(); const headers = await fixture.signIn("user");
  expect(await (await fixture.request("/api/v1/auth/get-session", { headers })).json()).not.toBeNull();
  const { ensureQuickloginOAuthClient } = await import("../../src/services/quicklogin/client-registration");
  const { createAuth } = await import("../../src/auth");
  const adapter = (await createAuth(env, new Request(env.BETTER_AUTH_URL)).$context).adapter;
  const desired = await ensureQuickloginOAuthClient({ QUICKLOGIN_CLIENT_ID: "cqu-quicklogin-chrome", QUICKLOGIN_EXTENSION_ORIGIN: "chrome-extension://igfidegfgfoofnoncpmbcokbffjmmook" }, { findOne: async () => null, create: async ({ data }) => data });
  await adapter.create({ model: "oauthClient", data: { ...desired, skipConsent: false } });
  const migration = env.TEST_MIGRATIONS.find(migration => migration.name === "0013_official_quicklogin_consent.sql")!;
  expect(migration).toBeDefined();
  await env.DATABASE.batch(migration.queries.map(sql => env.DATABASE.prepare(sql)));
  expect(await (await fixture.request("/api/v1/auth/get-session", { headers })).json()).toBeNull();
  expect(await env.DATABASE.prepare("SELECT skipConsent FROM oauthClient WHERE clientId = 'cqu-quicklogin-chrome'").first()).toMatchObject({ skipConsent: 1 });
  await env.DATABASE.prepare("UPDATE oauthClient SET disabled = 1, skipConsent = 0 WHERE clientId = 'cqu-quicklogin-chrome'").run();
  await env.DATABASE.batch(migration.queries.map(sql => env.DATABASE.prepare(sql)));
  expect(await env.DATABASE.prepare("SELECT skipConsent FROM oauthClient WHERE clientId = 'cqu-quicklogin-chrome'").first()).toMatchObject({ skipConsent: 0 });
});
