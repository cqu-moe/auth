import { describe, expect, it, vi } from "vitest";
import { TURNSTILE_TOKEN_HEADER } from "../../shared/turnstile";
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
    ["POST", "/api/v1/auth/email-otp/send-verification-otp", "session"],
    ["POST", "/api/v1/auth/email-otp/check-verification-otp", "session"],
    ["POST", "/api/v1/auth/email-otp/verify-email", "public"],
    ["POST", "/api/v1/auth/email-otp/request-email-change", "session"],
    ["GET", "/api/v1/auth/get-session", "optional-session"],
    ["POST", "/api/v1/auth/sign-in/email", "public"],
    ["POST", "/api/v1/auth/sign-out", "session"],
    ["GET", "/api/v1/auth/oauth2/userinfo", "bearer"],
    ["POST", "/api/v1/auth/oauth2/token", "oauth-client"],
    ["POST", "/api/v1/auth/admin/ban-user", "admin-session"],
    ["POST", "/api/v1/auth/two-factor/send-otp", "session-or-two-factor-cookie"],
    ["POST", "/api/v1/auth/two-factor/verify-otp", "session-or-two-factor-cookie"],
    ["POST", "/api/v1/auth/two-factor/verify-backup-code", "session-or-two-factor-cookie"],
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
    expect(securityForPolicy("session-or-two-factor-cookie"))
      .toEqual([{ cookieAuth: [] }, { twoFactorCookie: [] }]);
  });

  it("marks current-email OTP policy as an application override", () => {
    const policy = buildAuthPolicy([
      { method: "POST", path: "/api/v1/auth/email-otp/send-verification-otp" },
      { method: "POST", path: "/api/v1/auth/email-otp/check-verification-otp" },
    ]);
    expect(policy.map(({ source }) => source))
      .toEqual(["application-override", "application-override"]);
  });

  it("characterizes public, optional-session, session, Bearer, client-auth, and admin gates", async () => {
    const fixture = createHttpFixture();
    const passwordLoginToken = "turnstile-password-login";
    const emailChangeToken = "turnstile-email-change";
    const emailVerificationToken = "turnstile-email-verification";
    fixture.env.TURNSTILE_SECRET = "test-turnstile-secret";
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const action = typeof body.response === "string"
        ? body.response.replace("turnstile-", "")
        : null;
      return Response.json({
        success: true,
        action,
        hostname: "localhost",
        "error-codes": [],
      });
    }));
    const app = createApp();
    try {
      const optional = await app.request("/api/v1/auth/get-session", {}, fixture.env);
      expect(optional.status).toBe(200);
      const login = await app.request("/api/v1/auth/sign-in/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [TURNSTILE_TOKEN_HEADER]: passwordLoginToken,
        },
        body: JSON.stringify({ email: "missing@example.test", password: "invalid-password" }),
      }, fixture.env);
      expect(login.status).toBe(401);
      expect(await login.json()).toMatchObject({ code: "INVALID_EMAIL_OR_PASSWORD" });

      for (const [path, init] of [
        ["/api/v1/auth/email-otp/request-email-change", { method: "POST", headers: { "content-type": "application/json", [TURNSTILE_TOKEN_HEADER]: emailChangeToken }, body: '{"newEmail":"next@example.test"}' }],
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

      for (const [path, body] of [
        ["/api/v1/auth/email-otp/send-verification-otp", { email: "current@example.test", type: "email-verification" }],
        ["/api/v1/auth/email-otp/check-verification-otp", { email: "current@example.test", type: "email-verification", otp: "000000" }],
      ] as const) {
        const response = await app.request(path, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [TURNSTILE_TOKEN_HEADER]: body.type === "email-verification"
              ? emailVerificationToken
              : passwordLoginToken,
          },
          body: JSON.stringify(body),
        }, fixture.env);
        expect(response.status, path).toBe(403);
        expect(await response.json(), path).toMatchObject({ code: "CURRENT_EMAIL_OTP_ONLY" });
      }
    } finally {
      vi.unstubAllGlobals();
      await fixture.close();
    }
  });
});
