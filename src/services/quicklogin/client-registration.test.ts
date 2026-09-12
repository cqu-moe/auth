import { describe, expect, it } from "vitest";
import {
  ensureQuickloginOAuthClient,
  QuickloginClientRegistrationError,
} from "./client-registration";

const env = {
  QUICKLOGIN_CLIENT_ID: "cqu-quicklogin-chrome",
  QUICKLOGIN_EXTENSION_ORIGIN: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
};

describe("official quicklogin OAuth client registration", () => {
  it("creates only the fixed public PKCE client contract", async () => {
    const result = await ensureQuickloginOAuthClient(env, {
      findOne: async () => null,
      create: async ({ data }) => data,
    }, new Date("2026-09-12T00:00:00Z"));
    expect(result).toMatchObject({
      clientId: "cqu-quicklogin-chrome",
      redirectUris: ["https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/"],
      tokenEndpointAuthMethod: "none",
      grantTypes: ["authorization_code", "refresh_token"],
      requirePKCE: true,
      public: true,
      scopes: ["openid", "offline_access", "cqu:quicklogin:device"],
      metadata: {
        quickloginOfficial: true,
        extensionOrigin: env.QUICKLOGIN_EXTENSION_ORIGIN,
      },
    });
  });

  it("fails closed when a client with the production id has a different contract", async () => {
    await expect(ensureQuickloginOAuthClient(env, {
      findOne: async () => ({ clientId: env.QUICKLOGIN_CLIENT_ID, requirePKCE: false }),
      create: async ({ data }) => data,
    })).rejects.toBeInstanceOf(QuickloginClientRegistrationError);
  });
});
