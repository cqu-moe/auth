import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { createAuth } from "../../src/auth";
import { createApiFixture } from "./api-fixture";

// HTTP is the agreed test boundary. Distinct auth instances share only real D1;
// the absent KV models the production binding removal, not an in-memory fake.
describe("D1 authentication baseline", () => {
  it("enforces one shared rate limit under concurrent requests without KV", async () => {
    await createApiFixture();
    const statuses = await Promise.all(Array.from({ length: 12 }, async () => {
      const request = new Request(`${env.BETTER_AUTH_URL}/api/v1/auth/two-factor/verify-totp`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: env.BETTER_AUTH_URL, "cf-connecting-ip": "198.51.100.242" },
        body: JSON.stringify({ code: "123456" }),
      });
      return (await createAuth(env, request).handler(request)).status;
    }));
    expect(statuses.filter(status => status === 429)).toHaveLength(7);
    expect(statuses.filter(status => status === 401)).toHaveLength(5);
  });
});

async function oauthFlow() {
  const fixture = await createApiFixture();
  const admin = await fixture.signIn("superAdmin");
  admin.set("content-type", "application/json");
  const created = await fixture.request("/api/v1/admin/oauth-clients", {
    method: "POST", headers: admin,
    body: JSON.stringify({ client_name: "D1 protocol", redirect_uris: ["https://client.example/callback"], token_endpoint_auth_method: "none", scope: "openid", type: "native" }),
  });
  expect(created.status).toBe(201);
  const clientId = (await created.json() as { data: { client_id: string } }).data.client_id;
  const headers = await fixture.signIn("user");
  headers.set("origin", env.BETTER_AUTH_URL);
  headers.set("content-type", "application/json");
  const verifier = "verifier-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ-abcdefgh";
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(hash))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const query = new URLSearchParams({ client_id: clientId, redirect_uri: "https://client.example/callback", response_type: "code", scope: "openid", state: "test-state", prompt: "consent", code_challenge: challenge, code_challenge_method: "S256" });
  async function request(path: string, init?: RequestInit) {
    const request = new Request(new URL(path, env.BETTER_AUTH_URL), init);
    return createAuth(env, request).handler(request);
  }
  async function code() {
    const response = await request(`/api/v1/auth/oauth2/authorize?${query}`, { headers });
    expect(response.status).toBe(302);
    const consentQuery = new URL(response.headers.get("location")!, env.BETTER_AUTH_URL).search.slice(1);
    const consent = await request("/api/v1/auth/oauth2/consent", { method: "POST", headers, body: JSON.stringify({ accept: true, oauth_query: consentQuery }) });
    expect(consent.status).toBe(200);
    return new URL((await consent.json() as { url: string }).url).searchParams.get("code")!;
  }
  const exchange = (code: string, overrides: Record<string, string> = {}) => request("/api/v1/auth/oauth2/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, redirect_uri: "https://client.example/callback", code, code_verifier: verifier, ...overrides }),
  });
  return { query, headers, request, code, exchange };
}

it("consumes one authorization code only once across concurrent HTTP handlers", async () => {
  const flow = await oauthFlow();
  const code = await flow.code();
  const responses = await Promise.all([flow.exchange(code), flow.exchange(code)]);
  expect(responses.map(r => r.status).sort()).toEqual([200, 400]);
});

it("rejects invalid PKCE, callback and signed authorization transactions", async () => {
  const flow = await oauthFlow();
  for (const overrides of ([{ code_verifier: "" }, { code_verifier: "wrong-verifier-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ" }, { redirect_uri: "https://evil.example/callback" }] as Record<string, string>[])) {
    const response = await flow.exchange(await flow.code(), overrides);
    expect([400, 401]).toContain(response.status);
    expect(await response.json()).toHaveProperty("error");
  }
  for (const method of ["plain", ""]) {
    const query = new URLSearchParams(flow.query);
    query.set("code_challenge_method", method);
    const response = await flow.request(`/api/v1/auth/oauth2/authorize?${query}`, { headers: flow.headers });
    expect(response.status).toBe(400);
  }
  const unsigned = await flow.request("/api/v1/auth/oauth2/consent", { method: "POST", headers: flow.headers, body: JSON.stringify({ accept: true, oauth_query: flow.query.toString() }) });
  expect(unsigned.status).toBe(400);
});

