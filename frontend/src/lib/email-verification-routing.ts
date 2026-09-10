interface EmailVerificationRouteState {
  hasSession: boolean;
  emailVerified: boolean;
  pathname: string;
}

export function getEmailVerificationRedirect({
  hasSession,
  emailVerified,
  pathname,
}: EmailVerificationRouteState): string | null {
  if (!hasSession) return null;
  if (!emailVerified && pathname !== "/verify-email") return "/verify-email";
  if (emailVerified && pathname === "/verify-email") return "/settings";
  return null;
}

export function getPostAuthDestination(emailVerified: boolean): string {
  return emailVerified ? "/settings" : "/verify-email";
}
