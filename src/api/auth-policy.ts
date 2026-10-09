import type { HttpOperation } from "./operations";

export type AuthPolicyKind =
  | "public"
  | "optional-session"
  | "session"
  | "admin-session"
  | "bearer"
  | "oauth-client"
  | "two-factor-cookie"
  | "session-or-two-factor-cookie";

export interface AuthPolicyEntry extends HttpOperation {
  policy: AuthPolicyKind;
  source: "better-auth-1.7.7" | "application-override" | "custom-contract";
}

const entries = (policy: AuthPolicyKind, values: readonly string[]) =>
  values.map((value) => [value, policy] as const);

const AUTH_POLICIES = new Map<string, AuthPolicyKind>([
  ...entries("public", [
    "GET /passkey/generate-authenticate-options", "POST /passkey/verify-authentication",
    "GET /callback/:id", "POST /callback/:id", "GET /cloudflare/geolocation",
    "GET /delete-user/callback", "POST /email-otp/verify-email",
    "GET /error", "POST /get-access-token", "GET /jwks",
    "GET /oauth2/authorize", "POST /oauth2/authorize", "GET /oauth2/end-session", "POST /oauth2/end-session", "GET /oauth2/public-client",
    "POST /oauth2/public-client-prelogin", "POST /oauth2/register", "GET /ok",
    "POST /refresh-token", "POST /request-password-reset", "POST /reset-password",
    "GET /reset-password/:token", "POST /send-verification-email",
    "POST /sign-in/email", "POST /sign-in/social", "POST /sign-up/email",
  ]),
  ...entries("optional-session", ["GET /get-session", "POST /oauth2/end-session/confirm"]),
  ...entries("bearer", ["GET /oauth2/userinfo", "POST /oauth2/userinfo"]),
  ...entries("oauth-client", [
    "POST /oauth2/introspect", "POST /oauth2/revoke", "POST /oauth2/token",
  ]),
  ...entries("session-or-two-factor-cookie", [
    "POST /two-factor/send-otp", "POST /two-factor/verify-backup-code",
    "POST /two-factor/verify-otp", "POST /two-factor/verify-totp",
  ]),
  ...entries("admin-session", [
    "POST /admin/ban-user", "POST /admin/create-user", "GET /admin/get-user",
    "POST /admin/has-permission", "POST /admin/impersonate-user",
    "POST /admin/list-user-sessions", "GET /admin/list-users",
    "POST /admin/remove-user", "POST /admin/revoke-user-session",
    "POST /admin/revoke-user-sessions", "POST /admin/set-role",
    "POST /admin/reset-authentication", "POST /admin/set-user-password", "POST /admin/stop-impersonating",
    "POST /admin/unban-user", "POST /admin/update-user",
  ]),
  ...entries("session", [
    "GET /passkey/generate-register-options", "POST /passkey/verify-registration", "GET /passkey/list-user-passkeys", "POST /passkey/delete-passkey", "POST /passkey/update-passkey",
    "POST /security/passkey/change-password", "POST /security/passkey/two-factor/enable", "POST /security/passkey/two-factor/disable", "POST /security/passkey/two-factor/generate-backup-codes",
    "POST /security/passkey/options", "POST /security/passkey/complete", "POST /security/challenge", "POST /security/complete", "GET /security/status",
    "GET /account-info", "POST /change-email", "POST /change-password",
    "POST /delete-user", "POST /email-otp/change-email",
    "POST /email-otp/request-email-change", "POST /email-otp/send-verification-otp",
    "POST /email-otp/check-verification-otp", "POST /link-social",
    "GET /list-accounts", "GET /list-sessions", "POST /oauth2/client/rotate-secret",
    "POST /oauth2/consent", "POST /oauth2/continue", "POST /oauth2/create-client",
    "POST /oauth2/delete-client", "POST /oauth2/delete-consent",
    "GET /oauth2/get-client", "GET /oauth2/get-clients", "GET /oauth2/get-consent",
    "GET /oauth2/get-consents", "POST /oauth2/update-client",
    "POST /oauth2/update-consent", "POST /revoke-other-sessions",
    "POST /revoke-session", "POST /revoke-sessions", "POST /sign-out",
    "POST /two-factor/disable", "POST /two-factor/enable",
    "POST /two-factor/generate-backup-codes", "POST /two-factor/get-totp-uri",
    "POST /unlink-account", "POST /update-session", "POST /update-user",
    "POST /verify-password",
  ]),
]);

