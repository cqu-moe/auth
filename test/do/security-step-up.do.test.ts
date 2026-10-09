import { expect, it } from "vitest";
import { createApiFixture } from "./api-fixture";

it("requires actual current-session password proof before native password changes", async () => {
  const api = await createApiFixture();
  const headers = await api.signIn("user");
  headers.set("cf-connecting-ip", "192.0.2.43");
  headers.set("content-type", "application/json");
  headers.set("origin", "http://localhost:8787");
  const post = (path: string, body: unknown) => api.request(`/api/v1/auth${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const change = () => post("/change-password", { currentPassword: "local-test-password", newPassword: "new-test-password" });
  expect((await change()).status).toBe(403);
  expect((await post("/security/challenge", { password: "wrong-password", purpose: "password" })).ok).toBe(false);
  expect((await post("/security/challenge", { password: "local-test-password", purpose: "email" })).status).toBe(200);
  expect((await change()).status).toBe(403);
  expect((await post("/security/challenge", { password: "local-test-password", purpose: "password" })).status).toBe(200);
  expect((await change()).status).toBe(200);
});

it("requires password plus an existing factor, consumes challenges and recovery codes once, and admits strong admins", async () => {
  const api = await createApiFixture();
  const headers = await api.signIn("admin", false);
  headers.set("cf-connecting-ip", "192.0.2.44");
  headers.set("content-type", "application/json");
  headers.set("origin", "http://localhost:8787");
  const post = (path: string, body: unknown) => api.request(`/api/v1/auth${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  expect((await api.request("/api/v1/admin/users", { headers })).status).toBe(403);
  expect((await api.request("/api/v1/auth/admin/list-users", { headers })).status).toBe(403);
  expect((await post("/security/challenge", { password: "local-test-password", purpose: "admin" })).status).toBe(403);
  await post("/security/challenge", { password: "local-test-password", purpose: "mfa" });
  const enrollment = await post("/two-factor/enable", { password: "local-test-password" });
  expect(enrollment.status).toBe(200);
  const factor = await enrollment.json<{ totpURI: string; backupCodes: string[] }>();
  const { createOTP } = await import("@better-auth/utils/otp");
  const { base32 } = await import("@better-auth/utils/base32");
  const code = await createOTP(new TextDecoder().decode(base32.decode(new URL(factor.totpURI).searchParams.get("secret")!))).totp();
  const verified = await post("/two-factor/verify-totp", { code });
  expect(verified.status).toBe(200);
  const cookies = (verified.headers as Headers & { getSetCookie(): string[] }).getSetCookie().map(cookie => cookie.split(";")[0]).filter(cookie => !cookie.endsWith("="));
  headers.set("cookie", cookies.join("; "));
  expect((await api.request("/api/v1/admin/users", { headers })).status).toBe(200);
  expect((await api.request("/api/v1/auth/admin/list-users", { headers })).status).toBe(200);
  const { createAuth } = await import("../../src/auth");
  const { env } = await import("cloudflare:test");
  const auth = createAuth(env, new Request("http://localhost:8787"));
  const recoveryRequest = () => auth.handler(new Request("http://localhost:8787/api/v1/auth/two-factor/verify-backup-code", {
    method: "POST", headers, body: JSON.stringify({ code: factor.backupCodes[0], disableSession: true }),
  }));
  const concurrent = await Promise.all([recoveryRequest(), recoveryRequest()]);
  expect(concurrent.filter(response => response.ok)).toHaveLength(1);
  expect((await recoveryRequest()).ok).toBe(false);
  const challenged = await post("/security/challenge", { password: "local-test-password", purpose: "password" });
  const body = await challenged.json<{ challenge: string; verified: boolean }>();
  expect(body.verified).toBe(false);
  const complete = () => post("/security/complete", { challenge: body.challenge, method: "totp", code });
  expect((await complete()).status).toBe(200);
  expect((await complete()).status).toBe(401);
  const other = await api.signIn("user");
  other.set("origin", "http://localhost:8787"); other.set("content-type", "application/json");
  const next = await (await post("/security/challenge", { password: "local-test-password", purpose: "email" })).json<{ challenge: string }>();
  const crossed = await api.request("/api/v1/auth/security/complete", { method: "POST", headers: other, body: JSON.stringify({ challenge: next.challenge, method: "totp", code }) });
  expect(crossed.status).toBe(401);
  const current = await auth.api.getSession({ headers });
  const context = await auth.$context;
  const ownChallenge = await (await post("/security/challenge", { password: "local-test-password", purpose: "email" })).json<{ challenge: string }>();
  const secondLogin = await auth.api.signInEmail({ body: { email: current!.user.email, password: "local-test-password" }, returnHeaders: true });
  const loginCookie = (secondLogin.headers as Headers & { getSetCookie(): string[] }).getSetCookie().map(c => c.split(";")[0]).filter(c => !c.endsWith("=")).join("; ");
  const secondFactor = await auth.api.verifyTOTP({ headers: new Headers({ cookie: loginCookie }), body: { code }, returnHeaders: true });
  const secondCookie = (secondFactor.headers as Headers & { getSetCookie(): string[] }).getSetCookie().map(c => c.split(";")[0]).filter(c => !c.endsWith("=")).join("; ");
  const swappedSession = await api.request("/api/v1/auth/security/complete", { method: "POST", headers: { cookie: secondCookie, origin: "http://localhost:8787", "content-type": "application/json" }, body: JSON.stringify({ challenge: ownChallenge.challenge, method: "totp", code }) });
  expect(swappedSession.status).toBe(401);
  const expired = await (await post("/security/challenge", { password: "local-test-password", purpose: "email" })).json<{ challenge: string }>();
  await context.adapter.update({ model: "verification", where: [{ field: "identifier", value: `security-challenge:${expired.challenge}` }], update: { expiresAt: new Date(Date.now() - 1) } });
  expect((await post("/security/complete", { challenge: expired.challenge, method: "totp", code })).status).toBe(401);
  await context.adapter.update({ model: "verification", where: [{ field: "identifier", value: `security-proof:${current!.session.id}:mfa` }], update: { expiresAt: new Date(Date.now() - 1) } });
  expect((await post("/two-factor/generate-backup-codes", { password: "local-test-password" })).status).toBe(403);
  // Admin admission survives five-minute operation proof expiry.
  expect((await api.request("/api/v1/auth/admin/list-users", { headers })).status).toBe(200);
  for (const path of ["/two-factor/send-otp", "/two-factor/verify-otp"]) expect((await post(path, { code: "123456" })).ok).toBe(false);
});

it("does not treat remembered-device password login as strong authentication", async () => {
  const api = await createApiFixture();
  const original = await api.signIn("admin");
  const { env } = await import("cloudflare:test");
  const { createAuth } = await import("../../src/auth");
  const { symmetricDecrypt } = await import("better-auth/crypto");
  const { createOTP } = await import("@better-auth/utils/otp");
  const auth = createAuth(env, new Request(env.BETTER_AUTH_URL));
  const current = await auth.api.getSession({ headers: original });
  const context = await auth.$context;
  // Fixture supplies the authenticator secret only; login is the real native flow.
  const factor = await context.adapter.findOne<{ secret: string }>({ model: "twoFactor", where: [{ field: "userId", value: current!.user.id }] });
  const secret = await symmetricDecrypt({ key: context.secretConfig, data: factor!.secret });
  const login = await auth.api.signInEmail({ body: { email: current!.user.email, password: "local-test-password" }, returnHeaders: true });
  const cookie = (headers: Headers) => (headers as Headers & { getSetCookie(): string[] }).getSetCookie().map(c => c.split(";")[0]).filter(c => !c.endsWith("=")).join("; ");
  const verified = await auth.api.verifyTOTP({ headers: new Headers({ cookie: cookie(login.headers) }), body: { code: await createOTP(secret).totp(), trustDevice: true }, returnHeaders: true });
  const trusted = cookie(verified.headers).split("; ").filter(c => c.includes("trust_device")).join("; ");
  expect(trusted).not.toBe("");
  const remembered = await auth.api.signInEmail({ headers: new Headers({ cookie: trusted }), body: { email: current!.user.email, password: "local-test-password" }, returnHeaders: true });
  expect(remembered.response).not.toMatchObject({ twoFactorRedirect: true });
  const headers = new Headers({ cookie: cookie(remembered.headers) });
  expect((await api.request("/api/v1/auth/admin/list-users", { headers })).status).toBe(403);
});

it("keeps the administrator's current session after the UI password change and real TOTP step-up", async () => {
  const api = await createApiFixture();
  const headers = await api.signIn("admin");
  headers.set("origin", "http://localhost:8787");
  headers.set("content-type", "application/json");
  const post = (path: string, body: unknown) => api.request(`/api/v1/auth${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const readSession = async () => (await api.request("/api/v1/auth/get-session", { headers })).json<{ session: { id: string }; user: { id: string; email: string } }>();
  const before = await readSession();
  const { env } = await import("cloudflare:test");
  const { createAuth } = await import("../../src/auth");
  const { symmetricDecrypt } = await import("better-auth/crypto");
  const { createOTP } = await import("@better-auth/utils/otp");
  const context = await createAuth(env, new Request(env.BETTER_AUTH_URL)).$context;
  const factor = await context.adapter.findOne<{ secret: string }>({ model: "twoFactor", where: [{ field: "userId", value: before.user.id }] });
  const secret = await symmetricDecrypt({ key: context.secretConfig, data: factor!.secret });
  const challenge = await (await post("/security/challenge", { password: "local-test-password", purpose: "password" })).json<{ challenge: string; verified: boolean }>();
  expect(challenge.verified).toBe(false);
  expect((await post("/security/complete", { challenge: challenge.challenge, method: "totp", code: await createOTP(secret).totp() })).status).toBe(200);
  const changed = await post("/change-password", { currentPassword: "local-test-password", newPassword: "next-test-password", revokeOtherSessions: true });
  expect(changed.status).toBe(200);
  // Consume response cookies as a browser would, if the endpoint emits any.
  const cookies = new Map(headers.get("cookie")!.split("; ").map(pair => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]));
  for (const cookie of (changed.headers as Headers & { getSetCookie(): string[] }).getSetCookie()) {
    const pair = cookie.split(";")[0];
    cookies.set(pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1));
  }
  headers.set("cookie", [...cookies].map(([key, value]) => `${key}=${value}`).join("; "));
  expect(await readSession()).toMatchObject({ session: { id: before.session.id }, user: { id: before.user.id } });
  expect((await api.request("/api/v1/admin/users", { headers })).status).toBe(200);
  const login = (password: string) => api.request("/api/v1/auth/sign-in/email", { method: "POST", headers: { origin: "http://localhost:8787", "content-type": "application/json" }, body: JSON.stringify({ email: before.user.email, password }) });
  expect((await login("local-test-password")).status).toBe(401);
  expect(await (await login("next-test-password")).json()).toMatchObject({ twoFactorRedirect: true });
});
