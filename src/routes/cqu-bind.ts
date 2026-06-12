import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { createAuth } from "../auth";
import { encrypt } from "../services/crypto";
import { errorResponse } from "../utils/error";
import { cquBindAddresses, cquCredentials } from "../db/schema";
import { genAddressToken } from "../services/cqu-2fa/token";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { verifyAccessToken } from "better-auth/oauth2";

// CQU 绑定 onboarding 后端路由（Phase 6.2）。
//
// 安全契约（关键）：每条路由的 DO/用户身份 **只** 从已认证的 session/JWT 推导
// （`c.get("user").id`），**绝不** 取自客户端请求体/查询参数。鉴权中间件与
// `cqu.ts` 完全一致（Bearer JWT 优先，回退 Better Auth session）。
//
// 路由路径（挂载于 /api/cqu/bind）：
//   POST /api/cqu/bind/address      签发/复用专属绑定地址（幂等）
//   GET  /api/cqu/bind/ws           升级 WS，转发到本用户 DO（bind_confirm 码秒推）
//   GET  /api/cqu/bind/status       绑定状态 + DO 会话状态
//   POST /api/cqu/bind/credentials  录入 CQU 凭证 + 触发首登，成功后标记 active
//
// 与 cqu.ts 的 `POST /api/cqu/bind`（精确路径）不冲突：本router 全部是
// /api/cqu/bind/<sub> 子路径，trie 中是独立节点，互不遮蔽。
const cquBind = new Hono<HonoEnv>();

cquBind.use("/*", async (c, next) => {
  const authHeader = c.req.header("Authorization");

  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.substring(7);
    try {
      const payload = await verifyAccessToken(token, {
        verifyOptions: {
          issuer: c.env.BETTER_AUTH_URL,
          audience: c.env.BETTER_AUTH_URL,
        },
        jwksUrl: `${c.env.BETTER_AUTH_URL}/api/auth/jwks`,
      });
      c.set("user", { id: payload.sub as string });
      return next();
    } catch {
      return errorResponse(c, "UNAUTHORIZED", "无效的访问令牌", 401);
    }
  }

  const auth = createAuth(c.env, c.req.raw);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) return errorResponse(c, "UNAUTHORIZED", "未登录", 401);
  c.set("user", session.user);
  return next();
});

// POST /api/cqu/bind/address
// 幂等：用户已有绑定地址行则直接返回；否则生成 token 写入 pending 行。
// 域名只取自 c.env.BIND_EMAIL_DOMAIN（vars，已接线）。
cquBind.post("/address", async (c) => {
  const user = c.get("user") as { id: string };
  const db = drizzle(c.env.DATABASE);

  const existing = await db
    .select()
    .from(cquBindAddresses)
    .where(eq(cquBindAddresses.userId, user.id))
    .get();

  if (existing) {
    return c.json({
      address: `${existing.token}@${c.env.BIND_EMAIL_DOMAIN}`,
      status: existing.status,
    });
  }

  const token = genAddressToken();
  await db.insert(cquBindAddresses).values({
    token,
    userId: user.id,
    kind: "direct",
    senderWhitelist: JSON.stringify(["sso@cqu.edu.cn"]),
    status: "pending",
  });

  return c.json({
    address: `${token}@${c.env.BIND_EMAIL_DOMAIN}`,
    status: "pending",
  });
});

// GET /api/cqu/bind/ws
// 认证后把原始请求 **原样** 转发给本用户 DO，让 DO 看到 Upgrade: websocket 并回 101。
// 用户 id 只来自 session/JWT；DO 按 idFromName(user.id) 寻址。
cquBind.get("/ws", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") {
    return errorResponse(c, "UPGRADE_REQUIRED", "需要 WebSocket 升级请求", 426);
  }
  const user = c.get("user") as { id: string };
  const stub = c.env.CQU_SESSION.get(c.env.CQU_SESSION.idFromName(user.id));
  // 原始请求不可改：DO 的 WS 升级分支依赖 Upgrade 头返回 101 + webSocket。
  return stub.fetch(c.req.raw);
});

// GET /api/cqu/bind/status
// 返回 { address?, bindStatus, sessionStatus }：
//   - bindStatus / address 来自 cqu_bind_addresses 行（地址用 token + 域名重建）
//   - sessionStatus 来自 DO 的 status action
cquBind.get("/status", async (c) => {
  const user = c.get("user") as { id: string };
  const db = drizzle(c.env.DATABASE);

  const bind = await db
    .select()
    .from(cquBindAddresses)
    .where(eq(cquBindAddresses.userId, user.id))
    .get();

  const stub = c.env.CQU_SESSION.get(c.env.CQU_SESSION.idFromName(user.id));
  const resp = await stub.fetch(new Request("https://do/status"));
  const sessionStatus = await resp.json();

  return c.json({
    address: bind ? `${bind.token}@${c.env.BIND_EMAIL_DOMAIN}` : undefined,
    bindStatus: bind?.status,
    sessionStatus,
  });
});

// POST /api/cqu/bind/credentials
// body { studentId, password }。要求已存在绑定地址行（否则 400 "先获取绑定地址"）。
// 加密密码 → upsert cqu_credentials → 触发 DO /init 首登。
// 成功 → cqu_bind_addresses.status = "active"；失败 → 返回错误，不标记 active。
cquBind.post("/credentials", async (c) => {
  const user = c.get("user") as { id: string };
  const { studentId, password } = await c.req.json<{
    studentId: string;
    password: string;
  }>();

  if (!studentId || !password) {
    return errorResponse(c, "MISSING_FIELDS", "缺少学号或密码", 400);
  }

  const db = drizzle(c.env.DATABASE);

  const bind = await db
    .select()
    .from(cquBindAddresses)
    .where(eq(cquBindAddresses.userId, user.id))
    .get();
  if (!bind) {
    return errorResponse(c, "NO_BIND_ADDRESS", "先获取绑定地址", 400);
  }

  const { ciphertext, iv } = await encrypt(password, c.env.ENCRYPTION_KEY);

  // upsert cqu_credentials（复刻 cqu.ts 的 insert/update 形状）。
  const existingCreds = await db
    .select()
    .from(cquCredentials)
    .where(eq(cquCredentials.userId, user.id))
    .get();
  if (existingCreds) {
    await db
      .update(cquCredentials)
      .set({ studentId, encryptedPassword: ciphertext, iv })
      .where(eq(cquCredentials.userId, user.id));
  } else {
    await db.insert(cquCredentials).values({
      id: crypto.randomUUID(),
      userId: user.id,
      studentId,
      encryptedPassword: ciphertext,
      iv,
    });
  }

  // 触发 DO 首登。userId 只来自 session（绝不取客户端入参）。
  const stub = c.env.CQU_SESSION.get(c.env.CQU_SESSION.idFromName(user.id));
  const result = await stub.fetch(
    new Request("https://do/init", {
      method: "POST",
      body: JSON.stringify({
        userId: user.id,
        studentId,
        encryptedPassword: ciphertext,
        iv,
      }),
    })
  );
  const initResult = await result.json<{ success: boolean; error?: string }>();

  if (!initResult.success) {
    // 首登未成功：保留 pending，不标记 active。
    return errorResponse(
      c,
      "CQU_LOGIN_FAILED",
      initResult.error ?? "CQU 登录失败",
      400
    );
  }

  await db
    .update(cquBindAddresses)
    .set({ status: "active" })
    .where(eq(cquBindAddresses.userId, user.id));

  return c.json({ success: true, studentId });
});

export { cquBind };
