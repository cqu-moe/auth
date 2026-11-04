import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/react";
import { emailOTPClient, twoFactorClient } from "better-auth/client/plugins";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { AUTH_BASE_PATH } from "../../../shared/api-paths";

export const authClient = createAuthClient({
  basePath: AUTH_BASE_PATH,
  plugins: [
    passkeyClient(),
    oauthProviderClient(),
    emailOTPClient(),
    twoFactorClient(), // Login handles the challenge in the current document.
  ],
});
