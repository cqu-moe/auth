import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { createAuth } from "../auth";
import { encrypt } from "../services/crypto";
import { errorResponse } from "../utils/error";
import { cquBindAddresses, cquCredentials } from "../db/schema";
import { genAddressToken } from "../services/cqu-2fa/token";
import { drizzle } from "drizzle-orm/d1";
import { eq, sql } from "drizzle-orm";
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
  try {
    await db.insert(cquBindAddresses).values({
      token,
      userId: user.id,
      kind: "direct",
      senderWhitelist: JSON.stringify(["sso@cqu.edu.cn"]),
      status: "pending",
      // 显式写真实时间戳：即便列默认值损坏（历史遗留），新行也拿到正确时间。
      boundAt: sql`(datetime('now'))`,
    });
  } catch (err) {
    // #6: 并发同用户请求会撞 user_id UNIQUE 约束。优雅退化到「返回已存在行」，
    // 而非裸 500。重查一次；查不到才说明是别的故障，照常抛出。
    const raced = await db
      .select()
      .from(cquBindAddresses)
      .where(eq(cquBindAddresses.userId, user.id))
      .get();
    if (!raced) throw err;
    return c.json({
      address: `${raced.token}@${c.env.BIND_EMAIL_DOMAIN}`,
      status: raced.status,
    });
  }

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
  // CSWSH 防护：WS 握手不受 CORS 约束，但浏览器会在跨源握手时携带 session cookie。
  // 恶意站点可借受害者 cookie 打开本端点并接收推送的 bind_code。session 级 DO 寻址
  // 拦不住（同一用户被跨源劫持），必须在转发前校验 Origin 同源。浏览器握手必带 Origin，
  // 缺失 Origin 视为可疑（非浏览器）一并拒绝。
  const origin = c.req.header("Origin");
  const allowedOrigin = new URL(c.env.BETTER_AUTH_URL).origin;
  if (!origin || origin !== allowedOrigin) {
    return errorResponse(c, "FORBIDDEN_ORIGIN", "WebSocket 来源不被允许", 403);
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
  // #1: DO 非 2xx（如 500 {error,code}）不能当成 status 载荷直接回传给客户端；
  // 解析失败同样兜底为 sentinel，避免把 DO 故障伪装成会话状态。
  let sessionStatus: unknown;
  if (resp.ok) {
    sessionStatus = await resp.json().catch(() => ({ error: true }));
  } else {
    sessionStatus = { error: true };
  }

  return c.json({
    // #7: bindStatus 始终返回，无绑定时为 "unbound"，让客户端能区分「无绑定」与「响应异常」。
    address: bind ? `${bind.token}@${c.env.BIND_EMAIL_DOMAIN}` : undefined,
    bindStatus: bind?.status ?? "unbound",
    sessionStatus,
  });
});

// POST /api/cqu/bind/credentials
// body { studentId, password }。要求已存在绑定地址行（否则 400 "先获取绑定地址"）。
// 加密密码 → upsert cqu_credentials → 触发 DO /init 首登。
// 成功 → cqu_bind_addresses.status = "active"；首登失败 → 回滚本次新插入的凭证行
// （对齐 cqu.ts），绑定地址保留 pending，不标记 active。
cquBind.post("/credentials", async (c) => {
  const user = c.get("user") as { id: string };

  // #5: 畸形 JSON body 不应裸 500，统一返回 400 INVALID_BODY。
  let body: { studentId?: string; password?: string };
  try {
    body = await c.req.json<{ studentId?: string; password?: string }>();
  } catch {
    return errorResponse(c, "INVALID_BODY", "请求体不是合法 JSON", 400);
  }
  const { studentId, password } = body;

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
  // #3: 记录本次是「插入新行」还是「更新已有行」——首登失败需据此回滚：
  //   插入的新行要删掉，否则残留行会把 cqu.ts 的 POST /bind 卡成 409 ALREADY_BOUND；
  //   更新的旧行保留（对齐 PUT /bind 语义，不破坏既有绑定）。
  const existingCreds = await db
    .select()
    .from(cquCredentials)
    .where(eq(cquCredentials.userId, user.id))
    .get();
  let insertedCredsId: string | null = null;
  if (existingCreds) {
    await db
      .update(cquCredentials)
      .set({ studentId, encryptedPassword: ciphertext, iv })
      .where(eq(cquCredentials.userId, user.id));
  } else {
    const newId = crypto.randomUUID();
    try {
      await db.insert(cquCredentials).values({
        id: newId,
        userId: user.id,
        studentId,
        encryptedPassword: ciphertext,
        iv,
        // 显式写真实时间戳：即便列默认值损坏（历史遗留），新行也拿到正确时间。
        boundAt: sql`(datetime('now'))`,
      });
      insertedCredsId = newId;
    } catch (err) {
      // #6: 并发同用户请求会撞 user_id UNIQUE。退化为「更新已有行」（视作 existing，
      // 不持有回滚权），而非裸 500。
      const raced = await db
        .select()
        .from(cquCredentials)
        .where(eq(cquCredentials.userId, user.id))
        .get();
      if (!raced) throw err;
      await db
        .update(cquCredentials)
        .set({ studentId, encryptedPassword: ciphertext, iv })
        .where(eq(cquCredentials.userId, user.id));
    }
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
  // #1: DO /init 响应非 2xx 或非 JSON 不应抛未捕获异常。解析失败兜底为
  // {success:false}，与「首登未成功」走同一回滚分支。
  const initResult = result.ok
    ? await result
        .json<{ success: boolean; error?: string }>()
        .catch(() => ({ success: false, error: undefined as string | undefined }))
    : { success: false, error: undefined as string | undefined };

  if (!initResult.success) {
    // #3: 首登未成功。本次若 INSERT 了新凭证行，回滚删除（避免半绑定残留卡死
    // cqu.ts 的 POST /bind）；若是更新已有行则保留（对齐 PUT /bind）。
    // 绑定地址行无论如何留 pending（正确）。
    if (insertedCredsId) {
      await db
        .delete(cquCredentials)
        .where(eq(cquCredentials.id, insertedCredsId));
    }
    return errorResponse(
      c,
      "CQU_LOGIN_FAILED",
      initResult.error ?? "CQU 登录失败",
      400
    );
  }

  // #4: 首登已成功、DO 已初始化。若这步置 active 的 D1 写抛错，返回独立的
  // 可重试错误而非裸 500——重试 /credentials 是安全的（重登 + 重置 active）。
  try {
    await db
      .update(cquBindAddresses)
      .set({ status: "active" })
      .where(eq(cquBindAddresses.userId, user.id));
  } catch (err) {
    console.error("[cqu-bind] activate update failed after successful init", {
      userId: user.id,
      err,
    });
    return errorResponse(
      c,
      "BIND_ACTIVATE_FAILED",
      "首登成功但激活状态写入失败，请重试",
      503
    );
  }

  return c.json({ success: true, studentId });
});

export { cquBind };
