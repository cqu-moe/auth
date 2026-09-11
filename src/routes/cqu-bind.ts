import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { encrypt } from "../services/crypto";
import { errorResponse } from "../utils/error";
import { cquBindAddresses, cquCredentials } from "../db/schema";
import { genAddressToken } from "../services/cqu-2fa/token";
import { CQU_SENDER } from "../services/cqu-2fa/sender-auth";
import { drizzle } from "drizzle-orm/d1";
import { eq, sql } from "drizzle-orm";
import { getCquBinding } from "../services/cqu-binding";
import { requireSessionOrBearer } from "../middleware/authentication";

// CQU 绑定资源路由（RESTful 重构）。
//
// 资源 = 单数 `/api/cqu/binding`（每用户至多一条绑定行）。挂载于 `/api/cqu/binding`。
//   POST   /api/cqu/binding              创建绑定、签发专属地址（幂等：已存在→200，新建→201）
//   GET    /api/cqu/binding              绑定状态 + DO 会话状态
//   PUT    /api/cqu/binding/credentials  设凭证 + 触发首登，成功后标记 active
//   GET    /api/cqu/binding/events       升级 WS，转发到本用户 DO（bind_confirm 码秒推）
//   DELETE /api/cqu/binding              彻底解绑（删两表 + DO destroy），成功 204
//
// 安全契约（关键）：每条路由的 DO/用户身份 **只** 从已认证的 session/JWT 推导
// （`c.get("user").id`），**绝不** 取自客户端请求体/查询参数。鉴权中间件与
// `cqu.ts` 完全一致（Bearer JWT 优先，回退 Better Auth session）。
const cquBinding = new Hono<HonoEnv>();

cquBinding.use("/*", requireSessionOrBearer);

// 基础邮箱格式校验（仅 forward 模式登记用户转发地址时使用）。不追求 RFC 完整性——只挡明显畸形，
// 真正的可达性由后续真实转发邮件的 envelope 校验背书。
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /api/cqu/binding （← 原 POST /address）
// 创建绑定、签发专属地址。
// 幂等：用户已有绑定地址行则直接返回现状（200），不因本次请求改 kind/whitelist；
//       新建成功返回 201。
// body { kind?: "direct"|"forward", forwardAddress?: string }：
//   - 缺省 / "direct"：whitelist=["sso@cqu.edu.cn"]（现状）。
//   - "forward"：要求 forwardAddress 是合法邮箱，whitelist=去重([该地址规范化(trim+lower), CQU_SENDER])。
//     双源白名单覆盖两类转发器：真转发（如 Fastmail "Send a copy to"，保留原始信封 sso@cqu.edu.cn）
//     与 SRS 改写（信封变成转发方地址）。若 forwardAddress 规范化后即 CQU_SENDER，去重后只留一个。
// userId 只取自 session/JWT（绝不取客户端入参）；域名只取自 c.env.BIND_EMAIL_DOMAIN。
cquBinding.post("/", async (c) => {
  const user = c.get("user") as { id: string };
  const db = drizzle(c.env.DATABASE);

  // 兼容空 body（旧前端不带 body 调用，无 Content-Type 的 POST）：空 body 视为 {} 等价「缺省 direct」。
  // 非空 body 才解析；畸形 JSON 不裸 500，统一返回 400 INVALID_BODY。
  let body: { kind?: string; forwardAddress?: string };
  const raw = await c.req.text();
  if (raw.trim() === "") {
    body = {};
  } else {
    try {
      body = JSON.parse(raw) as { kind?: string; forwardAddress?: string };
    } catch {
      return errorResponse(c, "INVALID_BODY", "请求体不是合法 JSON", 400);
    }
  }

  // 解析绑定方式。仅在创建新行时生效；已存在行保持原 kind（幂等，见下）。
  let kind: "direct" | "forward" = "direct";
  let senderWhitelist = JSON.stringify(["sso@cqu.edu.cn"]);
  if (body.kind === "forward") {
    // 转发模式暂时禁用：前端已置灰不可选，此处再做后端硬拦截，防止绕过前端直接调用。
    // 下方 forward 白名单构造逻辑保留在代码里（待重新开放），但因前置 return 永不执行。
    return errorResponse(c, "FORWARD_MODE_DISABLED", "转发模式暂未开放，请使用直设模式", 403);
    const forwardAddress = (body.forwardAddress ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(forwardAddress)) {
      return errorResponse(c, "INVALID_FORWARD_ADDRESS", "转发邮箱地址不合法", 400);
    }
    kind = "forward";
    // 双源白名单：用户转发地址 + CQU_SENDER。去重——forwardAddress 规范化后若 === CQU_SENDER 只留一个。
    const whitelist =
      forwardAddress === CQU_SENDER ? [CQU_SENDER] : [forwardAddress, CQU_SENDER];
    senderWhitelist = JSON.stringify(whitelist);
  } else if (body.kind !== undefined && body.kind !== "direct") {
    return errorResponse(c, "INVALID_KIND", "未知的绑定方式", 400);
  }

  const existing = await db
    .select()
    .from(cquBindAddresses)
    .where(eq(cquBindAddresses.userId, user.id))
    .get();

  // 幂等：已存在绑定行直接返回现状（200），**不**因本次请求改 kind/whitelist。
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
      kind,
      senderWhitelist,
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

  // 新建成功 → 201 Created。
  return c.json(
    {
      address: `${token}@${c.env.BIND_EMAIL_DOMAIN}`,
      status: "pending",
    },
    201
  );
});

