import { getPostAuthDestination } from "./email-verification-routing";
import { withRedirectParam } from "./post-login-redirect";

export function requiresLoginChallenge(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    "twoFactorRedirect" in data &&
    data.twoFactorRedirect === true
  );
}

export function getPostAuthNavigationDestination(
  emailVerified: boolean,
  postLoginRedirect: string | null
): string {
  if (emailVerified && postLoginRedirect) return postLoginRedirect;
  return withRedirectParam(getPostAuthDestination(emailVerified), postLoginRedirect);
}
