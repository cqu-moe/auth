import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { cquBindAddresses, cquCredentials } from "../db/schema";

export type CquBindStatus = "pending" | "active" | "revoked" | "unbound";

export async function getCquBinding(database: D1Database, userId: string) {
  const db = drizzle(database);
  const [address, credentials] = await Promise.all([
    db.select({ token: cquBindAddresses.token, status: cquBindAddresses.status })
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
  return { token: address?.token, bindStatus };
}
