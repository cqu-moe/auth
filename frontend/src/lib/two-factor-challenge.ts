import { mapAuthError } from "./two-factor";

export type LoginChallengeMethod = "totp" | "email-otp" | "backup-code";

export const loginChallengeMethods: ReadonlyArray<{
  value: LoginChallengeMethod;
  label: string;
}> = [
  { value: "totp", label: "身份验证器" },
  { value: "email-otp", label: "邮箱验证码" },
  { value: "backup-code", label: "备用恢复码" },
];

export type LoginChallengeError = { code?: string; message?: string } | null;
export type LoginChallengeResult = { data: unknown; error: LoginChallengeError };

export interface LoginChallengeActions {
  verifyTotp(input: { code: string; trustDevice: boolean }): Promise<LoginChallengeResult>;
  verifyOtp(input: { code: string; trustDevice: boolean }): Promise<LoginChallengeResult>;
  verifyBackupCode(input: { code: string; trustDevice: boolean }): Promise<LoginChallengeResult>;
  sendOtp(input: {
    fetchOptions: { body: { trustDevice: boolean } };
  }): Promise<LoginChallengeResult>;
}

export function verifyLoginChallenge(
  actions: LoginChallengeActions,
  method: LoginChallengeMethod,
  code: string,
  trustDevice: boolean
): Promise<LoginChallengeResult> {
  if (method === "totp") return actions.verifyTotp({ code, trustDevice });
  if (method === "email-otp") return actions.verifyOtp({ code, trustDevice });
  return actions.verifyBackupCode({ code, trustDevice });
}

export function sendLoginChallengeOtp(
  actions: LoginChallengeActions,
  trustDevice: boolean
): Promise<LoginChallengeResult> {
  return actions.sendOtp({ fetchOptions: { body: { trustDevice } } });
}

export function getLoginChallengeError(
  error: LoginChallengeError,
  fallback: string
): { message: string; expired: boolean } {
  if (error?.code === "INVALID_TWO_FACTOR_COOKIE") {
    return { message: "验证会话已过期，请重新登录", expired: true };
  }
  return {
    message: mapAuthError(error?.code, error?.message ?? fallback),
    expired: false,
  };
}
