import { createAuth } from "../../src/auth";
import { env, createExecutionContext } from "cloudflare:test";
import { symmetricDecrypt } from "better-auth/crypto";
import { createOTP } from "@better-auth/utils/otp";
import { expect, it } from "vitest";
import { createApiFixture } from "./api-fixture";

it("rejects a normal session at the administrator recovery boundary", async () => {
  const api = await createApiFixture();
  const headers = await api.signIn("user");
  headers.set("origin", "http://localhost:8787"); headers.set("content-type", "application/json");
  const result = await api.request("/api/v1/auth/admin/reset-authentication", { method: "POST", headers, body: JSON.stringify({ userId: "another-user" }) });
  expect(result.status).toBe(403);
});

it("atomically replaces credentials, revokes old sessions, and returns a usable random password", async () => {
  const api = await createApiFixture();
  const admin = await api.signIn("superAdmin");
  const targetHeaders = await api.signIn("user");
  const targetSession = await (await api.request("/api/v1/auth/get-session", { headers: targetHeaders })).json() as { user: { id: string; email: string } };
  const actor = await (await api.request("/api/v1/auth/get-session", { headers: admin })).json() as { user: { id: string } };
  admin.set("origin", env.BETTER_AUTH_URL); admin.set("content-type", "application/json");
  const challenge = await (await api.request("/api/v1/auth/security/challenge", { method: "POST", headers: admin, body: JSON.stringify({ password: "local-test-password", purpose: "admin" }) })).json() as { challenge: string };
  const factor = await env.DATABASE.prepare('SELECT secret FROM twoFactor WHERE userId = ?').bind(actor.user.id).first<{ secret: string }>();
  const secret = await symmetricDecrypt({ key: env.BETTER_AUTH_SECRET, data: factor!.secret });
  const verification = await api.request("/api/v1/auth/security/complete", { method: "POST", headers: admin, body: JSON.stringify({ challenge: challenge.challenge, method: "totp", code: await createOTP(secret).totp() }) });
  expect(verification.status).toBe(200);
  const reset = await api.request("/api/v1/auth/admin/reset-authentication", { method: "POST", headers: admin, body: JSON.stringify({ userId: targetSession.user.id }) });
  expect(reset.status, await reset.clone().text()).toBe(200);
  expect(reset.headers.get("cache-control")).toBe("no-store");
  const { password } = await reset.json() as { password: string };
  expect(password.length).toBeGreaterThanOrEqual(24);
  expect(await (await api.request("/api/v1/auth/get-session", { headers: targetHeaders })).json()).toBeNull();
  const signIn = (value: string) => api.request("/api/v1/auth/sign-in/email", { method: "POST", headers: { origin: env.BETTER_AUTH_URL, "content-type": "application/json" }, body: JSON.stringify({ email: targetSession.user.email, password: value }) });
  expect((await signIn("local-test-password")).status).toBe(401);
  expect((await signIn(password)).status).toBe(200);
  const audit = await env.DATABASE.prepare('SELECT * FROM auth_recovery_audit WHERE targetId = ?').bind(targetSession.user.id).all();
  expect(audit.results).toHaveLength(1);
  expect(JSON.stringify(audit.results)).not.toContain(password);
  expect(await (await api.request("/api/v1/auth/get-session", { headers: admin })).json()).not.toBeNull();
});