it("completes password plus TOTP login and invalidates the signed-out session", async () => {
  const { createOTP } = await import("@better-auth/utils/otp");
  const fixture = await createApiFixture();
  const headers = await fixture.signIn("user");
  const session = await fixture.request("/api/v1/auth/get-session", { headers }).then(r => r.json() as Promise<{ user: { email: string } }>);
  headers.set("origin", env.BETTER_AUTH_URL);
  headers.set("content-type", "application/json");
  const proof = await fixture.request("/api/v1/auth/security/challenge", { method: "POST", headers, body: JSON.stringify({ password: "local-test-password", purpose: "mfa" }) });
  expect(proof.status).toBe(200);
  const enable = await fixture.request("/api/v1/auth/two-factor/enable", { method: "POST", headers, body: JSON.stringify({ password: "local-test-password" }) });
  expect(enable.status).toBe(200);
  const { totpURI } = await enable.json() as { totpURI: string };
  const { base32 } = await import("@better-auth/utils/base32");
  const secret = new TextDecoder().decode(base32.decode(new URL(totpURI).searchParams.get("secret")!));
  const otp = () => createOTP(secret, { digits: 6, period: 30 }).totp();
  function receiveCookies(response: Response) {
    const cookies = new Map((headers.get("cookie") ?? "").split("; ").filter(Boolean).map(c => [c.split("=", 1)[0], c]));
    const values = (response.headers as Headers & { getSetCookie(): string[] }).getSetCookie();
    for (const cookie of values) cookies.set(cookie.split("=", 1)[0], cookie.split(";", 1)[0]);
    headers.set("cookie", [...cookies.values()].join("; "));
  }
  receiveCookies(enable);
  const verify = await fixture.request("/api/v1/auth/two-factor/verify-totp", { method: "POST", headers, body: JSON.stringify({ code: await otp() }) });
  expect(verify.status).toBe(200);
  const login = await fixture.request("/api/v1/auth/sign-in/email", { method: "POST", headers: { origin: env.BETTER_AUTH_URL, "content-type": "application/json" }, body: JSON.stringify({ email: session.user.email, password: "local-test-password" }) });
  expect(login.status).toBe(200);
  expect(await login.clone().json()).toMatchObject({ twoFactorRedirect: true });
  receiveCookies(login);
  const second = await fixture.request("/api/v1/auth/two-factor/verify-totp", { method: "POST", headers, body: JSON.stringify({ code: await otp() }) });
  expect(second.status).toBe(200);
  receiveCookies(second);
  expect(await fixture.request("/api/v1/auth/get-session", { headers }).then(r => r.json())).toMatchObject({ user: { email: session.user.email } });
  expect((await fixture.request("/api/v1/auth/sign-out", { method: "POST", headers, body: "{}" })).status).toBe(200);
  expect(await fixture.request("/api/v1/auth/get-session", { headers }).then(r => r.json())).toBeNull();
});

it("rejects expired email codes and prunes expired verification rows in D1", async () => {
  const fixture = await createApiFixture();
  const headers = await fixture.signIn("user");
  const session = await fixture.request("/api/v1/auth/get-session", { headers }).then(r => r.json() as Promise<{ user: { email: string } }>);
  headers.set("content-type", "application/json");
  headers.set("origin", env.BETTER_AUTH_URL);
  let otp = "";
  const outbound = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    expect(new URL(request.url).hostname).toBe("api.resend.com");
    const { text } = await request.json() as { text: string };
    otp = text.match(/\n\n(\d{6})\n\n/)![1];
    return Response.json({ id: "test-mail" });
  });
  async function post(path: string, body: unknown) {
    const req = new Request(`${env.BETTER_AUTH_URL}/api/v1/auth${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    return createAuth(env, req).handler(req);
  }
  try {
    const payload = { email: session.user.email, type: "email-verification" };
    expect((await post("/email-otp/send-verification-otp", payload)).status).toBe(200);
    expect(otp).toMatch(/^\d{6}$/);
    expect((await post("/email-otp/check-verification-otp", { ...payload, otp })).status).toBe(200);
    // Model persisted expiry rather than mocking the provider's verification.
    await env.DATABASE.prepare("UPDATE verification SET expiresAt = ?").bind(new Date(Date.now() - 1_000).toISOString()).run();
    const expired = await post("/email-otp/check-verification-otp", { ...payload, otp });
    expect(expired.status).toBe(400);
    expect(await expired.json()).toMatchObject({ code: "OTP_EXPIRED" });
    // The cleanup/storage contract itself needs a D1 observation.
    expect(await env.DATABASE.prepare("SELECT COUNT(*) AS count FROM verification WHERE expiresAt < ?").bind(new Date().toISOString()).first("count")).toBe(0);
  } finally { outbound.mockRestore(); }
});
