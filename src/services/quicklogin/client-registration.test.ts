import { describe, expect, it, vi } from "vitest";
import {
  ensureQuickloginOAuthClient,
  QuickloginClientRegistrationError,
} from "./client-registration";

const env = {
  QUICKLOGIN_CLIENT_ID: "cqu-quicklogin-chrome",
  QUICKLOGIN_EXTENSION_ORIGIN: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
};

describe("official quicklogin client registration", () => {
  it("creates the fixed public PKCE client through the adapter", async () => {
    const create = vi.fn(async ({ data }) => data);
    const result = await ensureQuickloginOAuthClient(env, {
      findOne: vi.fn(async () => null),
      create,
    }, new Date("2026-09-11T00:00:00Z"));

    expect(result.clientId).toBe("cqu-quicklogin-chrome");
    expect(result.redirectUris).toEqual([
      "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/",
    ]);
    expect(result).toMatchObject({
      public: true,
      requirePKCE: true,
      skipConsent: false,
      tokenEndpointAuthMethod: "none",
      metadata: {
        quickloginOfficial: true,
        extensionOrigin: env.QUICKLOGIN_EXTENSION_ORIGIN,
      },
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("reads back an exact existing client and rejects drift", async () => {
    const create = vi.fn();
    const first = await ensureQuickloginOAuthClient(env, {
      findOne: vi.fn(async () => null), create: async ({ data }) => data,
    });
    await expect(ensureQuickloginOAuthClient(env, {
      findOne: vi.fn(async () => first), create,
    })).resolves.toEqual(first);
    await expect(ensureQuickloginOAuthClient(env, {
      findOne: vi.fn(async () => ({ ...first, requirePKCE: false })), create,
    })).rejects.toBeInstanceOf(QuickloginClientRegistrationError);
    expect(create).not.toHaveBeenCalled();
  });
});
