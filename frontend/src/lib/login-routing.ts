import { getPostAuthDestination } from "./email-verification-routing";

export function shouldSkipPostLoginNavigation(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    "twoFactorRedirect" in data &&
    data.twoFactorRedirect === true
  );
}

export function getLoginNavigationDestination(data: unknown): string | null {
  if (shouldSkipPostLoginNavigation(data)) return null;

  const user =
    typeof data === "object" && data !== null && "user" in data
      ? data.user
      : undefined;
  const emailVerified =
    typeof user === "object" && user !== null && "emailVerified" in user
      ? user.emailVerified === true
      : false;
  return getPostAuthDestination(emailVerified);
}
