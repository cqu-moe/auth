import { getPostAuthDestination } from "./email-verification-routing";
import { withRedirectParam } from "./post-login-redirect";

export function shouldSkipPostLoginNavigation(data: unknown): boolean {
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

export function getLoginNavigationDestination(
  data: unknown,
  postLoginRedirect: string | null = null
): string | null {
  if (shouldSkipPostLoginNavigation(data)) return null;

  const user =
    typeof data === "object" && data !== null && "user" in data
      ? data.user
      : undefined;
  const emailVerified =
    typeof user === "object" && user !== null && "emailVerified" in user
      ? user.emailVerified === true
      : false;
  return getPostAuthNavigationDestination(emailVerified, postLoginRedirect);
}
