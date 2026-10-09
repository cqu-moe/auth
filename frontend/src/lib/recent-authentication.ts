export type SecurityPurpose = "password" | "email" | "mfa" | "admin";
export type AuthenticationRequest = { purpose: SecurityPurpose; challenge?: string; error?: string; resolve: (verified: boolean) => void };
export async function requestAuthentication(purpose: SecurityPurpose, password?: string): Promise<boolean> {
  try {
    const response = await fetch(`/api/v1/auth/security/status?purpose=${purpose}`);
    if (response.ok && (await response.json()).verified === true) return true;
  } catch { /* The verification dialog handles retryable network failures. */ }
  let challenge: string | undefined;
  let error: string | undefined;
  if (password) {
    try {
      const response = await fetch("/api/v1/auth/security/challenge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ purpose, password }) });
      const result = await response.json();
      if (response.ok && result.verified === true) return true;
      if (response.ok) challenge = result.challenge;
      else error = result.message ?? "验证失败，请重试";
    } catch { error = "网络错误，请重试"; }
  }
  return new Promise((resolve) => window.dispatchEvent(new CustomEvent<AuthenticationRequest>("auth:verify", { detail: { purpose, challenge, error, resolve } })));
}
