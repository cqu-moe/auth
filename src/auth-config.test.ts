import { describe, expect, it } from "vitest";
import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider";
import { createTestAuth } from "./test-utils/auth";
import { DEVICE_SCOPE } from "./services/quicklogin/contracts";

describe("versioned auth URL configuration", () => {
  it("moves HTTP endpoints while retaining the stable issuer and audience", async () => {
    const fixture = createTestAuth({ origin: "https://auth.cqu.moe" });
    try {
      const ctx = await fixture.auth.$context;
      const jwtPlugin = fixture.auth.options.plugins?.find((plugin) => plugin.id === "jwt");
      const oauthPlugin = fixture.auth.options.plugins?.find((plugin) => plugin.id === "oauth-provider");

      expect(ctx.baseURL).toBe("https://auth.cqu.moe/api/v1/auth");
      expect(fixture.auth.options.emailAndPassword).toMatchObject({
        enabled: true,
        revokeSessionsOnPasswordReset: true,
      });
      expect(jwtPlugin?.options).toMatchObject({
        jwt: {
          issuer: "https://auth.cqu.moe/api/auth",
          audience: "https://auth.cqu.moe/api/auth",
        },
        jwks: { keyPairConfig: { alg: "EdDSA", crv: "Ed25519" } },
      });
      expect(jwtPlugin?.options.jwks).not.toHaveProperty("remoteUrl");
      expect(oauthPlugin?.options).toMatchObject({
        resources: ["https://auth.cqu.moe/api/auth"],
        scopes: expect.arrayContaining([DEVICE_SCOPE]),
        postLogin: {
          page: "/oauth/authorize",
          shouldRedirect: expect.any(Function),
          consentReferenceId: expect.any(Function),
        },
      });
    } finally {
      fixture.close();
    }
  });

  it("publishes v1 protocol endpoints from both metadata documents", async () => {
    const fixture = createTestAuth({ origin: "https://auth.cqu.moe" });
    try {
      const request = new Request("https://auth.cqu.moe/.well-known/openid-configuration");
      const authServer = await oauthProviderAuthServerMetadata(fixture.auth)(request);
      const openId = await oauthProviderOpenIdConfigMetadata(fixture.auth)(request);
      for (const response of [authServer, openId]) {
        expect(await response.json()).toMatchObject({
          issuer: "https://auth.cqu.moe/api/auth",
          authorization_endpoint: "https://auth.cqu.moe/api/v1/auth/oauth2/authorize",
          token_endpoint: "https://auth.cqu.moe/api/v1/auth/oauth2/token",
          jwks_uri: "https://auth.cqu.moe/api/v1/auth/jwks",
        });
      }
    } finally {
      fixture.close();
    }
  });
});
