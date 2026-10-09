import { startAuthentication } from "@simplewebauthn/browser";
import type { SecurityPurpose } from "./recent-authentication";

async function post(path: string, body: unknown) {
  const response = await fetch(`/api/v1/auth/security/passkey/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message ?? "Passkey 操作失败，请重试");
  return result;
}

export async function authenticateWithPasskey(purpose: SecurityPurpose): Promise<void> {
  const options = await post("options", { purpose });
  let response;
  try { response = await startAuthentication({ optionsJSON: options.options }); }
  catch { throw new Error("Passkey 验证未完成，请重试"); }
  const result = await post("complete", { challengeId: options.challengeId, response });
  if (result.verified !== true) throw new Error("Passkey 验证失败，请重试");
}

type Operation = "change-password" | "two-factor/enable" | "two-factor/disable" | "two-factor/generate-backup-codes";
export async function passkeyAccountOperation<T>(operation: Operation, body: unknown = {}): Promise<{ data: T | null; error: { message: string } | null }> {
  try {
    await authenticateWithPasskey(operation === "change-password" ? "password" : "mfa");
    return { data: await post(operation, body) as T, error: null };
  } catch (error) {
    return { data: null, error: { message: error instanceof Error ? error.message : "Passkey 操作未完成，请重试" } };
  }
}