let fixtureNumber = 40;
async function recoveryFixture() {
  const api = await createApiFixture();
  const admin = await api.signIn("superAdmin");
  admin.set("cf-connecting-ip", `192.0.2.${++fixtureNumber}`);
  admin.set("origin", env.BETTER_AUTH_URL); admin.set("content-type", "application/json");
  const actor = await (await api.request("/api/v1/auth/get-session", { headers: admin })).json() as { user: { id: string } };
  const challenge = await (await api.request("/api/v1/auth/security/challenge", { method: "POST", headers: admin, body: JSON.stringify({ password: "local-test-password", purpose: "admin" }) })).json() as { challenge: string };
  const factor = await env.DATABASE.prepare("SELECT secret FROM twoFactor WHERE userId = ?").bind(actor.user.id).first<{ secret: string }>();
  const secret = await symmetricDecrypt({ key: env.BETTER_AUTH_SECRET, data: factor!.secret });
  const complete = await api.request("/api/v1/auth/security/complete", { method: "POST", headers: admin, body: JSON.stringify({ challenge: challenge.challenge, method: "totp", code: await createOTP(secret).totp() }) });
  expect(complete.status).toBe(200);
  const targetHeaders = await api.signIn("user");
  targetHeaders.set("cf-connecting-ip", `192.0.2.${++fixtureNumber}`);
  targetHeaders.set("origin", env.BETTER_AUTH_URL); targetHeaders.set("content-type", "application/json");
  const target = await (await api.request("/api/v1/auth/get-session", { headers: targetHeaders })).json() as { user: { id: string; email: string }; session: { id: string } };
  const reset = (userId = target.user.id) => api.request("/api/v1/auth/admin/reset-authentication", { method: "POST", headers: admin, body: JSON.stringify({ userId }) });
  return { api, admin, actor, target, targetHeaders, reset };
}

