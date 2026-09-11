import { createAuthClient } from "better-auth/react";
import { emailOTPClient, twoFactorClient } from "better-auth/client/plugins";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { AUTH_BASE_PATH } from "../../../shared/api-paths";

export const authClient = createAuthClient({
  basePath: AUTH_BASE_PATH,
  plugins: [
    oauthProviderClient(),
    emailOTPClient(),
    twoFactorClient({
      twoFactorPage: "/two-factor",
      onTwoFactorRedirect: async () => {
        // The default plugin redirect drops the login URL's query string;
        // keep ?redirect=... so the challenge can finish the round trip.
        window.location.assign(`/two-factor${window.location.search}`);
      },
    }),
  ],
});
