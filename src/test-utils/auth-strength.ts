import { createOTP } from "@better-auth/utils/otp";
import { base32 } from "@better-auth/utils/base32";
import type { createAuth } from "../auth";

export async function provePassword(auth: ReturnType<typeof createAuth>, headers: Headers, password: string, purpose: "password" | "email" | "mfa") {
  const response = await auth.handler(new Request("http://localhost:8787/api/v1/auth/security/challenge", {
    method: "POST", headers: new Headers({ ...Object.fromEntries(headers), origin: "http://localhost:8787", "content-type": "application/json" }), body: JSON.stringify({ password, purpose }),
  }));
  if (!response.ok) throw new Error(`proof failed: ${response.status} ${await response.text()}`);
}

export async function enrollStrongSession(auth: ReturnType<typeof createAuth>, headers: Headers, password: string): Promise<Headers> {
  await provePassword(auth, headers, password, "mfa");
  const enrollment = await auth.api.enableTwoFactor({ headers, body: { password } });
  if (enrollment.method !== "totp") throw new Error("expected TOTP enrollment");
  const secret = new TextDecoder().decode(base32.decode(new URL(enrollment.totpURI).searchParams.get("secret")!));
  const code = await createOTP(secret).totp();
  const result = await auth.api.verifyTOTP({ headers, body: { code }, returnHeaders: true });
  return new Headers({ cookie: (result.headers as Headers & { getSetCookie(): string[] }).getSetCookie().map(cookie => cookie.split(";")[0]).filter(cookie => !cookie.endsWith("=")).join("; ") });
}
