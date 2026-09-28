import type { Env } from '../../types';
import { quickloginDeviceModeEnabled } from './mode';
import { eq, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { quickloginAccountProjection, userEntitlement } from "../../db/schema";

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

export async function hasQuickloginAccess(env: Env, userId: string): Promise<boolean> {
  if (quickloginDeviceModeEnabled(env)) return hasQuickloginPolicy(env.DATABASE, userId);
  const row = await drizzle(env.DATABASE).select({ value: userEntitlement.value }).from(userEntitlement)
    .where(and(eq(userEntitlement.userId, userId), eq(userEntitlement.subsystem, 'cqu'), eq(userEntitlement.capability, 'quicklogin_access'))).get();
  return row?.value === '1';
}
