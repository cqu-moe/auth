export type AuthFlow = "login" | "authorization";
export type TerminalOutcome = "success" | "failure" | "canceled" | "needs_input" | "unverified";
export type AuthFlowDescriptor = {
  flow: AuthFlow;
  operation:
    | "email_password"
    | "two_factor_totp"
    | "two_factor_backup_code"
    | "passkey"
    | "authorize"
    | "consent"
    | "continue";
  stage: "first_factor" | "second_factor" | "passkey" | "authorize" | "consent";
  finish: boolean;
};

const AUTH_FLOW_OPERATIONS = new Map<string, AuthFlowDescriptor>([
  ["POST /sign-in/email", { flow: "login", operation: "email_password", stage: "first_factor", finish: true }],
  ["POST /two-factor/verify-totp", { flow: "login", operation: "two_factor_totp", stage: "second_factor", finish: true }],
  ["POST /two-factor/verify-backup-code", { flow: "login", operation: "two_factor_backup_code", stage: "second_factor", finish: true }],
  ["POST /passkey/verify-authentication", { flow: "login", operation: "passkey", stage: "passkey", finish: true }],
  ["GET /oauth2/authorize", { flow: "authorization", operation: "authorize", stage: "authorize", finish: true }],
  ["POST /oauth2/authorize", { flow: "authorization", operation: "authorize", stage: "authorize", finish: true }],
  ["POST /oauth2/consent", { flow: "authorization", operation: "consent", stage: "consent", finish: true }],
  ["POST /oauth2/continue", { flow: "authorization", operation: "continue", stage: "consent", finish: true }],
]);

export function authFlowDescriptor(method: string, path: string): AuthFlowDescriptor | undefined {
  return AUTH_FLOW_OPERATIONS.get(`${method} ${path}`);
}

function trustedJsonShape(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function responseUserId(payload: Record<string, unknown> | null): string | undefined {
  const user = trustedJsonShape(payload?.user);
  return typeof user?.id === "string" && user.id ? user.id : undefined;
}

function redirectLocation(response: Response, payload: Record<string, unknown> | null): string | null {
  const header = response.headers.get("location");
  if (header) return header;
  if (payload?.redirect === true && typeof payload.url === "string") return payload.url;
  return null;
}

export function classifyAuthFlowResponse(
  descriptor: AuthFlowDescriptor,
  response: Response,
  payload: Record<string, unknown> | null
): TerminalOutcome {
  if (response.status >= 400) return "failure";
  if (descriptor.flow === "login") {
    if (payload?.twoFactorRedirect === true) return "needs_input";
    const user = trustedJsonShape(payload?.user);
    return typeof user?.id === "string" && user.id ? "success" : "unverified";
  }

  const location = redirectLocation(response, payload);
  if (!location) return "unverified";
  try {
    const url = new URL(location, "https://redacted.invalid");
    if (url.searchParams.has("code")) return "success";
    const error = url.searchParams.get("error");
    if (error === "access_denied") return "canceled";
    if (error) return "failure";
    return "needs_input";
  } catch {
    return "unverified";
  }
}

export async function readResponseShape(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return trustedJsonShape(await response.clone().json());
  } catch {
    return null;
  }
}
