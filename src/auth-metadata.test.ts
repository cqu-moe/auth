import { describe, expect, it } from "vitest";
import { getEndpoints } from "better-auth/api";
import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider";
import { createTestAuth } from "./test-utils/auth";
import { AUTH_OPERATIONS } from "./api/auth-operations.generated";

const EXPECTED_OPERATIONS = `
GET /account-info
POST /admin/ban-user
POST /admin/create-user
GET /admin/get-user
POST /admin/has-permission
POST /admin/impersonate-user
POST /admin/list-user-sessions
GET /admin/list-users
POST /admin/remove-user
POST /admin/revoke-user-session
POST /admin/revoke-user-sessions
POST /admin/set-role
POST /admin/set-user-password
POST /admin/stop-impersonating
POST /admin/unban-user
POST /admin/update-user
GET /callback/:id
POST /callback/:id
POST /change-email
POST /change-password
GET /cloudflare/geolocation
GET /delete-user/callback
POST /delete-user
POST /email-otp/change-email
POST /email-otp/check-verification-otp
POST /email-otp/request-email-change
POST /email-otp/send-verification-otp
POST /email-otp/verify-email
GET /error
POST /get-access-token
GET /get-session
GET /jwks
POST /link-social
GET /list-accounts
GET /list-sessions
GET /oauth2/authorize
POST /oauth2/authorize
POST /oauth2/client/rotate-secret
POST /oauth2/consent
POST /oauth2/continue
POST /oauth2/create-client
POST /oauth2/delete-client
POST /oauth2/delete-consent
GET /oauth2/end-session
POST /oauth2/end-session
POST /oauth2/end-session/confirm
GET /oauth2/get-client
GET /oauth2/get-clients
GET /oauth2/get-consent
GET /oauth2/get-consents
POST /oauth2/introspect
POST /oauth2/public-client-prelogin
GET /oauth2/public-client
POST /oauth2/register
POST /oauth2/revoke
POST /oauth2/token
POST /oauth2/update-client
POST /oauth2/update-consent
GET /oauth2/userinfo
POST /oauth2/userinfo
GET /ok
POST /refresh-token
POST /request-password-reset
GET /reset-password/:token
POST /reset-password
POST /revoke-other-sessions
POST /revoke-session
POST /revoke-sessions
POST /send-verification-email
POST /sign-in/email
POST /sign-in/social
POST /sign-out
POST /sign-up/email
POST /two-factor/disable
POST /two-factor/enable
POST /two-factor/generate-backup-codes
POST /two-factor/get-totp-uri
POST /two-factor/send-otp
POST /two-factor/verify-backup-code
POST /two-factor/verify-otp
POST /two-factor/verify-totp
POST /unlink-account
POST /update-session
POST /update-user
POST /verify-password
`.trim().split("\n").sort();

describe("Better Auth migration baseline", () => {
  it("captures the exact enabled HTTP operation set", async () => {
    const fixture = createTestAuth({ origin: "https://auth.cqu.moe" });
    try {
      const ctx = await fixture.auth.$context;
      const { api } = getEndpoints(ctx, fixture.auth.options);
      const endpoints = Object.values(api)
        .filter((endpoint) => endpoint.path && !endpoint.options.metadata?.SERVER_ONLY)
        .filter((endpoint) => !fixture.auth.options.disabledPaths?.includes(endpoint.path));
      const operations = endpoints.flatMap((endpoint) => {
        const methods = Array.isArray(endpoint.options.method)
          ? endpoint.options.method
          : [endpoint.options.method];
        return methods.map((method) => `${method} ${endpoint.path}`);
      }).sort();

      expect(endpoints).toHaveLength(81);
      expect(operations).toEqual(EXPECTED_OPERATIONS);
      expect(AUTH_OPERATIONS.map(({ method, path }) => `${method} ${path}`).sort())
        .toEqual(operations);
      expect(operations).toHaveLength(85);
      expect(operations.filter((operation) => operation.endsWith(" /get-session")))
        .toEqual(["GET /get-session"]);
    } finally {
      fixture.close();
    }
  });

  it("captures the disabled, server-only, issuer, discovery, and cookie contracts", async () => {
    const fixture = createTestAuth({ origin: "https://auth.cqu.moe" });
    try {
      const ctx = await fixture.auth.$context;
      const { api } = getEndpoints(ctx, fixture.auth.options);
      const serverOnly = Object.entries(api)
        .filter(([, endpoint]) => endpoint.options.metadata?.SERVER_ONLY)
        .map(([key, endpoint]) => `${key}:${endpoint.options.method}:${endpoint.path}`)
        .sort();

      expect(ctx.baseURL).toBe("https://auth.cqu.moe/api/v1/auth");
      expect(fixture.auth.options.disabledPaths).toEqual([
        "/token",
        "/sign-in/email-otp",
        "/email-otp/request-password-reset",
        "/forget-password/email-otp",
        "/email-otp/reset-password",
        "/verify-email",
      ]);
      expect(serverOnly).toEqual(expect.arrayContaining([
        "adminCreateOAuthClient:POST:/admin/oauth2/create-client",
        "adminUpdateOAuthClient:PATCH:/admin/oauth2/update-client",
        "getOAuthServerConfig:GET:/.well-known/oauth-authorization-server",
        "getOpenIdConfig:GET:/.well-known/openid-configuration",
      ]));
      expect(ctx.authCookies).toMatchObject({
        sessionToken: {
          name: "__Secure-better-auth.session_token",
          attributes: {
            domain: "cqu.moe",
            path: "/",
            secure: true,
            httpOnly: true,
            sameSite: "lax",
            maxAge: 604800,
          },
        },
        sessionData: {
          name: "__Secure-better-auth.session_data",
          attributes: { domain: "cqu.moe", path: "/", maxAge: 300 },
        },
      });

      const authServer = await oauthProviderAuthServerMetadata(fixture.auth)(
        new Request("https://auth.cqu.moe/.well-known/oauth-authorization-server")
      );
      const openId = await oauthProviderOpenIdConfigMetadata(fixture.auth)(
        new Request("https://auth.cqu.moe/.well-known/openid-configuration")
      );
      expect(await authServer.json()).toMatchObject({
        issuer: "https://auth.cqu.moe/api/auth",
        authorization_endpoint: "https://auth.cqu.moe/api/v1/auth/oauth2/authorize",
        token_endpoint: "https://auth.cqu.moe/api/v1/auth/oauth2/token",
        jwks_uri: "https://auth.cqu.moe/api/v1/auth/jwks",
      });
      expect(await openId.json()).toMatchObject({
        issuer: "https://auth.cqu.moe/api/auth",
        authorization_endpoint: "https://auth.cqu.moe/api/v1/auth/oauth2/authorize",
        token_endpoint: "https://auth.cqu.moe/api/v1/auth/oauth2/token",
        jwks_uri: "https://auth.cqu.moe/api/v1/auth/jwks",
      });
    } finally {
      fixture.close();
    }
  });
});
