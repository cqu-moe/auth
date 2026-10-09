import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { encrypt } from "../services/crypto";
import { errorResponse } from "../utils/error";
import { cquBindAddresses, cquCredentials } from "../db/schema";
import { genAddressToken } from "../services/cqu-2fa/token";
import { drizzle } from "drizzle-orm/d1";
import { and, eq, sql } from "drizzle-orm";
import { getCquBinding } from "../services/cqu-binding";
import { requireSession } from "../middleware/authentication";
import { JsonBodyError, parseJsonBody } from "../api/validation";
import { CquCredentialsBody, CreateCquBindingBody } from "../api/v1/cqu-binding.schema";
import { captureHonoEvent, captureHonoException } from "../lib/posthog";

// CQU 绑定资源路由（RESTful 重构）。
//
// 资源 = 单数 `/api/cqu/binding`（每用户至多一条绑定行）。挂载于 `/api/cqu/binding`。
//   POST   /api/cqu/binding              创建绑定、签发专属地址（幂等：已存在→200，新建→201）
//   GET    /api/cqu/binding              绑定状态 + DO 会话状态
//   PUT    /api/cqu/binding/credentials  设凭证 + 触发首登，成功后标记 active
//   GET    /api/cqu/binding/events       升级 WS，转发到本用户 DO（bind_confirm 码秒推）
//   DELETE /api/cqu/binding              彻底解绑（删两表 + DO destroy），成功 204
//
// 安全契约（关键）：每条路由的 DO/用户身份 **只** 从已认证的 session 推导
// （`c.get("user").id`），**绝不** 取自客户端请求体/查询参数。
// #21：绑定管理收敛为 session-only —— Bearer 分支不检查 scope 内容，任意
// scope 的 token 都能读地址/换凭据/销毁绑定；SPA 本就全程 cookie，无合法
// Bearer 调用方。程序化取票走 /api/cqu/service-ticket（scope+D1 双检）。
const cquBinding = new Hono<HonoEnv>();

cquBinding.use("/*", requireSession);

