import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { cquBindAddresses, cquCredentials } from "../db/schema";

export type CquBindStatus = "pending" | "active" | "revoked" | "unbound";
export type CquBindKind = "direct" | "forward";

function parseForwardAddress(kind: string | null | undefined, value: string | null | undefined) {
  if (kind !== "forward" || !value) return undefined;
  try {
    const whitelist: unknown = JSON.parse(value);
    if (!Array.isArray(whitelist) || !whitelist.every((entry) => typeof entry === "string")) {
      return undefined;
    }
    return whitelist[0];
  } catch {
    return undefined;
  }
}

export async function getCquBinding(database: D1Database, userId: string) {
  const db = drizzle(database);
  const [address, credentials] = await Promise.all([
    db.select({
      token: cquBindAddresses.token,
      status: cquBindAddresses.status,
      kind: cquBindAddresses.kind,
      senderWhitelist: cquBindAddresses.senderWhitelist,
    })
      .from(cquBindAddresses)
      .where(eq(cquBindAddresses.userId, userId))
      .get(),
    db.select({ status: cquCredentials.status })
      .from(cquCredentials)
      .where(eq(cquCredentials.userId, userId))
      .get(),
  ]);

  // Older bound accounts can have credentials without an email-binding record.
  const bindStatus = (credentials?.status ?? address?.status ?? "unbound") as CquBindStatus;
  const kind = address && (address.kind === "direct" || address.kind === "forward")
    ? address.kind as CquBindKind
    : undefined;
  return {
    token: address?.token,
    bindStatus,
    kind,
    forwardAddress: parseForwardAddress(kind, address?.senderWhitelist),
  };
}
