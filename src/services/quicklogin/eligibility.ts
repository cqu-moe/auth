import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { quickloginAccountProjection } from "../../db/schema";

export async function hasQuickloginPolicy(
  database: D1Database,
  userId: string
): Promise<boolean> {
  const row = await drizzle(database)
    .select({ userId: quickloginAccountProjection.userId })
    .from(quickloginAccountProjection)
    .where(eq(quickloginAccountProjection.userId, userId))
    .get();
  return row !== undefined;
}
