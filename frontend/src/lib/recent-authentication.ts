export type SecurityPurpose = "password" | "email" | "mfa" | "admin";
export type AuthenticationRequest = { purpose: SecurityPurpose; resolve: (verified: boolean) => void };
export async function requestAuthentication(purpose: SecurityPurpose): Promise<boolean> {
  try {
    const response = await fetch(`/api/v1/auth/security/status?purpose=${purpose}`);
    if (response.ok && (await response.json()).verified === true) return true;
  } catch { /* The verification dialog handles retryable network failures. */ }
  return new Promise((resolve) => window.dispatchEvent(new CustomEvent<AuthenticationRequest>("auth:verify", { detail: { purpose, resolve } })));
}
