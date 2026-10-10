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
  async function desiredRecord() {
    return ensureQuickloginOAuthClient(env, {
      findOne: async () => null,
      create: async ({ data }) => data,
    }, new Date("2026-09-12T00:00:00Z"));
  }

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
      applicationType: "web",
      scopes: ["openid", "offline_access", "cqu:quicklogin:device"],
      metadata: {
        quickloginOfficial: true,
        extensionOrigin: env.QUICKLOGIN_EXTENSION_ORIGIN,
      },
    });
  });

  it("registers both exact extension callbacks under the existing public client", async () => {
    const result = await ensureQuickloginOAuthClient({
      ...env,
      QUICKLOGIN_STORE_EXTENSION_ORIGIN: "chrome-extension://ainapeknaclcpoioimonkodmoakhacjd",
    }, {
      findOne: async () => null,
      create: async ({ data }) => data,
    });
    expect(result).toMatchObject({
      clientId: "cqu-quicklogin-chrome",
      redirectUris: [
        "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/",
        "https://ainapeknaclcpoioimonkodmoakhacjd.chromiumapp.org/",
      ],
      scopes: ["openid", "offline_access", "cqu:quicklogin:device"],
      requirePKCE: true,
      grantTypes: ["authorization_code", "refresh_token"],
      metadata: { quickloginOfficial: true, extensionOrigin: env.QUICKLOGIN_EXTENSION_ORIGIN },
    });
    const dualOriginEnv = { ...env,
      QUICKLOGIN_STORE_EXTENSION_ORIGIN: "chrome-extension://ainapeknaclcpoioimonkodmoakhacjd" };
    await expect(ensureQuickloginOAuthClient(dualOriginEnv, {
      findOne: async () => result,
      create: async ({ data }) => data,
    })).resolves.toBe(result);
    const canaryOnly = await desiredRecord();
    await expect(ensureQuickloginOAuthClient(dualOriginEnv, {
      findOne: async () => canaryOnly,
      create: async ({ data }) => data,
    })).rejects.toMatchObject({ code: "EXISTING_CLIENT_MISMATCH" });
  });

  it.each([
    "*",
    "https://ainapeknaclcpoioimonkodmoakhacjd",
    "chrome-extension://ainapeknaclcpoioimonkodmoakhacjd.attacker.example",
    "chrome-extension://ainapeknaclcpoioimonkodmoakhacjd/",
    "",
  ])("rejects malformed store Origin configuration: %s", async origin => {
    await expect(ensureQuickloginOAuthClient({ ...env, QUICKLOGIN_STORE_EXTENSION_ORIGIN: origin }, {
      findOne: async () => null,
      create: async ({ data }) => data,
    })).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });

  it("fails closed when a client with the production id has a different contract", async () => {
    await expect(ensureQuickloginOAuthClient(env, {
      findOne: async () => ({ clientId: env.QUICKLOGIN_CLIENT_ID, requirePKCE: false }),
      create: async ({ data }) => data,
    })).rejects.toBeInstanceOf(QuickloginClientRegistrationError);
  });

  it.each([
    ["missing client secret field", { clientSecret: undefined }],
    ["user-owned", { userId: "user-1" }],
    ["reference-bound", { referenceId: "reference-1" }],
    ["renamed", { name: "Lookalike client" }],
    ["metadata drift", {
      metadata: {
        quickloginOfficial: true,
        extensionOrigin: env.QUICKLOGIN_EXTENSION_ORIGIN,
        delegatedBy: "user-1",
      },
    }],
  ])("rejects an existing %s client", async (_case, drift) => {
    const desired = await desiredRecord();
    await expect(ensureQuickloginOAuthClient(env, {
      findOne: async () => ({ ...desired, ...drift }),
      create: async ({ data }) => data,
    })).rejects.toMatchObject({ code: "EXISTING_CLIENT_MISMATCH" });
  });
});
