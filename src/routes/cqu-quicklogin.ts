import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { errorResponse } from "../utils/error";
import { userEntitlement } from "../db/schema";
import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";
import { requireSession } from "../middleware/authentication";
import { QuickloginAccountClient } from "../services/quicklogin/account-client";
import { quickloginDeviceModeEnabled } from "../services/quicklogin/mode";
import { parseEnabled, QuickloginHttpError, readJson } from "../services/quicklogin/http";
import { hasQuickloginAccess } from "../services/quicklogin/eligibility";

// 用户自助快捷登录开关 /api/cqu/quicklogin。
//
// `cqu.quicklogin` 是 用户的产品启用开关:用户必须在设置里主动开启,DO 取票万能闸才允许
// 浏览器插件凭广域 scope 代他取一次性登录票(见 capabilities.ts 与 cqu-session.ts)。
// superAdmin 也能经 admin 路由写这条 entitlement,但日常应由用户自己掌控,故提供本自助端点。
//
// 功能开放闸 `cqu.quicklogin_access`(admin 授予,灰度/准入):无此权益的用户
// GET 拿到 eligible=false(设置页据此隐藏整张卡片),PUT 直接 403 —— 功能准入与产品启用分离,
// 未开放用户不能经任何路径自助打开快捷登录。
//
// 安全契约(关键):
//   - **鉴权只认 Better Auth session**(浏览器登录态),**绝不接受 Bearer/OAuth access token**。
//     若接受 Bearer,任一持有用户 access token 的 OAuth client 就能替用户翻这个开关
//     —— 等于 client 自助开启用户设备行为；第一方默认授权不自动启用产品或设备。
//     故本路由**不**复用 cqu.ts/cqu-bind.ts 的「Bearer 优先,回退 session」中间件,
//     也**不**挂在 cqu.ts 的 `/api/cqu/*` 子树下,而是独立挂载 `/api/cqu/quicklogin`。
//   - userId **只**取自 session.user.id(绝不取客户端入参);只读写调用者自己的
//     (userId, "cqu", "quicklogin") 这一条 entitlement,绝不触及他人或其它能力。
const cquQuicklogin = new Hono<HonoEnv>();

const SUBSYSTEM = "cqu";
const CAPABILITY = "quicklogin";
const VALUE_ON = "1";

// session-only 鉴权中间件。无有效 Better Auth session → 401。
// 故意不解析 Authorization: Bearer —— 见上方安全契约。
cquQuicklogin.use("/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (c.req.header("Authorization")) {
    return errorResponse(c, "UNAUTHORIZED", "未登录", 401);
  }
  return requireSession(c, next);
});

// 读调用者自己的一条 cqu entitlement 行;行缺失返回 undefined(约定:缺失 = 关/未授予)。
async function getOwnFlag(
  db: ReturnType<typeof drizzle>,
  userId: string,
  capability: string
) {
  return db
    .select()
    .from(userEntitlement)
    .where(
      and(
        eq(userEntitlement.userId, userId),
        eq(userEntitlement.subsystem, SUBSYSTEM),
        eq(userEntitlement.capability, capability)
      )
    )
    .get();
}

// GET /api/cqu/quicklogin → { eligible: boolean, enabled: boolean }
// eligible = 有 cqu.quicklogin_access(功能对该用户开放;设置页据此决定显隐);
// enabled = cqu.quicklogin === "1"(用户本人的产品启用开关,行缺失视为关)。
cquQuicklogin.get("/", async (c) => {
  const user = c.get("user") as { id: string };
  if (quickloginDeviceModeEnabled(c.env)) {
    const eligible = await hasQuickloginAccess(c.env, user.id);
    if (!eligible) return c.json({ eligible: false });
    const list = await new QuickloginAccountClient(c.env).listDevices(user.id, Date.now());
    return c.json({
      eligible: true,
      masterEnabled: list.masterEnabled,
      deviceLimit: list.deviceLimit,
      used: list.used,
    });
  }
  const db = drizzle(c.env.DATABASE);
  const [access, consent] = await Promise.all([
    hasQuickloginAccess(c.env, user.id),
    getOwnFlag(db, user.id, CAPABILITY),
  ]);
  return c.json({
    eligible: access,
    enabled: consent?.value === VALUE_ON,
  });
});

// PUT /api/cqu/quicklogin  body { enabled: boolean } → { enabled }
// 开:upsert 该行 value="1"(onConflictDoUpdate 按复合主键)。关:按复合主键删行(幂等)。
// 只动调用者自己的这一条 entitlement。
cquQuicklogin.put("/", async (c) => {
  const user = c.get("user") as { id: string };

  const origin = c.req.header("Origin");
  if (!origin || origin !== new URL(c.env.BETTER_AUTH_URL).origin) {
    return errorResponse(c, "FORBIDDEN", "禁止访问", 403);
  }

  if (quickloginDeviceModeEnabled(c.env)) {
    try {
      if (!(await hasQuickloginAccess(c.env, user.id))) {
        return errorResponse(c, "FORBIDDEN", "未开放浏览器插件快捷登录功能", 403);
      }
      const enabled = parseEnabled(await readJson(c.req.raw));
      const list = await new QuickloginAccountClient(c.env)
        .setMasterEnabled(user.id, enabled);
      return c.json({
        eligible: true,
        masterEnabled: list.masterEnabled,
        deviceLimit: list.deviceLimit,
        used: list.used,
      });
    } catch (error) {
      if (error instanceof QuickloginHttpError) {
        return errorResponse(c, error.code, error.code, error.status);
      }
      throw error;
    }
  }

  const db = drizzle(c.env.DATABASE);

  // 功能开放闸:无 cqu.quicklogin_access 的用户连自助开关都不能碰(与设置页显隐同源)。
  const access = await hasQuickloginAccess(c.env, user.id);
  if (!access) {
    return errorResponse(c, "FORBIDDEN", "未开放浏览器插件快捷登录功能", 403);
  }

  let enabled: boolean;
  try {
    enabled = parseEnabled(await readJson(c.req.raw));
  } catch (error) {
    if (error instanceof QuickloginHttpError) {
      return errorResponse(c, error.code, error.code, error.status);
    }
    throw error;
  }

  if (enabled) {
    // 开启:存在则更新 value,不存在则插入。复合主键 (user_id, subsystem, capability)。
    await db
      .insert(userEntitlement)
      .values({
        userId: user.id,
        subsystem: SUBSYSTEM,
        capability: CAPABILITY,
        value: VALUE_ON,
      })
      .onConflictDoUpdate({
        target: [
          userEntitlement.userId,
          userEntitlement.subsystem,
          userEntitlement.capability,
        ],
        set: { value: VALUE_ON },
      });
  } else {
    // 关闭:删行(约定:行缺失 = 关)。幂等 —— 删不存在的行是安全 no-op。
    await db
      .delete(userEntitlement)
      .where(
        and(
          eq(userEntitlement.userId, user.id),
          eq(userEntitlement.subsystem, SUBSYSTEM),
          eq(userEntitlement.capability, CAPABILITY)
        )
      );
  }
  return c.json({ enabled });
});

export { cquQuicklogin };
