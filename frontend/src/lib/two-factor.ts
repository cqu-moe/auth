export type SecondFactorMethod = "totp" | "email-otp" | "backup-code" | "passkey";

export const availableSecondFactorMethods = [
  "totp",
  "email-otp",
  "backup-code",
] as const satisfies readonly Exclude<SecondFactorMethod, "passkey">[];

type AuthError = { code?: string; message?: string } | null | undefined;

interface CompleteTotpEnrollmentOptions {
  verifyTotp: () => Promise<{ error: AuthError }>;
  revealBackupCodes: () => void;
  refetchSession: () => Promise<unknown>;
}

export async function completeTotpEnrollment({
  verifyTotp,
  revealBackupCodes,
  refetchSession,
}: CompleteTotpEnrollmentOptions): Promise<AuthError> {
  const { error } = await verifyTotp();
  if (error) return error;

  revealBackupCodes();
  try {
    await refetchSession();
  } catch {
    // Recovery codes are already issued and must remain visible even if refresh fails.
  }
  return null;
}

export function normalizeOtp(value: string): string {
  return value.replace(/\D/g, "").slice(0, 6);
}

export function shouldShowEnrollmentBackupCodes(
  step: "password" | "scan" | "backup-codes" | "complete",
  hasSecret: boolean
) {
  return step === "backup-codes" && hasSecret;
}

export function mapAuthError(code: string | undefined, fallback: string): string {
  if (code === "INVALID_CODE" || code === "INVALID_OTP") return "验证码不正确";
  if (code === "OTP_HAS_EXPIRED" || code === "OTP_EXPIRED") return "验证码已过期，请重新获取";
  if (
    code === "TOO_MANY_ATTEMPTS" ||
    code === "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE"
  ) {
    return "尝试次数过多，请重新获取验证码";
  }
  if (code === "RATE_LIMITED") return "操作过于频繁，请稍后重试";
  if (code === "INVALID_BACKUP_CODE") return "备用恢复码无效或已使用";
  return fallback;
}
