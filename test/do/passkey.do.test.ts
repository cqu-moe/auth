import { expect, it } from "vitest";
import { createApiFixture } from "./api-fixture";

it("requires recent authentication before binding a Passkey and requests verified-user registration", async () => {
  const api = await createApiFixture();
  const headers = await api.signIn("user");
  headers.set("origin", "http://localhost:8787");
  headers.set("content-type", "application/json");
  const options = () => api.request("/api/v1/auth/passkey/generate-register-options", { headers });
  expect((await options()).status).toBe(403);
  expect((await api.request("/api/v1/auth/security/challenge", { method: "POST", headers, body: JSON.stringify({ password: "local-test-password", purpose: "mfa" }) })).status).toBe(200);
  const response = await options();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ rp: { id: "localhost" }, authenticatorSelection: { userVerification: "required" } });
});

it("registers multiple keys, requires UV for login, and reauthenticates the same session for a purpose", async () => {
  const { authenticator } = await import("./passkey-authenticator");
  const { api, headers, get, post } = await passkeyFixture("admin", true);
  await post("/security/challenge", { password: "local-test-password", purpose: "mfa" });
  const first = await authenticator(); const second = await authenticator();
  for (const device of [first, second]) {
    const options = await (await get("/passkey/generate-register-options")).json<{ challenge: string }>();
    const bound = await post("/passkey/verify-registration", { response: await device.register(options.challenge), name: "测试密钥" });
    expect(bound.status, await bound.clone().text()).toBe(200);
  }
  expect(await (await get("/passkey/list-user-passkeys")).json()).toHaveLength(2);
  await post("/sign-out", {});
  const unverified = await (await get("/passkey/generate-authenticate-options")).json<{ challenge: string }>();
  expect((await post("/passkey/verify-authentication", { response: await first.authenticate(unverified.challenge, { uv: false }) })).ok).toBe(false);
  const login = await (await get("/passkey/generate-authenticate-options")).json<{ challenge: string }>();
  expect((await post("/passkey/verify-authentication", { response: await first.authenticate(login.challenge) })).status).toBe(200);
  expect((await api.request("/api/v1/admin/users", { headers })).status).toBe(200);
  const before = await (await get("/get-session")).json<{ session: { id: string } }>();
  const challenge = await (await post("/security/passkey/options", { purpose: "email" })).json<{ challengeId: string; options: { challenge: string } }>();
  expect(challenge.options).toBeDefined();
  const completeBody = { challengeId: challenge.challengeId, response: await second.authenticate(challenge.options.challenge) };
  expect((await post("/security/passkey/complete", completeBody)).status).toBe(200);
  expect((await post("/security/passkey/complete", completeBody)).ok).toBe(false);
  expect(await (await get("/security/status?purpose=email")).json()).toMatchObject({ verified: true, strong: true });
  expect(await (await get("/security/status?purpose=password")).json()).toMatchObject({ verified: false });
  expect((await (await get("/get-session")).json<{ session: { id: string } }>()).session.id).toBe(before.session.id);
  const keys = await (await get("/passkey/list-user-passkeys")).json<Array<{ id: string }>>();
  expect((await post("/passkey/update-passkey", { id: keys[0].id, name: "我的电脑" })).status).toBe(200);
  expect((await post("/passkey/delete-passkey", { id: keys[0].id })).status).toBe(200);
  expect(await (await get("/passkey/list-user-passkeys")).json()).toHaveLength(1);
});