// GET /api/cqu/binding （← 原 GET /status）
// 返回 { address?, bindStatus, sessionStatus }：
//   - bindStatus 优先取凭证状态；address 用邮箱绑定 token + 域名重建
//   - sessionStatus 来自 DO 的 status action
cquBinding.get("/", async (c) => {
  const user = c.get("user") as { id: string };
  const binding = await getCquBinding(c.env.DATABASE, user.id);

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
    address: binding.token ? `${binding.token}@${c.env.BIND_EMAIL_DOMAIN}` : undefined,
    bindStatus: binding.bindStatus,
    kind: binding.token ? binding.kind : undefined,
    forwardAddress: binding.token ? binding.forwardAddress : undefined,
    sessionStatus,
  });
});

// PUT /api/cqu/binding/credentials （← 原 POST /credentials）
// body { studentId, password }。要求已存在绑定地址行（否则 400 "先获取绑定地址"）。
// 加密密码 → upsert cqu_credentials → 触发 DO /init 首登。
// 成功 → cqu_bind_addresses.status = "active"；首登失败 → 回滚本次新插入的凭证行
// （对齐 cqu.ts），绑定地址保留 pending，不标记 active。
cquBinding.put("/credentials", async (c) => {
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
    return errorResponse(c, "MISSING_FIELDS", "缺少统一身份认证账号或密码", 400);
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
        // First login has not succeeded yet. The schema default remains active
        // for legacy entry points, so this route must opt into pending explicitly.
        status: "pending",
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
    await db.batch([
      db
        .update(cquBindAddresses)
        .set({ status: "active" })
        .where(eq(cquBindAddresses.userId, user.id)),
      db
        .update(cquCredentials)
        .set({ status: "active" })
        .where(eq(cquCredentials.userId, user.id)),
    ]);
  } catch (err) {
    console.error("[cqu-binding] activate update failed after successful init", {
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

// GET /api/cqu/binding/events （← 原 GET /ws）
// 认证后把原始请求 **原样** 转发给本用户 DO，让 DO 看到 Upgrade: websocket 并回 101。
// 用户 id 只来自 session/JWT；DO 按 idFromName(user.id) 寻址。
cquBinding.get("/events", async (c) => {
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

// DELETE /api/cqu/binding （← 原 POST /unbind）
// 彻底解绑：删除 cqu_credentials + cqu_bind_addresses（旧 DELETE /api/cqu/bind 漏删了
// 后者，残留地址行会让创建幂等命中旧 token、绑定状态显示错乱），再 destroy DO 会话。
// 成功返回 204（无 body）。
// userId 只取自 session/JWT（鉴权中间件已 set），绝不取客户端入参。
// 删表失败返回可重试错误而非裸 500；DO destroy 失败仅记日志不阻断（两张表已删干净，
// 业务上已是解绑态，DO 储存会在下次保活/重绑时被覆盖）。
cquBinding.delete("/", async (c) => {
  const user = c.get("user") as { id: string };
  const db = drizzle(c.env.DATABASE);

  // ① 删凭证表。② 删绑定地址表。任一失败都返回可重试错误，避免半解绑残留。
  try {
    await db.delete(cquCredentials).where(eq(cquCredentials.userId, user.id));
  } catch (err) {
    console.error("[cqu-binding] unbind: delete cqu_credentials failed", {
      userId: user.id,
      err,
    });
    return errorResponse(c, "UNBIND_FAILED", "解绑失败，请稍后重试", 503);
  }

  try {
    await db.delete(cquBindAddresses).where(eq(cquBindAddresses.userId, user.id));
  } catch (err) {
    console.error("[cqu-binding] unbind: delete cqu_bind_addresses failed", {
      userId: user.id,
      err,
    });
    return errorResponse(c, "UNBIND_FAILED", "解绑失败，请稍后重试", 503);
  }

  // ③ DO destroy：best-effort。两张表已删，业务上已解绑；DO 失败不应回滚或阻断成功响应。
  try {
    const stub = c.env.CQU_SESSION.get(c.env.CQU_SESSION.idFromName(user.id));
    await stub.fetch(new Request("https://do/destroy", { method: "POST" }));
  } catch (err) {
    console.error("[cqu-binding] unbind: DO destroy failed (non-fatal)", {
      userId: user.id,
      err,
    });
  }

  // 成功解绑 → 204 No Content（无 body）。
  return c.body(null, 204);
});

export { cquBinding };
