import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { errorResponse } from "../utils/error";
import { userEntitlement } from "../db/schema";
import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";
import { requireSession } from "../middleware/authentication";

// 用户自助快捷登录开关 /api/cqu/quicklogin。
//
// `cqu.quicklogin` 是 per-user 同意开关:用户必须在设置里主动开启,DO 取票万能闸才允许
// 浏览器插件凭广域 scope 代他取一次性登录票(见 capabilities.ts 与 cqu-session.ts)。
// superAdmin 也能经 admin 路由写这条 entitlement,但日常应由用户自己掌控,故提供本自助端点。
//
// 功能开放闸 `cqu.quicklogin_access`(admin 授予,灰度/准入):无此权益的用户
// GET 拿到 eligible=false(设置页据此隐藏整张卡片),PUT 直接 403 —— 准入与同意分离,
// 未开放用户不能经任何路径自助打开快捷登录。
//
// 安全契约(关键):
//   - **鉴权只认 Better Auth session**(浏览器登录态),**绝不接受 Bearer/OAuth access token**。
//     若接受 Bearer,任一持有用户 access token 的 OAuth client 就能替用户翻这个开关
//     —— 等于 client 自助授权自己的快捷登录,破坏「用户须亲自 opt-in」红线。
//     故本路由**不**复用 cqu.ts/cqu-bind.ts 的「Bearer 优先,回退 session」中间件,
//     也**不**挂在 cqu.ts 的 `/api/cqu/*` 子树下,而是独立挂载 `/api/cqu/quicklogin`。
//   - userId **只**取自 session.user.id(绝不取客户端入参);只读写调用者自己的
//     (userId, "cqu", "quicklogin") 这一条 entitlement,绝不触及他人或其它能力。
const cquQuicklogin = new Hono<HonoEnv>();

const SUBSYSTEM = "cqu";
const CAPABILITY = "quicklogin";
const ACCESS_CAPABILITY = "quicklogin_access";
const VALUE_ON = "1";

// session-only 鉴权中间件。无有效 Better Auth session → 401。
// 故意不解析 Authorization: Bearer —— 见上方安全契约。
cquQuicklogin.use("/*", requireSession);

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
// enabled = cqu.quicklogin === "1"(用户本人的同意开关,行缺失视为关)。
cquQuicklogin.get("/", async (c) => {
  const user = c.get("user") as { id: string };
  const db = drizzle(c.env.DATABASE);
  const [access, consent] = await Promise.all([
    getOwnFlag(db, user.id, ACCESS_CAPABILITY),
    getOwnFlag(db, user.id, CAPABILITY),
  ]);
  return c.json({
    eligible: access?.value === VALUE_ON,
    enabled: consent?.value === VALUE_ON,
  });
});

// PUT /api/cqu/quicklogin  body { enabled: boolean } → { enabled }
// 开:upsert 该行 value="1"(onConflictDoUpdate 按复合主键)。关:按复合主键删行(幂等)。
// 只动调用者自己的这一条 entitlement。
cquQuicklogin.put("/", async (c) => {
  const user = c.get("user") as { id: string };

  const db = drizzle(c.env.DATABASE);

  // 功能开放闸:无 cqu.quicklogin_access 的用户连自助开关都不能碰(与设置页显隐同源)。
  const access = await getOwnFlag(db, user.id, ACCESS_CAPABILITY);
  if (access?.value !== VALUE_ON) {
    return errorResponse(c, "FORBIDDEN", "未开放浏览器插件快捷登录功能", 403);
  }

  let body: { enabled?: unknown };
  try {
    body = await c.req.json<{ enabled?: unknown }>();
  } catch {
    return errorResponse(c, "INVALID_BODY", "请求体不是合法 JSON", 400);
  }
  if (typeof body.enabled !== "boolean") {
    return errorResponse(c, "INVALID_BODY", "enabled 必须是布尔值", 400);
  }

  if (body.enabled) {
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
  return c.json({ enabled: body.enabled });
});

export { cquQuicklogin };
