import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { createAuth } from "../../src/auth";

function mergeSetCookies(headers: Headers, response: Response) {
  const current = new Map((headers.get("cookie") ?? "").split("; ").filter(Boolean).map((cookie) => {
    const index = cookie.indexOf("=");
    return [cookie.slice(0, index), cookie] as const;
  }));
  const setCookies = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ??
    (response.headers.get("set-cookie")?.split(/,(?=[^;]+?=)/) ?? []);
  for (const setCookie of setCookies) {
    const value = setCookie.split(";", 1)[0];
    current.set(value.slice(0, value.indexOf("=")), value);
  }
  headers.set("cookie", [...current.values()].join("; "));
}
import { createApiFixture } from "./api-fixture";

describe("Better Auth v1 migration", () => {
  it("uses one session across canonical and legacy get-session endpoints", async () => {
    const fixture = await createApiFixture();
    try {
      const headers = await fixture.signIn("user");
      const canonical = await fixture.request("/api/v1/auth/get-session", { headers });
      const legacy = await fixture.request("/api/auth/get-session", { headers });
      expect(canonical.status).toBe(200);
      expect(legacy.status).toBe(200);
      const canonicalBody = await canonical.json() as { user: { id: string }; caps: unknown };
      const legacyBody = await legacy.json() as { user: { id: string }; caps: unknown };
      expect(legacyBody.user.id).toBe(canonicalBody.user.id);
      expect(canonicalBody).toHaveProperty("caps");
      expect(canonicalBody).not.toHaveProperty("caps.cqu");
    } finally {
      await fixture.close();
    }
  });

  it("keeps stable issuer discovery while advertising canonical endpoints", async () => {
    const fixture = await createApiFixture();
    try {
      for (const path of [
        "/.well-known/oauth-authorization-server",
        "/api/auth/.well-known/openid-configuration",
        "/.well-known/oauth-authorization-server/api/auth",
      ]) {
        const response = await fixture.request(path);
        expect(response.status, path).toBe(200);
        expect(await response.json(), path).toMatchObject({
          issuer: "http://localhost:8787/api/auth",
          authorization_endpoint: "http://localhost:8787/api/v1/auth/oauth2/authorize",
          token_endpoint: "http://localhost:8787/api/v1/auth/oauth2/token",
          jwks_uri: "http://localhost:8787/api/v1/auth/jwks",
        });
      }
    } finally {
      await fixture.close();
    }
  });

  it("signs and verifies local bearer tokens against the stable identity", async () => {
    const fixture = await createApiFixture();
    try {
      const headers = await fixture.issueToken({
        scopes: ["cqu:ticket:jwxt"],
        clientId: "migration-client",
        userId: "migration-user",
      });
      const token = headers.get("authorization")!.slice("Bearer ".length);
      const auth = createAuth(env, new Request("http://localhost:8787/api/v1/auth/jwks"));
      const verified = await auth.api.verifyJWT({
        body: { token, issuer: "http://localhost:8787/api/auth" },
      });
      expect(verified.payload).toMatchObject({
        sub: "migration-user",
        aud: "http://localhost:8787/api/auth",
        iss: "http://localhost:8787/api/auth",
        azp: "migration-client",
        scope: "cqu:ticket:jwxt",
      });
      const rejected = await auth.api.verifyJWT({
        body: { token, issuer: "https://wrong.example/api/auth" },
      });
      expect(rejected.payload).toBeNull();
    } finally {
      await fixture.close();
    }
  });

  it("shares the OTP rate-limit bucket between canonical and legacy paths", async () => {
    const fixture = await createApiFixture();
    try {
      const headers = await fixture.signIn("user");
      const session = await fixture.request("/api/v1/auth/get-session", { headers })
        .then((response) => response.json() as Promise<{ user: { email: string } }>);
      headers.set("content-type", "application/json");
      headers.set("origin", "http://localhost:8787");
      headers.set("cf-connecting-ip", "198.51.100.10");
      const body = JSON.stringify({
        email: session.user.email,
        type: "email-verification",
      });
      const paths = [
        "/api/v1/auth/email-otp/send-verification-otp",
        "/api/auth/email-otp/send-verification-otp",
        "/api/v1/auth/email-otp/send-verification-otp",
        "/api/auth/email-otp/send-verification-otp",
      ];
      const statuses = [];
      for (const path of paths) {
        statuses.push((await fixture.request(path, { method: "POST", headers, body })).status);
      }
      expect(statuses).toEqual([200, 200, 200, 429]);
    } finally {
      await fixture.close();
    }
  });

  it("completes a PKCE authorization-code exchange through canonical endpoints", async () => {
    const fixture = await createApiFixture();
    try {
      const admin = await fixture.signIn("superAdmin");
      admin.set("content-type", "application/json");
      const created = await fixture.request("/api/v1/admin/oauth-clients", {
        method: "POST", headers: admin,
        body: JSON.stringify({
          client_name: "PKCE fixture",
          redirect_uris: ["https://client.example/callback"],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          scope: "openid profile offline_access",
          type: "native",
          require_pkce: true,
        }),
      });
      expect(created.status).toBe(201);
      const clientId = (await created.json() as { data: { client_id: string } }).data.client_id;
      const session = await fixture.signIn("user");
      const verifier = "local-pkce-verifier-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
      const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const query = new URLSearchParams({
        client_id: clientId,
        redirect_uri: "https://client.example/callback",
        response_type: "code",
        scope: "openid profile offline_access",
        state: "local-state",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      const authorize = await fixture.request(`/api/v1/auth/oauth2/authorize?${query}`, { headers: session });
      expect(authorize.status).toBe(302);
      mergeSetCookies(session, authorize);
      const consentLocation = new URL(authorize.headers.get("location")!, "http://localhost:8787");
      expect(consentLocation.pathname).toBe("/oauth/authorize");

      session.set("content-type", "application/json");
      session.set("origin", "http://localhost:8787");
      const consent = await fixture.request("/api/v1/auth/oauth2/consent", {
        method: "POST", headers: session,
        body: JSON.stringify({
          accept: true,
          scope: "openid profile offline_access",
          oauth_query: consentLocation.search.slice(1),
        }),
      });
      expect(consent.status, await consent.clone().text()).toBe(200);
      const redirect = (await consent.json() as { redirect: boolean; url: string }).url;
      const code = new URL(redirect).searchParams.get("code");
      expect(code).toBeTruthy();

      const token = await fixture.request("/api/v1/auth/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          redirect_uri: "https://client.example/callback",
          code: code!,
          code_verifier: verifier,
        }).toString(),
      });
      expect(token.status).toBe(200);
      const tokenBody = await token.json() as { access_token: string; refresh_token: string; token_type: string };
      expect(tokenBody).toMatchObject({
        access_token: expect.any(String),
        refresh_token: expect.any(String),
        token_type: "Bearer",
      });
      const refreshed = await fixture.request("/api/auth/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: clientId,
          refresh_token: tokenBody.refresh_token,
        }).toString(),
      });
      expect(refreshed.status).toBe(200);
      expect(await refreshed.json()).toMatchObject({ access_token: expect.any(String) });
    } finally {
      await fixture.close();
    }
  });

  it("completes an existing legacy reset callback and password update", async () => {
    const fixture = await createApiFixture();
    try {
      const headers = await fixture.signIn("user");
      const session = await fixture.request("/api/v1/auth/get-session", { headers })
        .then((response) => response.json() as Promise<{ user: { email: string } }>);
      const storedUser = await fixture.database.prepare(
        "SELECT id, email FROM user WHERE email = ?"
      ).bind(session.user.email).first<{ id: string; email: string }>();
      expect(storedUser?.email).toBe(session.user.email);
      const requestHeaders = new Headers({
        "content-type": "application/json",
        origin: "http://localhost:8787",
      });
      const resetToken = "legacy-reset-token-local-only";
      const legacyAuth = createAuth(env, new Request("http://localhost:8787/api/auth/request-password-reset"));
      const context = await legacyAuth.$context;
      await context.internalAdapter.createVerificationValue({
        identifier: `reset-password:${resetToken}`,
        value: storedUser!.id,
        expiresAt: new Date(Date.now() + 60_000),
      });
      const callback = `/api/auth/reset-password/${encodeURIComponent(resetToken)}?callbackURL=${encodeURIComponent("/reset-password/confirm")}`;
      const opened = await fixture.request(callback);
      expect(opened.status).toBe(302);
      const destination = new URL(opened.headers.get("location")!, "http://localhost:8787");
      expect(destination.pathname).toBe("/reset-password/confirm");
      const token = destination.searchParams.get("token");
      expect(token).toBeTruthy();

      const reset = await fixture.request("/api/auth/reset-password", {
        method: "POST", headers: requestHeaders,
        body: JSON.stringify({ token, newPassword: "new-local-password" }),
      });
      expect(reset.status).toBe(200);
      const signedIn = await fixture.request("/api/v1/auth/sign-in/email", {
        method: "POST", headers: requestHeaders,
        body: JSON.stringify({ email: session.user.email, password: "new-local-password" }),
      });
      expect(signedIn.status).toBe(200);
    } finally {
      await fixture.close();
    }
  });
});
