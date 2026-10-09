import { createHMAC } from "@better-auth/utils/hmac";
import { AuthService } from "../../src/rpc";
import { makeSignature, symmetricEncrypt } from "better-auth/crypto";
import { applyD1Migrations, createExecutionContext, env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashOAuthClientSecret } from "../../src/utils/oauth-secret";
import { createAuth } from "../../src/auth";
import { authorizeOfficialInstall, authorizeWithOverrides, createOAuthFixture, OTHER_CLIENT_ID, OTHER_REDIRECT_URI } from "./quicklogin-oauth-fixture";

beforeAll(async () => applyD1Migrations(env.DATABASE, env.TEST_MIGRATIONS));
beforeEach(async () => {
  for (const table of ["oauthAccessToken", "oauthRefreshToken", "oauthConsent", "oauthClient", "session", "account", "user", "jwks"])
    await env.DATABASE.prepare(`DELETE FROM ${table}`).run();
});

describe("interactive device lifetime", () => {
  it("all-device logout ends offline access renewal", async () => {
    const fixture = await createOAuthFixture(env);
    const install = await authorizeWithOverrides(fixture, { websiteSession: fixture.websiteSession, clientId: OTHER_CLIENT_ID,
      redirectUri: OTHER_REDIRECT_URI, scopes: ["openid", "offline_access"] });
    const live = await install.refresh();
    const userinfo = () => fixture.authHandler(new Request(`${env.BETTER_AUTH_URL}/api/v1/auth/oauth2/userinfo`, { headers: live.request().headers }));
    expect((await userinfo()).status).toBe(200);
    const headers = new Headers(fixture.websiteSession.headers);
    headers.set("origin", env.BETTER_AUTH_URL);
    const response = await fixture.authHandler(new Request(`${env.BETTER_AUTH_URL}/api/v1/auth/revoke-sessions`, { method: "POST", headers }));
    expect(response.status).toBe(200);
    expect((await userinfo()).status).toBe(401);
    await expect(live.refresh()).rejects.toMatchObject({ stage: "refresh", status: 400 });
  });
  it("logout invalidates existing QuickLogin device access without revoking another user", async () => {
    const fixture = await createOAuthFixture(env);
    const install = await authorizeOfficialInstall(fixture, { websiteSession: fixture.websiteSession });
    env.QUICKLOGIN_DEVICE_MODE = "on";
    const headers = new Headers(install.request().headers);
    headers.set("origin", env.QUICKLOGIN_EXTENSION_ORIGIN);
    headers.set("content-type", "application/json");
    const register = () => SELF.fetch(`${env.BETTER_AUTH_URL}/api/v1/cqu/quicklogin/devices`, {
      method: "POST", headers, body: JSON.stringify({ deviceName: "Logout test", browserFamily: "chrome", browserVersion: "140" }),
    });
    expect((await register()).status).toBe(200);
    const ctx = await createAuth(env, new Request(env.BETTER_AUTH_URL)).$context;
    const otherUser = await ctx.adapter.create<{ id: string }>({ model: "user", data: { name: "Other", email: `${crypto.randomUUID()}@example.com`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() } });
    const otherSession = await ctx.internalAdapter.createSession(otherUser.id);
    const otherHeaders = new Headers({ cookie: `${ctx.authCookies.sessionToken.name}=${otherSession!.token}.${await makeSignature(otherSession!.token, env.BETTER_AUTH_SECRET)}` });
    const logoutHeaders = new Headers(fixture.websiteSession.headers);
    logoutHeaders.set("origin", env.BETTER_AUTH_URL);
    expect((await fixture.authHandler(new Request(`${env.BETTER_AUTH_URL}/api/v1/auth/revoke-sessions`, { method: "POST", headers: logoutHeaders }))).status).toBe(200);
    expect((await register()).status).toBe(401);
    const live = await fixture.authHandler(new Request(`${env.BETTER_AUTH_URL}/api/v1/auth/get-session`, { headers: otherHeaders }));
    expect(await live.json()).toMatchObject({ user: { id: otherUser.id } });
  });
  it("introspection checks current user and mandatory device authority", async () => {
    const fixture = await createOAuthFixture(env);
    const install = await authorizeWithOverrides(fixture, { websiteSession: fixture.websiteSession, clientId: OTHER_CLIENT_ID,
      redirectUri: OTHER_REDIRECT_URI, scopes: ["openid", "offline_access"] });
    const auth = createAuth(env, new Request(env.BETTER_AUTH_URL));
    const { adapter } = await auth.$context;
    await adapter.update({ model: "oauthClient", where: [{ field: "clientId", value: OTHER_CLIENT_ID }], update: {
      clientSecret: await hashOAuthClientSecret("local-client-secret"), tokenEndpointAuthMethod: "client_secret_basic", public: false,
    } });
    const token = install.request().headers.get("authorization")!.slice(7);
    const introspect = async (value = token) => {
      const response = await fixture.authHandler(new Request(`${env.BETTER_AUTH_URL}/api/v1/auth/oauth2/introspect`, {
        method: "POST", headers: { authorization: `Basic ${btoa(`${OTHER_CLIENT_ID}:local-client-secret`)}`, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: value, token_type_hint: "access_token" }),
      }));
      expect(response.status).toBe(200);
      return response.json();
    };
    const ordinary = await introspect();
    expect(ordinary).toMatchObject({ active: true, sub: fixture.websiteSession.userId });
    expect(ordinary).not.toHaveProperty("user");
    expect(ordinary).not.toHaveProperty("caps");
    expect(ordinary).not.toHaveProperty("cquBindStatus");
    await adapter.update({ model: "oauthClient", where: [{ field: "clientId", value: OTHER_CLIENT_ID }], update: { skipConsent: true, metadata: { subsystem: "calendar" } } });
    await env.DATABASE.prepare("INSERT INTO user_entitlement (user_id,subsystem,capability,value) VALUES (?, 'calendar','sync','1')").bind(fixture.websiteSession.userId).run();
    expect(await introspect()).toMatchObject({ active: true, caps: { calendar: { sync: true } } });
    await env.DATABASE.prepare("DELETE FROM user_entitlement WHERE user_id = ?").bind(fixture.websiteSession.userId).run();
    expect(await introspect()).toMatchObject({ active: true, caps: { calendar: { sync: false } } });
    // Native OAuth JWTs deliberately need no persisted access-token row.
    await adapter.deleteMany({ model: "oauthAccessToken", where: [{ field: "userId", value: fixture.websiteSession.userId }] });
    expect(await introspect()).toMatchObject({ active: true });
    const signedWithoutSession = await auth.api.signJWT({ body: { payload: { sub: fixture.websiteSession.userId, azp: OTHER_CLIENT_ID, scope: "openid" }, overrideOptions: { jwt: { issuer: `${env.BETTER_AUTH_URL}/api/auth`, audience: `${env.BETTER_AUTH_URL}/api/auth`, expirationTime: "15m" } } } });
    expect(await introspect(signedWithoutSession.token)).toEqual({ active: false });
    const session = await adapter.findOne<{ id: string; expiresAt: Date }>({ model: "session", where: [{ field: "userId", value: fixture.websiteSession.userId }] });
    await adapter.update({ model: "session", where: [{ field: "id", value: session!.id }], update: { expiresAt: new Date(Date.now() - 60000) } });
    expect(await introspect()).toEqual({ active: false });
    await adapter.update({ model: "session", where: [{ field: "id", value: session!.id }], update: { expiresAt: session!.expiresAt } });
    await adapter.update({ model: "user", where: [{ field: "id", value: fixture.websiteSession.userId }], update: { banned: true } });
    expect(await introspect()).toEqual({ active: false });
    await adapter.update({ model: "user", where: [{ field: "id", value: fixture.websiteSession.userId }], update: { banned: false } });
    await adapter.deleteMany({ model: "session", where: [{ field: "userId", value: fixture.websiteSession.userId }] });
    expect(await introspect()).toEqual({ active: false });
  });

  it("changing a password preserves the verified current session and ends other sessions even if requested otherwise", async () => {
    const fixture = await createOAuthFixture(env);
    const auth = createAuth(env, new Request(env.BETTER_AUTH_URL));
    const ctx = await auth.$context;
    const userId = fixture.websiteSession.userId;
    await ctx.internalAdapter.createAccount({ userId, accountId: userId, providerId: "credential", password: await ctx.password.hash("old-test-password") });
    const other = await ctx.internalAdapter.createSession(userId);
    const otherHeaders = new Headers({ cookie: `${ctx.authCookies.sessionToken.name}=${other!.token}.${await makeSignature(other!.token, env.BETTER_AUTH_SECRET)}` });
    const headers = new Headers(fixture.websiteSession.headers);
    headers.set("origin", env.BETTER_AUTH_URL); headers.set("content-type", "application/json");
    const proof = await fixture.authHandler(new Request(`${env.BETTER_AUTH_URL}/api/v1/auth/security/challenge`, {
      method: "POST", headers, body: JSON.stringify({ password: "old-test-password", purpose: "password" }),
    }));
    expect(proof.status).toBe(200);
    const response = await fixture.authHandler(new Request(`${env.BETTER_AUTH_URL}/api/v1/auth/change-password`, {
      method: "POST", headers, body: JSON.stringify({ currentPassword: "old-test-password", newPassword: "new-test-password", revokeOtherSessions: false }),
    }));
    expect(response.status, await response.clone().text()).toBe(200);
    const read = (headers: Headers) => fixture.authHandler(new Request(`${env.BETTER_AUTH_URL}/api/v1/auth/get-session`, { headers })).then(r => r.json());
    expect(await read(fixture.websiteSession.headers)).toMatchObject({ user: { id: userId } });
    expect(await read(otherHeaders)).toBeNull();
  });

  it("password recovery ends device credentials and trust, preserves MFA and private background RPC", async () => {
    const fixture = await createOAuthFixture(env);
    const auth = createAuth(env, new Request(env.BETTER_AUTH_URL));
    const ctx = await auth.$context;
    const userId = fixture.websiteSession.userId;
    await ctx.internalAdapter.createAccount({ userId, accountId: userId, providerId: "credential", password: await ctx.password.hash("old-test-password") });
    await ctx.adapter.update({ model: "user", where: [{ field: "id", value: userId }], update: { twoFactorEnabled: true } });
    await ctx.adapter.create({ model: "twoFactor", data: { userId, verified: true,
      secret: await symmetricEncrypt({ key: env.BETTER_AUTH_SECRET, data: "JBSWY3DPEHPK3PXP" }),
      backupCodes: await symmetricEncrypt({ key: env.BETTER_AUTH_SECRET, data: JSON.stringify(["test-recovery-code"]) }),
    } });
    const trustId = "trust-device-test";
    await ctx.internalAdapter.createVerificationValue({ identifier: trustId, value: userId, expiresAt: new Date(Date.now() + 600000) });
    const trustToken = await createHMAC("SHA-256", "base64urlnopad").sign(env.BETTER_AUTH_SECRET, `${userId}!${trustId}`);
    const trustValue = `${trustToken}!${trustId}`;
    const cookieName = ctx.createAuthCookie("trust_device").name;
    const json = (path: string, body: unknown, cookie = "") => fixture.authHandler(new Request(`${env.BETTER_AUTH_URL}/api/v1/auth${path}`, {
      method: "POST", headers: { origin: env.BETTER_AUTH_URL, "content-type": "application/json", cookie }, body: JSON.stringify(body),
    }));
    const user = await ctx.internalAdapter.findUserById(userId);
    const trusted = await json("/sign-in/email", { email: user!.email, password: "old-test-password" }, `${cookieName}=${trustValue}.${await makeSignature(trustValue, env.BETTER_AUTH_SECRET)}`);
    expect(await trusted.clone().json()).toMatchObject({ user: { id: userId } });
    const rotatedTrust = (trusted.headers as Headers & { getSetCookie(): string[] }).getSetCookie().find(value => value.startsWith(`${cookieName}=`))!.split(";")[0];
    const install = await authorizeWithOverrides(fixture, { websiteSession: fixture.websiteSession, clientId: OTHER_CLIENT_ID, redirectUri: OTHER_REDIRECT_URI, scopes: ["openid", "offline_access"] });
    await ctx.adapter.create({ model: "oauthClient", data: { clientId: "background-test", clientSecret: await hashOAuthClientSecret("background-secret"), disabled: false, redirectUris: [], metadata: { subsystem: "calendar", rpcMethods: ["getCaps"] } } });
    await env.DATABASE.prepare("INSERT INTO user_entitlement (user_id,subsystem,capability,value) VALUES (?, 'calendar','sync','1')").bind(userId).run();
    const rpc = new AuthService(createExecutionContext(), env);
    const args = { userId, clientId: "background-test", clientSecret: "background-secret" };
    expect(await rpc.getCaps(args)).toMatchObject({ calendar: { sync: true } });
    await ctx.internalAdapter.createVerificationValue({ identifier: "reset-password:recover-test", value: userId, expiresAt: new Date(Date.now() + 600000) });
    expect((await json("/reset-password", { token: "recover-test", newPassword: "new-test-password" })).status).toBe(200);
    await expect(install.refresh()).rejects.toMatchObject({ status: 400 });
    expect(await rpc.getCaps(args)).toMatchObject({ calendar: { sync: true } });
    const login = await json("/sign-in/email", { email: user!.email, password: "new-test-password" }, rotatedTrust);
    expect(await login.json()).toMatchObject({ twoFactorRedirect: true, twoFactorMethods: expect.arrayContaining(["totp"]) });
  });

});