let passkeyFixtureNumber = 0;
async function passkeyFixture(role: "admin" | "user" = "user", strong = false) {
  const api = await createApiFixture();
  const headers = await api.signIn(role, strong);
  headers.set("cf-connecting-ip", `192.0.2.${++passkeyFixtureNumber}`);
  headers.set("origin", "http://localhost:8787"); headers.set("content-type", "application/json");
  const absorb = (response: Response) => {
    const cookies = new Map((headers.get("cookie") ?? "").split("; ").map(c => c.split(/=(.*)/s).slice(0, 2) as [string, string]));
    for (const c of (response.headers as Headers & { getSetCookie(): string[] }).getSetCookie()) { const [name, value] = c.split(";")[0].split(/=(.*)/s); cookies.set(name, value); }
    headers.set("cookie", [...cookies].map(([name, value]) => `${name}=${value}`).join("; "));
    return response;
  };
  const get = async (path: string) => absorb(await api.request(`/api/v1/auth${path}`, { headers }));
  const post = async (path: string, body: unknown) => absorb(await api.request(`/api/v1/auth${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
  return { api, headers, get, post };
}

it.each([
  ["UV", { uv: false }], ["origin", { origin: "https://attacker.invalid" }], ["RP", { rpID: "attacker.invalid" }],
] as const)("rejects registration and login with invalid %s", async (_label, invalid) => {
  const { authenticator } = await import("./passkey-authenticator");
  const { get, post } = await passkeyFixture();
  const device = await authenticator();
  await post("/security/challenge", { password: "local-test-password", purpose: "mfa" });
  const rejectedOptions = await (await get("/passkey/generate-register-options")).json<{ challenge: string }>();
  expect((await post("/passkey/verify-registration", { response: await device.register(rejectedOptions.challenge, invalid) })).ok).toBe(false);
  expect(await (await get("/passkey/list-user-passkeys")).json()).toEqual([]);
  const options = await (await get("/passkey/generate-register-options")).json<{ challenge: string }>();
  expect((await post("/passkey/verify-registration", { response: await device.register(options.challenge) })).status).toBe(200);
  const stepUp = await (await post("/security/passkey/options", { purpose: "email" })).json<{ challengeId: string; options: { challenge: string } }>();
  expect((await post("/security/passkey/complete", { challengeId: stepUp.challengeId, response: await device.authenticate(stepUp.options.challenge, invalid) })).status).toBe(401);
  expect(await (await get("/security/status?purpose=email")).json()).toMatchObject({ verified: false });
  await post("/sign-out", {});
  const login = await (await get("/passkey/generate-authenticate-options")).json<{ challenge: string; userVerification: string }>();
  expect(login.userVerification).toBe("required");
  expect((await post("/passkey/verify-authentication", { response: await device.authenticate(login.challenge, invalid) })).ok).toBe(false);
  expect(await (await get("/get-session")).json()).toBeNull();
});

it("rejects expired, replayed and cross-session registration, login and step-up challenges", async () => {
  const { authenticator } = await import("./passkey-authenticator");
  const { createAuth } = await import("../../src/auth"); const { env } = await import("cloudflare:test");
  const { api, headers, get, post } = await passkeyFixture();
  const auth = createAuth(env, new Request(env.BETTER_AUTH_URL)); const context = await auth.$context;
  const device = await authenticator();
  await post("/security/challenge", { password: "local-test-password", purpose: "mfa" });
  const options = await (await get("/passkey/generate-register-options")).json<{ challenge: string }>();
  const registration = { response: await device.register(options.challenge) };
  expect((await post("/passkey/verify-registration", registration)).status).toBe(200);
  expect((await post("/passkey/verify-registration", registration)).ok).toBe(false);
  const current = await auth.api.getSession({ headers });
  const secondLogin = await auth.api.signInEmail({ body: { email: current!.user.email, password: "local-test-password" }, returnHeaders: true });
  const secondCookie = (secondLogin.headers as Headers & { getSetCookie(): string[] }).getSetCookie().map(c => c.split(";")[0]).filter(c => !c.endsWith("=")).join("; ");
  const next = await (await post("/security/passkey/options", { purpose: "mfa" })).json<{ challengeId: string; options: { challenge: string } }>();
  const crossed = await api.request("/api/v1/auth/security/passkey/complete", { method: "POST", headers: { cookie: secondCookie, origin: env.BETTER_AUTH_URL, "content-type": "application/json" }, body: JSON.stringify({ challengeId: next.challengeId, response: await device.authenticate(next.options.challenge) }) });
  expect(crossed.status).toBe(401);
  const expired = await (await post("/security/passkey/options", { purpose: "mfa" })).json<{ challengeId: string; options: { challenge: string } }>();
  await context.adapter.update({ model: "verification", where: [{ field: "identifier", value: `security-passkey:${expired.challengeId}` }], update: { expiresAt: new Date(Date.now() - 1) } });
  expect((await post("/security/passkey/complete", { challengeId: expired.challengeId, response: await device.authenticate(expired.options.challenge) })).status).toBe(401);
  // A second account's registered key cannot approve this user's operation.
  const other = await passkeyFixture(); const otherKey = await authenticator();
  await other.post("/security/challenge", { password: "local-test-password", purpose: "mfa" });
  const otherOptions = await (await other.get("/passkey/generate-register-options")).json<{ challenge: string }>();
  expect((await other.post("/passkey/verify-registration", { response: await otherKey.register(otherOptions.challenge) })).status).toBe(200);
  const own = await (await post("/security/passkey/options", { purpose: "mfa" })).json<{ challengeId: string; options: { challenge: string } }>();
  expect((await post("/security/passkey/complete", { challengeId: own.challengeId, response: await otherKey.authenticate(own.options.challenge) })).status).toBe(401);

  // The signed registration challenge must not transfer between live sessions.
  const pending = await (await get("/passkey/generate-register-options")).json<{ challenge: string }>();
  const sourceCookie = headers.get("cookie")!;
  const challengeCookie = sourceCookie.split("; ").filter(c => c.includes("passkey")).join("; ");
  headers.set("cookie", `${secondCookie}; ${challengeCookie}`);
  await post("/security/challenge", { password: "local-test-password", purpose: "mfa" });
  const crossedRegistration = await post("/passkey/verify-registration", { response: await (await authenticator()).register(pending.challenge) });
  expect(crossedRegistration.status).toBe(403);
  headers.set("cookie", sourceCookie);
  // Concurrent delivery of the same native login assertion has one winner.
  await post("/sign-out", {});

  const stale = await (await get("/passkey/generate-authenticate-options")).json<{ challenge: string }>();
  const rows = await context.adapter.findMany<{ id: string; value: string }>({ model: "verification" });
  const staleRow = rows.find(row => { try { return JSON.parse(row.value).expectedChallenge === stale.challenge; } catch { return false; } });
  expect(staleRow).toBeDefined();
  await context.adapter.update({ model: "verification", where: [{ field: "id", value: staleRow!.id }], update: { expiresAt: new Date(Date.now() - 1) } });
  expect((await post("/passkey/verify-authentication", { response: await device.authenticate(stale.challenge) })).ok).toBe(false);
  const login = await (await get("/passkey/generate-authenticate-options")).json<{ challenge: string }>();
  const assertion = await device.authenticate(login.challenge);
  const authenticate = () => auth.handler(new Request(`${env.BETTER_AUTH_URL}/api/v1/auth/passkey/verify-authentication`, { method: "POST", headers, body: JSON.stringify({ response: assertion }) }));
  const results = await Promise.all([authenticate(), authenticate()]);
  expect(results.filter(result => result.ok)).toHaveLength(1);
  expect((await authenticate()).ok).toBe(false);

});

it("uses UV Passkey alone for password and factor mutations without weakening the password path", async () => {
  const { authenticator } = await import("./passkey-authenticator");
  const { api, headers, get, post } = await passkeyFixture("admin", true);
  const device = await authenticator();
  const options = await (await get("/passkey/generate-register-options")).json<{ challenge: string }>();
  expect((await post("/passkey/verify-registration", { response: await device.register(options.challenge) })).status).toBe(200);
  const change = () => post("/security/passkey/change-password", { newPassword: "next-test-password" });
  expect((await change()).status).toBe(403);
  const prove = async (purpose: "password" | "mfa" | "email") => {
    const challenge = await (await post("/security/passkey/options", { purpose })).json<{ challengeId: string; options: { challenge: string } }>();
    expect((await post("/security/passkey/complete", { challengeId: challenge.challengeId, response: await device.authenticate(challenge.options.challenge) })).status).toBe(200);
  };
  await prove("email");
  expect((await change()).status).toBe(403);
  await prove("password");
  expect((await change()).status).toBe(200);
  const { env } = await import("cloudflare:test"); const { createAuth } = await import("../../src/auth");
  const auth = createAuth(env, new Request(env.BETTER_AUTH_URL)); const context = await auth.$context;
  const current = await auth.api.getSession({ headers });
  expect(current).not.toBeNull();
  const loginWithPassword = (password: string) => api.request("/api/v1/auth/sign-in/email", { method: "POST", headers: { origin: env.BETTER_AUTH_URL, "content-type": "application/json", "cf-connecting-ip": "192.0.2.144" }, body: JSON.stringify({ email: current!.user.email, password }) });
  expect((await loginWithPassword("local-test-password")).status).toBe(401);
  const newPasswordLogin = await loginWithPassword("next-test-password");
  expect(newPasswordLogin.status).toBe(200);
  expect(await newPasswordLogin.json()).toMatchObject({ twoFactorRedirect: true });
  // Expired proof cannot authorize another password change.
  await context.adapter.update({ model: "verification", where: [{ field: "identifier", value: `security-proof:${current!.session.id}:password` }], update: { expiresAt: new Date(Date.now() - 1) } });
  expect((await change()).status).toBe(403);

  expect((await post("/security/passkey/two-factor/disable", {})).status).toBe(403);
  // Password plus the configured second factor still gates the native path.
  expect((await post("/two-factor/disable", { password: "wrong-password" })).ok).toBe(false);
  await prove("mfa");
  const regenerated = await post("/security/passkey/two-factor/generate-backup-codes", {});
  expect(regenerated.status).toBe(200);
  const codes = await regenerated.json<{ backupCodes: string[] }>();
  expect((await post("/two-factor/verify-backup-code", { code: codes.backupCodes[0], disableSession: true })).status).toBe(200);
  expect((await post("/security/passkey/two-factor/disable", {})).status).toBe(200);
  expect(await (await get("/get-session")).json()).toMatchObject({ user: { twoFactorEnabled: false } });
  const enrollment = await post("/security/passkey/two-factor/enable", {});
  expect(enrollment.status).toBe(200);
  const enrolled = await enrollment.json<{ totpURI: string; backupCodes: string[] }>();
  const { createOTP } = await import("@better-auth/utils/otp"); const { base32 } = await import("@better-auth/utils/base32");
  const code = await createOTP(new TextDecoder().decode(base32.decode(new URL(enrolled.totpURI).searchParams.get("secret")!))).totp();
  expect((await post("/two-factor/verify-totp", { code })).status).toBe(200);
  expect(await (await get("/get-session")).json()).toMatchObject({ user: { twoFactorEnabled: true } });
  const other = await api.signIn("user"); other.set("origin", env.BETTER_AUTH_URL); other.set("content-type", "application/json");
  expect((await api.request("/api/v1/auth/security/passkey/change-password", { method: "POST", headers: other, body: JSON.stringify({ newPassword: "attacker-password" }) })).status).toBe(403);
});