// Pause the actual D1 batch before it commits, after native credential checks.
// Production always receives the original D1 API; this fixture does not replace
// verification or mutate credentials on behalf of the tested HTTP request.
function pauseBatch(pattern: RegExp) {
  let arrive!: () => void; let resume!: () => void;
  const arrived = new Promise<void>(resolve => { arrive = resolve; });
  const released = new Promise<void>(resolve => { resume = resolve; });
  const originals = new WeakMap<object, { sql: string; statement: D1PreparedStatement }>();
  const prepare = (sql: string, values: unknown[] = []): D1PreparedStatement => {
    const statement = env.DATABASE.prepare(sql).bind(...values);
    const wrapped = new Proxy(statement, { get(target, key) {
      if (key === "bind") return (...args: unknown[]) => prepare(sql, args);
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    originals.set(wrapped, { sql, statement }); return wrapped;
  };
  let paused = false;
  const database = { prepare, async batch(statements: D1PreparedStatement[]) {
    const entries = statements.map(statement => originals.get(statement)!);
    if (!paused && entries.some(entry => pattern.test(entry.sql))) { paused = true; arrive(); await released; }
    return env.DATABASE.batch(entries.map(entry => entry.statement));
  } } as unknown as D1Database;
  return { database, arrived, resume };
}

it("blocks an old password login that finishes after recovery, then permits a fresh login", async () => {
  const { target, reset } = await recoveryFixture();
  const barrier = pauseBatch(/insert into "session"/i);
  const request = new Request(`${env.BETTER_AUTH_URL}/api/v1/auth/sign-in/email`, { method: "POST", headers: { origin: env.BETTER_AUTH_URL, "content-type": "application/json" }, body: JSON.stringify({ email: target.user.email, password: "local-test-password" }) });
  const auth = createAuth({ ...env, DATABASE: barrier.database }, request);
  const pending = auth.handler(request);
  await Promise.race([barrier.arrived, pending.then(async response => { throw new Error(`Request finished before barrier: ${response.status} ${await response.text()}`); })]);
  const result = await reset();
  expect(result.status).toBe(200);
  barrier.resume();
  expect((await pending).ok).toBe(false);
  expect((await env.DATABASE.prepare('SELECT id FROM session WHERE userId = ?').bind(target.user.id).all()).results).toEqual([]);
});

it("does not let a password change in flight overwrite the recovery password", async () => {
  const { api, target, targetHeaders, reset } = await recoveryFixture();
  expect((await api.request("/api/v1/auth/security/challenge", { method: "POST", headers: targetHeaders, body: JSON.stringify({ password: "local-test-password", purpose: "password" }) })).status).toBe(200);
  const barrier = pauseBatch(/update "account"/i);
  const request = new Request(`${env.BETTER_AUTH_URL}/api/v1/auth/change-password`, { method: "POST", headers: targetHeaders, body: JSON.stringify({ currentPassword: "local-test-password", newPassword: "attacker-password-123" }) });
  const pending = createAuth({ ...env, DATABASE: barrier.database }, request).handler(request);
  await Promise.race([barrier.arrived, pending.then(async response => { throw new Error(`Request finished before barrier: ${response.status} ${await response.text()}`); })]);
  const recovery = await reset(); expect(recovery.status).toBe(200);
  const { password } = await recovery.json() as { password: string };
  barrier.resume(); expect((await pending).ok).toBe(false);
  const login = await api.request("/api/v1/auth/sign-in/email", { method: "POST", headers: targetHeaders, body: JSON.stringify({ email: target.user.email, password }) });
  expect(login.status).toBe(200);
});

it("invalidates registered Passkeys and pending assertions, registrations, and password-reset tokens", async () => {
  const { api, target, targetHeaders, reset } = await recoveryFixture();
  const { authenticator } = await import("./passkey-authenticator");
  const device = await authenticator();
  const post = (path: string, body: unknown) => api.request(`/api/v1/auth${path}`, { method: "POST", headers: targetHeaders, body: JSON.stringify(body) });
  const get = (path: string) => api.request(`/api/v1/auth${path}`, { headers: targetHeaders });
  expect((await post("/security/challenge", { password: "local-test-password", purpose: "mfa" })).status).toBe(200);
  // Fetch the challenge together with its native signed verification cookie.
  const registrationOptions = await get("/passkey/generate-register-options"); absorbCookies(targetHeaders, registrationOptions);
  const registration = await registrationOptions.json() as { challenge: string };
  expect((await post("/passkey/verify-registration", { response: await device.register(registration.challenge), name: "恢复前密钥" })).status).toBe(200);
  const pendingRegistration = await get("/passkey/generate-register-options"); absorbCookies(targetHeaders, pendingRegistration);
  const pendingChallenge = await pendingRegistration.json() as { challenge: string };
  const pendingKey = await authenticator();
  const registrationHeaders = new Headers(targetHeaders);
  const optionsResponse = await get("/passkey/generate-authenticate-options"); absorbCookies(targetHeaders, optionsResponse);
  const assertion = await device.authenticate((await optionsResponse.json() as { challenge: string }).challenge);
  const resetRequest = await post("/request-password-reset", { email: target.user.email });
  expect(resetRequest.status).toBe(200);
  const token = await env.DATABASE.prepare("SELECT identifier FROM verification WHERE value = ? AND identifier LIKE 'reset-password:%'").bind(target.user.id).first<{ identifier: string }>();
  expect(token).not.toBeNull();
  expect((await reset()).status).toBe(200);
  expect((await post("/passkey/verify-authentication", { response: assertion })).ok).toBe(false);
  expect((await api.request("/api/v1/auth/passkey/verify-registration", { method: "POST", headers: registrationHeaders, body: JSON.stringify({ response: await pendingKey.register(pendingChallenge.challenge) }) })).ok).toBe(false);
  expect((await post("/reset-password", { token: token!.identifier.slice("reset-password:".length), newPassword: "old-reset-password123" })).ok).toBe(false);
  expect((await env.DATABASE.prepare("SELECT id FROM passkey WHERE userId = ?").bind(target.user.id).all()).results).toEqual([]);
});

function absorbCookies(headers: Headers, response: Response) {
  const cookies = new Map((headers.get("cookie") ?? "").split("; ").filter(Boolean).map(c => c.split(/=(.*)/s).slice(0, 2) as [string, string]));
  for (const cookie of (response.headers as Headers & { getSetCookie(): string[] }).getSetCookie()) {
    const [name, value] = cookie.split(";")[0].split(/=(.*)/s);
    cookies.set(name, value);
  }
  headers.set("cookie", [...cookies].map(([name, value]) => `${name}=${value}`).join("; "));
}

it("rolls back every recovery change if the real D1 batch fails", async () => {
  const { api, admin, target, targetHeaders } = await recoveryFixture();
  const database = new Proxy(env.DATABASE, { get(db, key) {
    if (key === "batch") return (statements: D1PreparedStatement[]) => db.batch(statements.length > 10 ? [...statements, db.prepare("INSERT INTO auth_reset_revision (id, revision) VALUES (2, 0)")] : statements);
    const value = Reflect.get(db, key); return typeof value === "function" ? value.bind(db) : value;
  } });
  const request = new Request(`${env.BETTER_AUTH_URL}/api/v1/auth/admin/reset-authentication`, { method: "POST", headers: admin, body: JSON.stringify({ userId: target.user.id }) });
  const result = await createAuth({ ...env, DATABASE: database }, request).handler(request);
  expect(result.status).toBe(409);
  expect(await result.json()).not.toHaveProperty("password");
  expect(await (await api.request("/api/v1/auth/get-session", { headers: targetHeaders })).json()).not.toBeNull();
  expect((await env.DATABASE.prepare("SELECT id FROM auth_recovery_audit WHERE targetId = ?").bind(target.user.id).all()).results).toEqual([]);
  const login = await api.request("/api/v1/auth/sign-in/email", { method: "POST", headers: targetHeaders, body: JSON.stringify({ email: target.user.email, password: "local-test-password" }) });
  expect(login.status).toBe(200);
});

it("clears MFA, recovery codes, trusted devices and pending MFA login", async () => {
  const { api, target, targetHeaders, reset } = await recoveryFixture();
  const post = (path: string, body: unknown, headers = targetHeaders) => api.request(`/api/v1/auth${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  await post("/security/challenge", { password: "local-test-password", purpose: "mfa" });
  const enrollment = await (await post("/two-factor/enable", { password: "local-test-password" })).json() as { backupCodes: string[] };
  const factor = await env.DATABASE.prepare("SELECT secret FROM twoFactor WHERE userId = ?").bind(target.user.id).first<{ secret: string }>();
  const secret = await symmetricDecrypt({ key: env.BETTER_AUTH_SECRET, data: factor!.secret });
  const code = await createOTP(secret).totp();
  const confirmed = await post("/two-factor/verify-totp", { code }); expect(confirmed.status).toBe(200); absorbCookies(targetHeaders, confirmed);
  const anonymous = new Headers({ origin: env.BETTER_AUTH_URL, "content-type": "application/json", "cf-connecting-ip": `192.0.2.${++fixtureNumber}` });
  const signin = await post("/sign-in/email", { email: target.user.email, password: "local-test-password" }, anonymous); absorbCookies(anonymous, signin);
  const trusted = await post("/two-factor/verify-totp", { code, trustDevice: true }, anonymous); expect(trusted.status).toBe(200);
  const pending = new Headers({ origin: env.BETTER_AUTH_URL, "content-type": "application/json", "cf-connecting-ip": `192.0.2.${++fixtureNumber}` });
  absorbCookies(pending, await post("/sign-in/email", { email: target.user.email, password: "local-test-password" }, pending));
  expect((await env.DATABASE.prepare("SELECT id FROM verification WHERE value = ? AND identifier LIKE 'trust-device-%'").bind(target.user.id).all()).results.length).toBeGreaterThan(0);
  expect((await reset()).status).toBe(200);
  expect((await post("/two-factor/verify-totp", { code }, pending)).ok).toBe(false);
  expect((await post("/two-factor/verify-backup-code", { code: enrollment.backupCodes[0] }, pending)).ok).toBe(false);
  expect((await env.DATABASE.prepare("SELECT id FROM twoFactor WHERE userId = ?").bind(target.user.id).all()).results).toEqual([]);
  expect((await env.DATABASE.prepare("SELECT id FROM verification WHERE value = ? AND identifier LIKE 'trust-device-%'").bind(target.user.id).all()).results).toEqual([]);
});

it("rejects a verified Passkey login waiting to create its session when recovery wins", async () => {
  const { api, target, targetHeaders, reset } = await recoveryFixture();
  const { authenticator } = await import("./passkey-authenticator"); const device = await authenticator();
  const post = (path: string, body: unknown) => api.request(`/api/v1/auth${path}`, { method: "POST", headers: targetHeaders, body: JSON.stringify(body) });
  await post("/security/challenge", { password: "local-test-password", purpose: "mfa" });
  const options = await api.request("/api/v1/auth/passkey/generate-register-options", { headers: targetHeaders }); absorbCookies(targetHeaders, options);
  expect((await post("/passkey/verify-registration", { response: await device.register((await options.json() as { challenge: string }).challenge) })).status).toBe(200);
  const loginOptions = await api.request("/api/v1/auth/passkey/generate-authenticate-options", { headers: targetHeaders }); absorbCookies(targetHeaders, loginOptions);
  const response = await device.authenticate((await loginOptions.json() as { challenge: string }).challenge);
  const barrier = pauseBatch(/insert into "session"/i);
  const request = new Request(`${env.BETTER_AUTH_URL}/api/v1/auth/passkey/verify-authentication`, { method: "POST", headers: targetHeaders, body: JSON.stringify({ response }) });
  const pending = createAuth({ ...env, DATABASE: barrier.database }, request).handler(request);
  await Promise.race([barrier.arrived, pending.then(async response => { throw new Error(`Request finished before barrier: ${response.status} ${await response.text()}`); })]); expect((await reset()).status).toBe(200); barrier.resume();
  expect((await pending).ok).toBe(false);
  expect((await env.DATABASE.prepare("SELECT id FROM session WHERE userId = ?").bind(target.user.id).all()).results).toEqual([]);
});

it("requires current administrator authority at the commit, not only before hashing", async () => {
  const { admin, actor, target, api, targetHeaders } = await recoveryFixture();
  const barrier = pauseBatch(/THEN revision \+ 1 ELSE NULL/);
  const request = new Request(`${env.BETTER_AUTH_URL}/api/v1/auth/admin/reset-authentication`, { method: "POST", headers: admin, body: JSON.stringify({ userId: target.user.id }) });
  const pending = createAuth({ ...env, DATABASE: barrier.database }, request).handler(request);
  await Promise.race([barrier.arrived, pending.then(async response => { throw new Error(`Request finished before barrier: ${response.status} ${await response.text()}`); })]);
  await env.DATABASE.prepare("UPDATE user SET role = 'user' WHERE id = ?").bind(actor.user.id).run();
  barrier.resume(); expect((await pending).ok).toBe(false);
  expect(await (await api.request("/api/v1/auth/get-session", { headers: targetHeaders })).json()).not.toBeNull();
});

it("revokes genuine device OAuth tokens while preserving approved Worker RPC and business data", async () => {
  const { reset } = await recoveryFixture();
  const { createOAuthFixture, authorizeOfficialInstall } = await import("./quicklogin-oauth-fixture");
  const { verifyQuickloginBearer } = await import("../../src/middleware/quicklogin-device-auth");
  const { hashOAuthClientSecret } = await import("../../src/utils/oauth-secret");
  const { AuthService } = await import("../../src/rpc");
  const fixture = await createOAuthFixture(env);
  const userId = fixture.websiteSession.userId;
  const install = await authorizeOfficialInstall(fixture, { websiteSession: fixture.websiteSession });
  let pendingCode: Request | undefined;
  await expect(authorizeOfficialInstall({ ...fixture, authHandler: async request => {
    if (new URL(request.url).pathname.endsWith("/oauth2/token")) {
      pendingCode = request.clone(); return Response.json({ error: "exchange_deliberately_deferred" }, { status: 400 });
    }
    return fixture.authHandler(request);
  } }, { websiteSession: fixture.websiteSession })).rejects.toBeDefined();
  expect(pendingCode).toBeDefined();
  await expect(verifyQuickloginBearer(install.request(), env)).resolves.toMatchObject({ userId });
  const clientId = crypto.randomUUID();
  const adapter = (await createAuth(env, new Request(env.BETTER_AUTH_URL)).$context).adapter;
  await adapter.create({ model: "oauthClient", data: { clientId, clientSecret: await hashOAuthClientSecret("rpc-test-secret"), redirectUris: ["https://schedule.example/callback"], tokenEndpointAuthMethod: "client_secret_basic", metadata: { subsystem: "calendar", rpcMethods: ["getCaps", "cquHarvest"] } } });
  await env.DATABASE.prepare("INSERT INTO user_entitlement (user_id, subsystem, capability, value) VALUES (?, 'calendar', 'sync', '1')").bind(userId).run();
  await env.DATABASE.prepare("INSERT INTO cqu_credentials (id, user_id, student_id, encrypted_password, iv) VALUES (?, ?, 'student', 'encrypted', 'iv')").bind(crypto.randomUUID(), userId).run();
  const namespace = { idFromName: (name: string) => name, get: () => ({ fetch: async () => Response.json({ captures: [], fetches: [] }) }) } as unknown as DurableObjectNamespace;
  const rpc = new AuthService(createExecutionContext(), { ...env, CQU_SESSION: namespace });
  const args = { clientId, clientSecret: "rpc-test-secret", userId };
  expect(await rpc.getCaps(args)).toMatchObject({ calendar: { sync: true } });
  expect(await rpc.cquHarvest({ ...args, navUrl: "https://my.cqu.edu.cn/workspace/curriculum" })).toMatchObject({ captures: [], fetches: [] });
  expect((await reset(userId)).status).toBe(200);
  await expect(verifyQuickloginBearer(install.request(), env)).rejects.toBeDefined();
  await expect(install.refresh()).rejects.toBeDefined();
  expect((await fixture.authHandler(pendingCode!)).ok).toBe(false);
  expect(await rpc.getCaps(args)).toMatchObject({ calendar: { sync: true } });
  expect(await rpc.cquHarvest({ ...args, navUrl: "https://my.cqu.edu.cn/workspace/curriculum" })).toMatchObject({ captures: [], fetches: [] });
});

it("asks an unrelated in-flight authentication write to retry without revoking its existing session", async () => {
  const { api, reset } = await recoveryFixture();
  const otherHeaders = await api.signIn("user");
  const other = await (await api.request("/api/v1/auth/get-session", { headers: otherHeaders })).json() as { user: { email: string } };
  const body = JSON.stringify({ email: other.user.email, password: "local-test-password" });
  const headers = { origin: env.BETTER_AUTH_URL, "content-type": "application/json", "cf-connecting-ip": `192.0.2.${++fixtureNumber}` };
  const request = new Request(`${env.BETTER_AUTH_URL}/api/v1/auth/sign-in/email`, { method: "POST", headers, body });
  const barrier = pauseBatch(/insert into "session"/i);
  const pending = createAuth({ ...env, DATABASE: barrier.database }, request).handler(request);
  await Promise.race([barrier.arrived, pending.then(async response => { throw new Error(`Request finished before barrier: ${response.status} ${await response.text()}`); })]); expect((await reset()).status).toBe(200); barrier.resume();
  expect((await pending).ok).toBe(false);
  expect((await api.request("/api/v1/auth/sign-in/email", { method: "POST", headers, body })).status).toBe(200);
  expect(await (await api.request("/api/v1/auth/get-session", { headers: otherHeaders })).json()).not.toBeNull();
});

it.each(["totp", "backup-code"])("blocks a verified %s login from creating a session after recovery", async method => {
  const { api, target, targetHeaders, reset } = await recoveryFixture();
  const post = (path: string, body: unknown, headers = targetHeaders) => api.request(`/api/v1/auth${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  await post("/security/challenge", { password: "local-test-password", purpose: "mfa" });
  const enrollment = await (await post("/two-factor/enable", { password: "local-test-password" })).json() as { backupCodes: string[] };
  const factor = await env.DATABASE.prepare("SELECT secret FROM twoFactor WHERE userId = ?").bind(target.user.id).first<{ secret: string }>();
  const code = await createOTP(await symmetricDecrypt({ key: env.BETTER_AUTH_SECRET, data: factor!.secret })).totp();
  expect((await post("/two-factor/verify-totp", { code })).status).toBe(200);
  const anonymous = new Headers({ origin: env.BETTER_AUTH_URL, "content-type": "application/json", "cf-connecting-ip": `192.0.2.${++fixtureNumber}` });
  absorbCookies(anonymous, await post("/sign-in/email", { email: target.user.email, password: "local-test-password" }, anonymous));
  const barrier = pauseBatch(/insert into "session"/i);
  const request = new Request(`${env.BETTER_AUTH_URL}/api/v1/auth/two-factor/verify-${method}`, { method: "POST", headers: anonymous, body: JSON.stringify({ code: method === "totp" ? code : enrollment.backupCodes[0] }) });
  const pending = createAuth({ ...env, DATABASE: barrier.database }, request).handler(request);
  await Promise.race([barrier.arrived, pending.then(async response => { throw new Error(`Request finished before barrier: ${response.status} ${await response.text()}`); })]); expect((await reset()).status).toBe(200); barrier.resume();
  expect((await pending).ok).toBe(false);
  expect((await env.DATABASE.prepare("SELECT id FROM session WHERE userId = ?").bind(target.user.id).all()).results).toEqual([]);
});

it("prevents old Passkey enrollment from creating a credential after recovery", async () => {
  const { api, target, targetHeaders, reset } = await recoveryFixture();
  const { authenticator } = await import("./passkey-authenticator"); const device = await authenticator();
  await api.request("/api/v1/auth/security/challenge", { method: "POST", headers: targetHeaders, body: JSON.stringify({ password: "local-test-password", purpose: "mfa" }) });
  const options = await api.request("/api/v1/auth/passkey/generate-register-options", { headers: targetHeaders }); absorbCookies(targetHeaders, options);
  const response = await device.register((await options.json() as { challenge: string }).challenge);
  const barrier = pauseBatch(/insert into "passkey"/i);
  const request = new Request(`${env.BETTER_AUTH_URL}/api/v1/auth/passkey/verify-registration`, { method: "POST", headers: targetHeaders, body: JSON.stringify({ response }) });
  const pending = createAuth({ ...env, DATABASE: barrier.database }, request).handler(request);
  await Promise.race([barrier.arrived, pending.then(async response => { throw new Error(`Request finished before barrier: ${response.status} ${await response.text()}`); })]); expect((await reset()).status).toBe(200); barrier.resume(); expect((await pending).ok).toBe(false);
  expect((await env.DATABASE.prepare("SELECT id FROM passkey WHERE userId = ?").bind(target.user.id).all()).results).toEqual([]);
});

it.each(["change-password", "two-factor/enable", "two-factor/disable", "two-factor/generate-backup-codes"])("fences the UV Passkey %s operation against recovery", async operation => {
  const { api, target, targetHeaders, reset } = await recoveryFixture();
  const { authenticator } = await import("./passkey-authenticator"); const device = await authenticator();
  const post = (path: string, body: unknown) => api.request(`/api/v1/auth${path}`, { method: "POST", headers: targetHeaders, body: JSON.stringify(body) });
  await post("/security/challenge", { password: "local-test-password", purpose: "mfa" });
  const options = await api.request("/api/v1/auth/passkey/generate-register-options", { headers: targetHeaders }); absorbCookies(targetHeaders, options);
  expect((await post("/passkey/verify-registration", { response: await device.register((await options.json() as { challenge: string }).challenge) })).status).toBe(200);
  if (operation.endsWith("disable") || operation.endsWith("generate-backup-codes")) {
    expect((await post("/two-factor/enable", { password: "local-test-password" })).status).toBe(200);
    const factor = await env.DATABASE.prepare("SELECT secret FROM twoFactor WHERE userId = ?").bind(target.user.id).first<{ secret: string }>();
    const code = await createOTP(await symmetricDecrypt({ key: env.BETTER_AUTH_SECRET, data: factor!.secret })).totp();
    const confirmed = await post("/two-factor/verify-totp", { code }); expect(confirmed.status).toBe(200); absorbCookies(targetHeaders, confirmed);
  }
  const proof = await (await post("/security/passkey/options", { purpose: operation === "change-password" ? "password" : "mfa" })).json() as { challengeId: string; options: { challenge: string } };
  expect((await post("/security/passkey/complete", { challengeId: proof.challengeId, response: await device.authenticate(proof.options.challenge) })).status).toBe(200);
  const pattern = operation === "change-password" ? /update "account"/i : operation.endsWith("enable") ? /insert into "twoFactor"/i : operation.endsWith("disable") ? /update "user"/i : /update "twoFactor"/i;
  const barrier = pauseBatch(pattern);
  const request = new Request(`${env.BETTER_AUTH_URL}/api/v1/auth/security/passkey/${operation}`, { method: "POST", headers: targetHeaders, body: JSON.stringify(operation === "change-password" ? { newPassword: "old-request-password-123" } : {}) });
  const pending = createAuth({ ...env, DATABASE: barrier.database }, request).handler(request);
  await Promise.race([barrier.arrived, pending.then(async response => { throw new Error(`Request finished before barrier: ${response.status} ${await response.text()}`); })]);
  const result = await reset(); expect(result.status).toBe(200); const { password } = await result.json() as { password: string };
  barrier.resume(); expect((await pending).ok).toBe(false);
  expect((await env.DATABASE.prepare("SELECT id FROM twoFactor WHERE userId = ?").bind(target.user.id).all()).results).toEqual([]);
  expect((await post("/sign-in/email", { email: target.user.email, password })).status).toBe(200);
});

it("denies ordinary administrators and expired purpose proof; recovered admins must establish strong authentication again", async () => {
  const { api, admin, actor, target, reset } = await recoveryFixture();
  await env.DATABASE.prepare("UPDATE user SET role = 'admin' WHERE id = ?").bind(actor.user.id).run();
  expect((await reset()).status).toBe(403);
  await env.DATABASE.prepare("UPDATE user SET role = 'superAdmin' WHERE id = ?").bind(actor.user.id).run();
  const adminHeaders = await api.signIn("admin");
  const targetAdmin = await (await api.request("/api/v1/auth/get-session", { headers: adminHeaders })).json() as { user: { id: string; email: string } };
  const recovered = await reset(targetAdmin.user.id); expect(recovered.status).toBe(200);
  const { password } = await recovered.json() as { password: string };
  const headers = new Headers({ origin: env.BETTER_AUTH_URL, "content-type": "application/json", "cf-connecting-ip": `192.0.2.${++fixtureNumber}` });
  const login = await api.request("/api/v1/auth/sign-in/email", { method: "POST", headers, body: JSON.stringify({ email: targetAdmin.user.email, password }) });
  expect(login.status).toBe(200); absorbCookies(headers, login);
  expect((await api.request("/api/v1/admin/users", { headers })).status).toBe(403);
  await env.DATABASE.prepare("UPDATE verification SET expiresAt = '2000-01-01T00:00:00.000Z' WHERE identifier LIKE 'security-proof:%:admin' AND (CASE WHEN json_valid(value) THEN json_extract(value, '$.userId') END) = ?").bind(actor.user.id).run();
  expect((await reset(target.user.id)).status).toBe(403);
  expect((await env.DATABASE.prepare("SELECT id FROM auth_recovery_audit WHERE actorId = ?").bind(actor.user.id).all()).results).toHaveLength(1);
});

it("keeps stateless legacy email verification links disabled after recovery", async () => {
  const { api, target, reset } = await recoveryFixture();
  const { SignJWT } = await import("jose");
  const token = await new SignJWT({ email: target.user.email, updateTo: "old-link@example.com" }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(env.BETTER_AUTH_SECRET));
  expect((await reset()).status).toBe(200);
  const response = await api.request(`/api/v1/auth/verify-email?token=${encodeURIComponent(token)}`);
  expect(response.status).toBe(404);
  expect(await env.DATABASE.prepare("SELECT email FROM user WHERE id = ?").bind(target.user.id).first()).toMatchObject({ email: target.user.email });
});
