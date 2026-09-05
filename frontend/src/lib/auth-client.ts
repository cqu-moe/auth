import { createAuthClient } from "better-auth/react";
import { emailOTPClient, twoFactorClient } from "better-auth/client/plugins";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";

export const authClient = createAuthClient({
  plugins: [
    oauthProviderClient(),
    emailOTPClient(),
    twoFactorClient({ twoFactorPage: "/two-factor" }),
  ],
});
