import { mapAuthError } from "./two-factor";

export type LoginChallengeMethod = "totp" | "backup-code";

export const loginChallengeMethods: ReadonlyArray<{
  value: LoginChallengeMethod;
  label: string;
}> = [
  { value: "totp", label: "身份验证器" },
  { value: "backup-code", label: "备用恢复码" },
];

export type LoginChallengeError = { code?: string; message?: string } | null;
export type LoginChallengeResult = { data: unknown; error: LoginChallengeError };

export interface LoginChallengeActions {
  verifyTotp(input: { code: string; trustDevice: boolean }): Promise<LoginChallengeResult>;
  verifyBackupCode(input: { code: string; trustDevice: boolean }): Promise<LoginChallengeResult>;

}

export async function verifyLoginChallenge(
  actions: LoginChallengeActions,
  method: LoginChallengeMethod,
  code: string,
  trustDevice: boolean,
  refreshSession?: () => Promise<void>
): Promise<LoginChallengeResult> {
  const result = method === "totp"
    ? await actions.verifyTotp({ code, trustDevice })
    : await actions.verifyBackupCode({ code, trustDevice });

  if (!result.error && refreshSession) {
    await refreshSession();
  }

  return result;
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
