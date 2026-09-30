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
    .select({
      deviceLimit: quickloginAccountProjection.deviceLimit,
      masterEnabled: quickloginAccountProjection.masterEnabled,
    })
    .from(quickloginAccountProjection)
    .where(eq(quickloginAccountProjection.userId, userId))
    .get();
  // 安全契约:投影行可由自助设备注册无条件落库(0/0),裸行存在不能当准入信号;
  // 只有 admin 初始化出的正信号(额度>0 或 master 开)才开门,与 cqu-session 取票闸同源。
  return row !== undefined && (row.deviceLimit > 0 || row.masterEnabled);
}

export async function hasQuickloginAccess(env: Env, userId: string): Promise<boolean> {
  if (quickloginDeviceModeEnabled(env)) return hasQuickloginPolicy(env.DATABASE, userId);
  const row = await drizzle(env.DATABASE).select({ value: userEntitlement.value }).from(userEntitlement)
    .where(and(eq(userEntitlement.userId, userId), eq(userEntitlement.subsystem, 'cqu'), eq(userEntitlement.capability, 'quicklogin_access'))).get();
  return row?.value === '1';
}
