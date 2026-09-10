import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { createAuth } from "../auth";
import { errorResponse } from "../utils/error";
import { QuickloginAccountClient } from "../services/quicklogin/account-client";
import {
  parseEnabled,
  QuickloginHttpError,
  readJson,
} from "../services/quicklogin/http";

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

// session-only 鉴权中间件。无有效 Better Auth session → 401。
// 故意不解析 Authorization: Bearer —— 见上方安全契约。
cquQuicklogin.use("/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  const auth = createAuth(c.env, c.req.raw);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) return errorResponse(c, "UNAUTHORIZED", "未登录", 401);
  c.set("user", session.user);
  return next();
});

// GET /api/cqu/quicklogin 返回账号协调器的权威总开关和额度状态。
cquQuicklogin.get("/", async (c) => {
  const user = c.get("user") as { id: string };
  const list = await new QuickloginAccountClient(c.env)
    .listDevices(user.id, Date.now());
  return c.json({
    masterEnabled: list.masterEnabled,
    deviceLimit: list.deviceLimit,
    used: list.used,
  });
});

// PUT 只接受同源网站 session，并由账号协调器串行修改总开关。
cquQuicklogin.put("/", async (c) => {
  const user = c.get("user") as { id: string };
  try {
    const origin = c.req.header("Origin");
    if (!origin || origin !== new URL(c.env.BETTER_AUTH_URL).origin) {
      return errorResponse(c, "FORBIDDEN", "禁止访问", 403);
    }
    const enabled = parseEnabled(await readJson(c.req.raw));
    const list = await new QuickloginAccountClient(c.env)
      .setMasterEnabled(user.id, enabled);
    return c.json({
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
});

export { cquQuicklogin };
