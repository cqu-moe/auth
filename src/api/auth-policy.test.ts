import { describe, expect, it } from "vitest";
import { AUTH_OPERATIONS } from "./auth-operations.generated";
import { buildAuthPolicy, securityForPolicy } from "./auth-policy";
import { createApp } from "../app";
import { createHttpFixture } from "../test-utils/http";

describe("deterministic API authentication policy", () => {
  it("classifies every mounted Better Auth endpoint with no implicit default", () => {
    const operations = AUTH_OPERATIONS.map(({ method, path }) => ({
      method,
      path: `/api/v1/auth${path}`,
    }));
    const policy = buildAuthPolicy(operations);
    expect(policy).toHaveLength(operations.length);
    expect(new Set(policy.map((entry) => `${entry.method} ${entry.path}`)).size)
      .toBe(operations.length);
  });

  it.each([
    ["POST", "/api/v1/auth/email-otp/send-verification-otp", "public"],
    ["POST", "/api/v1/auth/email-otp/verify-email", "public"],
    ["POST", "/api/v1/auth/email-otp/request-email-change", "session"],
    ["GET", "/api/v1/auth/get-session", "optional-session"],
    ["POST", "/api/v1/auth/sign-in/email", "public"],
    ["POST", "/api/v1/auth/sign-out", "session"],
    ["GET", "/api/v1/auth/oauth2/userinfo", "bearer"],
    ["POST", "/api/v1/auth/oauth2/token", "oauth-client"],
    ["POST", "/api/v1/auth/admin/ban-user", "admin-session"],
    ["POST", "/api/v1/auth/two-factor/verify-otp", "two-factor-cookie"],
  ])("records %s %s as %s", (method, path, expected) => {
    const [entry] = buildAuthPolicy([{ method, path }]);
    expect(entry.policy).toBe(expected);
  });

  it("maps only authentication requirements into OpenAPI security", () => {
    expect(securityForPolicy("public")).toEqual([]);
    expect(securityForPolicy("optional-session")).toEqual([]);
    expect(securityForPolicy("session")).toEqual([{ cookieAuth: [] }]);
    expect(securityForPolicy("admin-session")).toEqual([{ cookieAuth: [] }]);
    expect(securityForPolicy("bearer")).toEqual([{ bearerAuth: [] }]);
    expect(securityForPolicy("oauth-client")).toEqual([{ oauthClientAuth: [] }]);
    expect(securityForPolicy("two-factor-cookie")).toEqual([{ twoFactorCookie: [] }]);
  });

  it("characterizes public, optional-session, session, Bearer, client-auth, and admin gates", async () => {
    const fixture = createHttpFixture();
    const app = createApp();
    try {
      const optional = await app.request("/api/v1/auth/get-session", {}, fixture.env);
      expect(optional.status).toBe(200);
      const login = await app.request("/api/v1/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "missing@example.test", password: "invalid-password" }),
      }, fixture.env);
      expect(login.status).toBe(401);
      expect(await login.json()).toMatchObject({ code: "INVALID_EMAIL_OR_PASSWORD" });

      for (const [path, init] of [
        ["/api/v1/auth/email-otp/request-email-change", { method: "POST", headers: { "content-type": "application/json" }, body: '{"newEmail":"next@example.test"}' }],
        ["/api/v1/auth/admin/ban-user", { method: "POST", headers: { "content-type": "application/json" }, body: '{"userId":"target-user"}' }],
        ["/api/v1/auth/oauth2/userinfo", {}],
      ] as const) {
        expect((await app.request(path, init, fixture.env)).status, path).toBe(401);
      }
      const token = await app.request("/api/v1/auth/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "grant_type=client_credentials",
      }, fixture.env);
      expect(token.status).not.toBe(200);
    } finally {
      await fixture.close();
    }
  });
});