function authSuffix(path: string): string | null {
  for (const prefix of ["/api/v1/auth", "/api/auth"]) {
    if (path.startsWith(prefix)) return path.slice(prefix.length) || "/";
  }
  return null;
}

export function policyForOperation(operation: HttpOperation): AuthPolicyKind | null {
  const suffix = authSuffix(operation.path);
  if (suffix === null) return null;
  const policy = AUTH_POLICIES.get(`${operation.method} ${suffix}`);
  if (!policy && operation.path.startsWith("/api/v1/auth")) {
    throw new Error(`Missing Better Auth policy for ${operation.method} ${suffix}`);
  }
  if (!policy) return null;
  return policy;
}

export function buildAuthPolicy(operations: readonly HttpOperation[]): AuthPolicyEntry[] {
  return operations.map((operation) => {
    const authPolicy = policyForOperation(operation);
    let policy = authPolicy;
    if (!policy) {
      const { path, method } = operation;
      if (method === "OPTIONS" || path.startsWith("/.well-known/") ||
          path.includes("/.well-known/") || path === "/api/v1/health" ||
          path === "/api/v1/openapi.json" || path === "/api/v1/registration-settings") {
        policy = "public";
      } else if (path.includes("/admin/")) {
        policy = "admin-session";
      } else if (path.includes("/cqu/service-ticket")) {
        policy = "bearer";
      } else if (path.includes("/cqu/binding")) {
        policy = "session";
      } else if ((path.endsWith("/cqu/quicklogin/capabilities") || path.endsWith("/cqu/quicklogin/release"))) {
        policy = "public";
      } else if (path.endsWith("/cqu/quicklogin/registrations")) {
        policy = "bearer";
      } else if (path.endsWith("/cqu/quicklogin/overview") || path.endsWith("/resume-ticket")) {
        policy = "session";
      } else if (/\/cqu\/quicklogin\/devices\/:id\/operations\/:operationId$/.test(path)) {
        policy = "bearer";
      } else if ((path.endsWith("/cqu/quicklogin") || path.endsWith("/cqu/quicklogin/download"))) {
        policy = "session";
      } else if (/\/cqu\/quicklogin\/devices(?:\/|$)/.test(path)) {
        policy = method === "GET" || method === "DELETE" ? "session" : "bearer";
      }
    }
    if (!policy) throw new Error(`No authentication policy source for ${operation.method} ${operation.path}`);
    return {
      ...operation,
      policy,
      source: authPolicy === null ? "custom-contract" :
        policy === "optional-session" || operation.path.endsWith("/sign-up/email") ||
        operation.path.endsWith("/email-otp/send-verification-otp") ||
        operation.path.endsWith("/email-otp/check-verification-otp")
        ? "application-override"
        : "better-auth-1.7.7",
    };
  });
}

export function securityForPolicy(policy: AuthPolicyKind): Array<Record<string, never[]>> {
  switch (policy) {
    case "session":
    case "admin-session":
      return [{ cookieAuth: [] }];
    case "bearer":
      return [{ bearerAuth: [] }];
    case "oauth-client":
      return [{ oauthClientAuth: [] }];
    case "two-factor-cookie":
      return [{ twoFactorCookie: [] }];
    case "session-or-two-factor-cookie":
      return [{ cookieAuth: [] }, { twoFactorCookie: [] }];
    default:
      return [];
  }
}