// POST /api/cqu/binding （← 原 POST /address）
// 创建绑定、签发专属地址。
// 幂等：用户已有绑定地址行则直接返回现状（200），不因本次请求改 kind/whitelist；
//       新建成功返回 201。
// body { kind?: "direct"|"forward" }：
//   - 缺省 / "direct"：whitelist=["sso@cqu.edu.cn"]（现状）。
//   - "forward"：新建仍被硬性禁用；旧 forward 记录的读取和邮件处理不受影响。
// userId 只取自 session/JWT（绝不取客户端入参）；域名只取自 c.env.BIND_EMAIL_DOMAIN。
cquBinding.post("/", async (c) => {
  const user = c.get("user") as { id: string };
  const db = drizzle(c.env.DATABASE);

  // 兼容空 body（旧前端不带 body 调用，无 Content-Type 的 POST）：空 body 视为 {} 等价「缺省 direct」。
  // 非空 body 才解析；畸形 JSON 不裸 500，统一返回 400 INVALID_BODY。
  let body: { kind?: "direct" | "forward" };
  try {
    body = await parseJsonBody(c.req.raw, CreateCquBindingBody, { optionalEmpty: true });
  } catch (error) {
    if (!(error instanceof JsonBodyError)) throw error;
    return errorResponse(c, error.code, error.code === "UNSUPPORTED_MEDIA_TYPE"
      ? "仅支持 JSON 请求体" : "请求体无效", error.status);
  }

  // 解析绑定方式。仅在创建新行时生效；已存在行保持原 kind（幂等，见下）。
  let kind: "direct" | "forward" = "direct";
  let senderWhitelist = JSON.stringify(["sso@cqu.edu.cn"]);
  if (body.kind === "forward") {
    // 转发模式暂时禁用：前端已置灰不可选，此处再做后端硬拦截，防止绕过前端直接调用。
    return errorResponse(c, "FORWARD_MODE_DISABLED", "转发模式暂未开放，请使用直设模式", 403);
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
// 加密密码 → 触发 DO /init 首登 → 成功后 upsert cqu_credentials 并把两表标记 active。
// 首登失败不写 D1 凭据，绑定地址保留原状态；并发提交也不会覆盖当前有效凭据。
cquBinding.put("/credentials", async (c) => {
  const user = c.get("user") as { id: string };
  const startedAt = Date.now();

  // #5: 畸形 JSON body 不应裸 500，统一返回 400 INVALID_BODY。
  let body: { studentId: string; password: string };
  try {
    body = await parseJsonBody(c.req.raw, CquCredentialsBody);
  } catch (error) {
    if (!(error instanceof JsonBodyError)) throw error;
    return errorResponse(c, error.code, error.code === "UNSUPPORTED_MEDIA_TYPE"
      ? "仅支持 JSON 请求体" : "请求体无效", error.status);
  }
  const { studentId, password } = body;

  const db = drizzle(c.env.DATABASE);

  const bind = await db
    .select()
    .from(cquBindAddresses)
    .where(eq(cquBindAddresses.userId, user.id))
    .get();
  if (bind?.status === "deleting" || bind?.status === "revoked") {
    return errorResponse(c, "BINDING_UNAVAILABLE", "绑定已停用或正在解绑", 409);
  }
  if (!bind) {
    return errorResponse(c, "NO_BIND_ADDRESS", "先获取绑定地址", 400);
  }

  const { ciphertext, iv } = await encrypt(password, c.env.ENCRYPTION_KEY);

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
  // {success:false}，与「首登未成功」走同一失败分支。
  const initResult = result.ok
    ? await result
        .json<{ success: boolean; error?: string; code?: string }>()
        .catch(() => ({
          success: false,
          error: undefined as string | undefined,
          code: undefined as string | undefined,
        }))
    : {
        success: false,
        error: undefined as string | undefined,
        code: undefined as string | undefined,
      };

  if (!initResult.success) {
    // DO 未成功时尚未写 D1，现有凭据与绑定状态保持原样。
    const inFlight = initResult.code === "CQU_LOGIN_IN_FLIGHT";
    return errorResponse(
      c,
      inFlight ? "CQU_LOGIN_IN_FLIGHT" : "CQU_LOGIN_FAILED",
      initResult.error ?? "CQU 登录失败",
      inFlight ? 409 : 400
    );
  }

  // DO 登录成功后才持久化新凭据并激活两张表。若 D1 写失败，返回独立的可重试
  // 错误；重试 /credentials 会重新登录并完成同一组幂等写入。
  try {
    // The binding token fences a completed login against concurrent deletion
    // and re-creation. The conditional upsert and activation are one D1 batch.
    const writes = await c.env.DATABASE.batch([
      c.env.DATABASE.prepare(`INSERT INTO cqu_credentials
        (id,user_id,student_id,encrypted_password,iv,status)
        SELECT ?,user_id,?,?,?,'active' FROM cqu_bind_addresses
        WHERE user_id = ? AND token = ? AND status IN ('pending','active')
        ON CONFLICT(user_id) DO UPDATE SET student_id=excluded.student_id,
        encrypted_password=excluded.encrypted_password,iv=excluded.iv,status='active'
        WHERE cqu_credentials.status != 'deleting' AND cqu_credentials.status != 'revoked'`)
        .bind(crypto.randomUUID(), studentId, ciphertext, iv, user.id, bind.token),
      c.env.DATABASE.prepare("UPDATE cqu_bind_addresses SET status='active' WHERE user_id=? AND token=? AND status IN ('pending','active')")
        .bind(user.id, bind.token),
    ]);
    if (!writes[0].meta.changes || !writes[1].meta.changes) {
      return errorResponse(c, "BINDING_UNAVAILABLE", "绑定已停用或正在解绑", 409);
    }
  } catch (err) {
    console.error("[cqu-binding] activate update failed after successful init", {
      userId: user.id,
      err,
    });
    captureHonoException(err, c, { component: "cqu-binding", error_code: "BIND_ACTIVATE_FAILED" });
    return errorResponse(
      c,
      "BIND_ACTIVATE_FAILED",
      "首登成功但激活状态写入失败，请重试",
      503
    );
  }

  captureHonoEvent(c, "cqu_binding_completed", user.id, {
    outcome: "success",
    duration_ms: Date.now() - startedAt,
  });

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

// D1 keeps the deletion intent until DO cleanup is acknowledged. A failed
// request can be retried without losing the identity of the pending binding.
cquBinding.delete("/", async (c) => {
  const user = c.get("user") as { id: string };
  const db = drizzle(c.env.DATABASE);
  try {
    await db.batch([
      db.update(cquCredentials).set({ status: "deleting" }).where(eq(cquCredentials.userId, user.id)),
      db.update(cquBindAddresses).set({ status: "deleting" }).where(eq(cquBindAddresses.userId, user.id)),
    ]);
    const stub = c.env.CQU_SESSION.get(c.env.CQU_SESSION.idFromName(user.id));
    const response = await stub.fetch(new Request("https://do/destroy", { method: "POST", body: JSON.stringify({ userId: user.id }) }));
    if (!response.ok) throw new Error("CQU cleanup was not acknowledged");
    await db.batch([
      db.delete(cquCredentials).where(and(eq(cquCredentials.userId, user.id), eq(cquCredentials.status, "deleting"))),
      db.delete(cquBindAddresses).where(and(eq(cquBindAddresses.userId, user.id), eq(cquBindAddresses.status, "deleting"))),
    ]);
    return c.body(null, 204);
  } catch {
    return errorResponse(c, "UNBIND_FAILED", "解绑尚未完成，请稍后重试", 503);
  }
});

export { cquBinding };
