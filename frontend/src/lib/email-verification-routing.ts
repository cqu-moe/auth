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

export function getVerificationLinkErrorMessage(errorCode: string | null): string | null {
  if (!errorCode) return null;
  if (errorCode === "TOKEN_EXPIRED") return "验证链接已过期，请重新发送验证邮件。";
  if (errorCode === "INVALID_TOKEN") return "验证链接无效，请重新发送验证邮件。";
  return "邮箱验证失败，请重新发送验证邮件。";
}
