import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { APIError } from "better-auth/api";
import type { HonoEnv } from "../types";
import { createAuth, OAUTH_SCOPES } from "../auth";
import { isLoopbackHost } from "@better-auth/core/utils/host";
import { errorResponse } from "../utils/error";
import { oauthClientCquScopes, cquBindAddresses, userEntitlement } from "../db/schema";
import {
  hashOAuthClientSecret,
  generateOAuthClientSecret,
} from "../utils/oauth-secret";
import {
  validateEntitlementItems,
  listPresets,
  getPresetItems,
  upsertPreset,
  deletePreset,
  getDefaultPresetName,
  setDefaultPresetName,
  isInvitationRequired,
  setInvitationRequired,
} from "../services/entitlements";
import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";
import {
  createRegistrationInvitation,
  InvitationError,
  listRegistrationInvitations,
  revokeRegistrationInvitation,
} from "../services/registration-invitations";
import { requireAdmin } from "../middleware/authentication";

const admin = new Hono<HonoEnv>();

// Plugin endpoints (adminCreateOAuthClient/adminUpdateOAuthClient) throw
// APIError on validation/authorization failures. Called via auth.api.* without
// a catch, those bubble up as opaque 500s — translate them into the project's
// structured errorResponse shape, preserving the OAuth error_description.
function oauthClientError(c: Context<HonoEnv>, e: unknown) {
  if (e instanceof APIError) {
    const body = e.body as
      | { error_description?: string; message?: string }
      | undefined;
    const msg =
      body?.error_description ?? body?.message ?? "OAuth 客户端操作失败";
    // APIError.status can be a string name ("BAD_REQUEST") or a number; the
    // companion statusCode is always numeric, so prefer it for the HTTP status.
    const status = typeof e.statusCode === "number" ? e.statusCode : 400;
    return errorResponse(
      c,
      "OAUTH_CLIENT_ERROR",
      msg,
      status as ContentfulStatusCode
    );
  }
  return errorResponse(c, "INTERNAL_ERROR", "服务器内部错误", 500);
}

// Map OAuth snake_case update fields to the oauthClient DB model (camelCase),
// mirroring the plugin's oauthToSchema. Needed because the plugin update endpoint
// enforces a userId owner check admins can't satisfy, so we write via the adapter.
function oauthClientUpdateToSchema(update: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const map: Record<string, string> = {
    client_name: "name", client_uri: "uri", logo_uri: "icon", tos_uri: "tos",
    policy_uri: "policy", token_endpoint_auth_method: "tokenEndpointAuthMethod",
    type: "type", subject_type: "subjectType", contacts: "contacts",
    redirect_uris: "redirectUris", post_logout_redirect_uris: "postLogoutRedirectUris",
    grant_types: "grantTypes", response_types: "responseTypes",
    skip_consent: "skipConsent", enable_end_session: "enableEndSession",
    require_pkce: "requirePKCE", disabled: "disabled", metadata: "metadata",
  };
  for (const [snake, camel] of Object.entries(map)) {
    if (update[snake] !== undefined) out[camel] = update[snake];
  }
  // scope is a space-delimited string in the OAuth API but stored as scopes[]
  if (typeof update.scope === "string") {
    out.scopes = update.scope.split(" ").filter(Boolean);
  }
  // Keep the public flag in sync with the auth method: the plugin derives
  // isPublic = (token_endpoint_auth_method === "none") on create, and token
  // validation reads client.public — so an auth-method edit must update it too,
  // or a client switched to/from "none" gets stuck with the wrong credential mode.
  if (typeof update.token_endpoint_auth_method === "string") {
    out.public = update.token_endpoint_auth_method === "none";
  }
  return out;
}

// Mirror the provider's SafeUrlSchema redirect-URI validation: parseable URL,
// no javascript:/data:/vbscript: scheme, and HTTPS unless the host is loopback.
// Without this a malformed URI saved on edit makes authorize's new URL(...) throw.
const DANGEROUS_URI_SCHEMES = ["javascript:", "data:", "vbscript:"];
function badRedirectUri(uris: string[]): string | null {
  for (const uri of uris) {
    let u: URL;
    try {
      u = new URL(uri);
    } catch {
      return `回调 URI 不是合法 URL：${uri}`;
    }
    if (DANGEROUS_URI_SCHEMES.includes(u.protocol)) {
      return `回调 URI 不允许使用 ${u.protocol} 协议：${uri}`;
    }
    // Use the provider's own loopback semantics (127.0.0.0/8, ::1, *.localhost)
    // so we don't reject loopback redirect URIs the create path accepted.
    if (u.protocol === "http:" && !isLoopbackHost(u.host)) {
      return `回调 URI 必须使用 HTTPS（仅 loopback 主机可用 HTTP）：${uri}`;
    }
  }
  return null;
}

// Mirror the structural checks from the provider's checkOAuthClient against the
// merged (existing + update) config. The create path runs that validation but the
// adapter-direct PATCH bypasses it, so without this an edit could persist a config
// the provider rejects (e.g. auth method "none" with a non-public type, or
// authorization_code without redirect URIs), breaking later authorize/token flows.
// Returns a human message when invalid, else null.
function validateOAuthClientUpdate(
  existing: OAuthClientRow,
  update: Record<string, unknown>
): string | null {
  const authMethod =
    (update.token_endpoint_auth_method as string | undefined) ??
    existing.tokenEndpointAuthMethod ??
    undefined;
  const type = (update.type as string | undefined) ?? existing.type ?? undefined;
  const isPublic = authMethod === "none";
  if (type) {
    if (isPublic && type !== "native" && type !== "user-agent-based") {
      return "公开客户端 (token_endpoint_auth_method=none) 的类型必须是 native 或 user-agent-based";
    }
    if (!isPublic && type !== "web") {
      return "机密客户端的类型必须是 web";
    }
  }
  const grantTypes =
    update.grant_types !== undefined
      ? asArray(update.grant_types)
      : asArray(existing.grantTypes);
  const redirectUris =
    update.redirect_uris !== undefined
      ? asArray(update.redirect_uris)
      : asArray(existing.redirectUris);
  if (
    (grantTypes.length === 0 || grantTypes.includes("authorization_code")) &&
    redirectUris.length === 0
  ) {
    return "authorization_code 授权类型需要至少一个回调 URI";
  }
  const responseTypes =
    update.response_types !== undefined
      ? asArray(update.response_types)
      : asArray(existing.responseTypes);
  if (
    grantTypes.includes("authorization_code") &&
    responseTypes.length > 0 &&
    !responseTypes.includes("code")
  ) {
    return "使用 authorization_code 时 response_types 必须包含 code";
  }
  // Validate redirect URI formats supplied by this update (existing values were
  // already validated at create time).
  if (update.redirect_uris !== undefined) {
    const bad = badRedirectUri(asArray(update.redirect_uris));
    if (bad) return bad;
  }
  if (update.post_logout_redirect_uris !== undefined) {
    const bad = badRedirectUri(asArray(update.post_logout_redirect_uris));
    if (bad) return bad;
  }
  // Scopes must stay within the provider's configured allowlist, else later
  // flows treat the stored client.scopes as valid and can mint unsupported scopes.
  if (typeof update.scope === "string") {
    const allowed = new Set(OAUTH_SCOPES);
    const bad = update.scope
      .split(" ")
      .filter(Boolean)
      .find((s) => !allowed.has(s));
    if (bad) return `不支持的 scope：${bad}`;
  }
  return null;
}

// Gate OAuth-client write endpoints by the oauthClient ACL. The admin middleware
// only checks the admin/superAdmin role string; per the roles config a plain
// admin has oauthClient:["read"] while superAdmin has create/update/delete. The
// write routes mutate the adapter directly (bypassing the plugin's own checks),
// so enforce the permission here or a read-only admin could write.
async function hasOAuthClientPermission(
  c: Context<HonoEnv>,
  auth: ReturnType<typeof createAuth>,
  action: "create" | "update" | "delete"
): Promise<boolean> {
  const res = await auth.api.userHasPermission({
    headers: c.req.raw.headers,
    body: { permissions: { oauthClient: [action] } },
  });
  return res.success === true;
}

// Gate entitlement WRITE endpoints by the entitlement ACL. The admin middleware
// only checks the admin/superAdmin role string; per the roles config only
// superAdmin holds entitlement:["assign","revoke"] (plain admins read-only). The
// write routes mutate the user_entitlement table directly, so enforce the
// permission here or a read-only admin could grant/revoke entitlements.
async function hasEntitlementPermission(
  c: Context<HonoEnv>,
  auth: ReturnType<typeof createAuth>,
  action: "assign" | "revoke"
): Promise<boolean> {
  const res = await auth.api.userHasPermission({
    headers: c.req.raw.headers,
    body: { permissions: { entitlement: [action] } },
  });
  return res.success === true;
}

// Middleware: require admin or superAdmin role
admin.use("/*", requireAdmin);

// GET /api/admin/users - List users (paginated)
admin.get("/users", async (c) => {
  const auth = createAuth(c.env, c.req.raw);
  const page = Math.max(1, parseInt(c.req.query("page") ?? "1"));
  const limit = Math.min(Math.max(1, parseInt(c.req.query("limit") ?? "20")), 100);

  const result = await auth.api.listUsers({
    headers: c.req.raw.headers,
    query: { limit, offset: (page - 1) * limit },
  });

  return c.json({
    data: result.users,
    pagination: {
      page,
      limit,
      total: result.total,
      totalPages: Math.max(1, Math.ceil(result.total / limit)),
    },
  });
});

// GET /api/admin/users/:id - User detail
admin.get("/users/:id", async (c) => {
  const userId = c.req.param("id");
  const auth = createAuth(c.env, c.req.raw);

  const user = await auth.api.getUser({
    headers: c.req.raw.headers,
    query: { id: userId },
  });

  if (!user) {
    return errorResponse(c, "NOT_FOUND", "用户不存在", 404);
  }

  return c.json({ data: user });
});

// PATCH /api/admin/users/:id - Update user (ban/unban/role)
admin.patch("/users/:id", async (c) => {
  const userId = c.req.param("id");
  const auth = createAuth(c.env, c.req.raw);
  const body = await c.req.json<{ action?: string; role?: string }>();

  if (body.action === "ban") {
    await auth.api.banUser({
      headers: c.req.raw.headers,
      body: { userId },
    });
    return c.json({ success: true, action: "banned" });
  }

  if (body.action === "unban") {
    await auth.api.unbanUser({
      headers: c.req.raw.headers,
      body: { userId },
    });
    return c.json({ success: true, action: "unbanned" });
  }

  if (body.role) {
    await auth.api.setRole({
      headers: c.req.raw.headers,
      body: { userId, role: body.role as "user" | "admin" | "superAdmin" },
    });
    return c.json({ success: true, role: body.role });
  }

  return errorResponse(c, "INVALID_ACTION", "需要 action 或 role 参数", 400);
});

// ── Registration invitations ────────────────────────────────────────────────
// 管理员和超级管理员都可邀请新用户；邀请仅开放注册，不附带任何 entitlement。

// GET /api/admin/registration-invitations - 最近 100 条邀请及实时状态。
admin.get("/registration-invitations", async (c) => {
  const data = await listRegistrationInvitations(c.env.DATABASE);
  return c.json({ data });
});

// POST /api/admin/registration-invitations - 生成 8 位明文 code，默认 7 天有效。
// body 可选 { preset: string | null }:注册使用该邀请码时套用的权益预设;
// null/省略 = 回落全局默认预设。指定的预设必须已存在。
admin.post("/registration-invitations", async (c) => {
  const user = c.get("user");
  const body = await c.req
    .json<{ preset?: string | null }>()
    .catch(() => ({}) as { preset?: string | null });
  const preset = body.preset ?? null;
  if (preset !== null && !(await getPresetItems(c.env.DATABASE, preset))) {
    return errorResponse(c, "UNKNOWN_PRESET", "未知预设", 400);
  }
  try {
    const invitation = await createRegistrationInvitation(
      c.env.DATABASE,
      user.id,
      { preset }
    );
    const registrationUrl = new URL("/register", c.env.BETTER_AUTH_URL);
    registrationUrl.searchParams.set("code", invitation.code);
    return c.json(
      { data: { ...invitation, registrationUrl: registrationUrl.toString() } },
      201
    );
  } catch (error) {
    if (error instanceof InvitationError) {
      return errorResponse(c, error.code, error.message, error.status);
    }
    throw error;
  }
});

// ── 注册政策开关 ─────────────────────────────────────────────────────────────
// invitationRequired = true(缺省):注册必须填邀请码(无码 = 禁止注册);
// false:无码也可注册,权益按 entitlement_config.default_preset 给。
// 读:admin/superAdmin;写:superAdmin(entitlement:assign,与预设管理同档)。

// GET /api/admin/registration-settings
admin.get("/registration-settings", async (c) => {
  return c.json({ invitationRequired: await isInvitationRequired(c.env.DATABASE) });
});

// PUT /api/admin/registration-settings - body { invitationRequired: boolean }
admin.put("/registration-settings", async (c) => {
  const auth = createAuth(c.env, c.req.raw);
  if (!(await hasEntitlementPermission(c, auth, "assign"))) {
    return errorResponse(c, "FORBIDDEN", "需要权益写权限", 403);
  }
  const body = await c.req
    .json<{ invitationRequired?: unknown }>()
    .catch(() => ({}) as { invitationRequired?: unknown });
  if (typeof body.invitationRequired !== "boolean") {
    return errorResponse(c, "INVALID_SETTING", "invitationRequired 必须是布尔值", 400);
  }
  await setInvitationRequired(c.env.DATABASE, body.invitationRequired);
  return c.json({ success: true, invitationRequired: body.invitationRequired });
});

// DELETE /api/admin/registration-invitations/:code - 撤销未使用邀请（幂等）。
admin.delete("/registration-invitations/:code", async (c) => {
  try {
    await revokeRegistrationInvitation(
      c.env.DATABASE,
      c.req.param("code")
    );
    return c.body(null, 204);
  } catch (error) {
    if (error instanceof InvitationError) {
      return errorResponse(c, error.code, error.message, error.status);
    }
    throw error;
  }
});

// PATCH /api/admin/users/:id/cqu-binding - Change a user's CQU binding status.
// body { status: "revoked" | "active" } — REST 化的吊销/恢复（取代旧的
// POST .../revoke-cqu 与 .../unrevoke-cqu 两个动词端点），把绑定视作可 PATCH 状态的资源。
//
// 与用户自助解绑（DELETE /api/cqu/binding，删凭证+地址+destroy DO）不同：revoke/active
// 是 admin/系统动作，**保留** state/credentials（留痕审计），仅翻转状态：
//   - revoked：标记 cqu_bind_addresses.status=revoked（邮件管道拒收 revoked 绑定的码）+
//     DO /revoke（status → revoked，停 keepalive/relogin alarm，清在途锁）。
//   - active：翻回 cqu_bind_addresses.status=active（邮件管道恢复收码）+ DO /unrevoke
//     （status → expired + 立即 fire alarm，让保活探测复验存活 cookie 或凭凭证重登）。
// admin/superAdmin gating 由上方 admin.use("/*") 中间件覆盖。
admin.patch("/users/:id/cqu-binding", async (c) => {
  const userId = c.req.param("id");
  const body = await c.req
    .json<{ status?: string }>()
    .catch(() => ({}) as { status?: string });
  const status = body.status;

  if (status !== "revoked" && status !== "active") {
    return errorResponse(
      c,
      "INVALID_STATUS",
      'status 必须是 "revoked" 或 "active"',
      400
    );
  }

  try {
    const db = drizzle(c.env.DATABASE);
    // D1: 翻转该用户所有绑定地址行的状态。幂等 — 0 行匹配（无绑定）是安全 no-op。
    // 凭证 NOT 删除。
    await db
      .update(cquBindAddresses)
      .set({ status })
      .where(eq(cquBindAddresses.userId, userId));

    // DO：revoked → /revoke（status → revoked，deleteAlarm，清 loginInFlight）；
    // active → /unrevoke（status → expired，setAlarm now → keepalive/relogin）。
    // 空/未初始化 DO 是安全 no-op（只设 status）。
    const action = status === "revoked" ? "revoke" : "unrevoke";
    const stub = c.env.CQU_SESSION.get(c.env.CQU_SESSION.idFromName(userId));
    // DO 内部异常返回 500 JSON(不 reject)。不查 res.ok 会把它当成功而仍返回
    // {success:true}, 但 D1 已翻转 → 半完成态。显式检查, 让 D1 与 DO 一致。
    const res = await stub.fetch(
      new Request(`https://do/${action}`, { method: "POST" })
    );
    if (!res.ok) {
      return errorResponse(c, "CQU_BINDING_UPDATE_FAILED", "DO 操作失败，请重试", 500);
    }

    return c.json({ success: true, status });
  } catch (e) {
    console.error(
      `[admin] cqu-binding ${status} failed for userId=${userId}: ${e instanceof Error ? e.message : String(e)}`
    );
    return errorResponse(c, "CQU_BINDING_UPDATE_FAILED", "更新 CQU 绑定状态失败", 500);
  }
});

// ── Per-user entitlements ────────────────────────────────────────────────────
// 事实源是 user_entitlement 表(每用户 × 子系统 × 能力的授权值)。读对 admin/
// superAdmin 开放(中间件已 gate 角色);写(替换/套用/删除)额外要 entitlement 权限,
// 只有 superAdmin 持有 —— 普通 admin 只读。

// GET /api/admin/users/:id/entitlements - 列出某用户的全部 entitlement 原始行。
// 读权限:admin.use("/*") 已 gate admin/superAdmin 角色,足够。
admin.get("/users/:id/entitlements", async (c) => {
  const userId = c.req.param("id");
  const rows = await drizzle(c.env.DATABASE)
    .select()
    .from(userEntitlement)
    .where(eq(userEntitlement.userId, userId))
    .all();
  return c.json({ data: rows });
});

// PUT /api/admin/users/:id/entitlements - 整组替换某用户的 entitlements。
// body { items: [{subsystem,capability,value}] }。写权限:entitlement:assign(superAdmin)。
// 写前先校验全部项;校验过再删旧全量、插新(空数组则只删不插)—— 与 oauth scopes 的
// delete-then-insert 全量替换同模式。
admin.put("/users/:id/entitlements", async (c) => {
  const auth = createAuth(c.env, c.req.raw);
  if (!(await hasEntitlementPermission(c, auth, "assign"))) {
    return errorResponse(c, "FORBIDDEN", "需要权益写权限", 403);
  }
  const userId = c.req.param("id");
  const body = await c.req
    .json<{ items?: unknown }>()
    .catch(() => ({}) as { items?: unknown });
  const items = body.items as
    | { subsystem: string; capability: string; value: string }[]
    | undefined;
  const invalid = validateEntitlementItems(items as never);
  if (invalid) return errorResponse(c, "INVALID_ENTITLEMENTS", invalid, 400);

  const db = drizzle(c.env.DATABASE);
  const del = db
    .delete(userEntitlement)
    .where(eq(userEntitlement.userId, userId));
  // 原子替换:delete + insert 走 D1 batch(单事务),即便 insert 因任何原因失败也不会
  // 留下「已删全量、未插新值」的半完成态(用户被静默清空)。items 为空时只删不插
  // (batch 要求非空数组,故空时单跑 delete)。validateEntitlementItems 已拒重复键,
  // 这里是纵深防御:批内任一语句失败 → 整批回滚。
  if (items!.length > 0) {
    const ins = db.insert(userEntitlement).values(
      items!.map((it) => ({
        userId,
        subsystem: it.subsystem,
        capability: it.capability,
        value: it.value,
      }))
    );
    await db.batch([del, ins]);
  } else {
    await del;
  }
  return c.json({ success: true });
});

// POST /api/admin/users/:id/entitlements/preset - 一键套用命名预设。
// body { preset: string }。写权限:entitlement:assign(superAdmin)。
// 预设事实源是 entitlement_preset 表(管理台可编辑),不再是代码常量。
// upsert 语义:仅删该预设涉及的 (subsystem,capability) 行,再插预设项 —— 覆盖预设
// 包含的能力,但保留用户其它无关 entitlement(契合「套用预设写若干行,仍可逐项加 share」)。
admin.post("/users/:id/entitlements/preset", async (c) => {
  const auth = createAuth(c.env, c.req.raw);
  if (!(await hasEntitlementPermission(c, auth, "assign"))) {
    return errorResponse(c, "FORBIDDEN", "需要权益写权限", 403);
  }
  const userId = c.req.param("id");
  const body = await c.req
    .json<{ preset?: string }>()
    .catch(() => ({}) as { preset?: string });
  const items = await getPresetItems(c.env.DATABASE, body.preset ?? "");
  if (!items) return errorResponse(c, "UNKNOWN_PRESET", "未知预设", 400);
  // DB 里的预设可被 superAdmin 直接编辑,写入用户前仍要过目录校验,
  // 挡住「能力目录已删除某键但预设还引用它」之类的漂移。
  const invalid = validateEntitlementItems(items);
  if (invalid) {
    return errorResponse(c, "INVALID_PRESET", `预设数据已失效：${invalid}`, 409);
  }

  const db = drizzle(c.env.DATABASE);
  // 仅删预设涵盖的 (subsystem,capability) 对（按 userId 限定），不动用户其它无关行。
  // 按完整复合键逐对删除，避免不同子系统下同名 capability 被误删；预设很小（数项），
  // 逐对删除清晰且远低于 D1 的 100 绑定参数上限。
  //
  // 原子化:把全部 per-pair delete + 单条 insert 合进一个 db.batch([...])(单 D1 事务),
  // 即便 insert 因任何原因失败也不会留下「已删旧值、未插预设」的半完成态(用户被静默
  // 部分清空)。presetToItems 不会产出空数组(真实预设至少一项),但仍守一手:items 为空时
  // 不走 batch(batch 要求非空数组),按无可应用项返回。
  if (items.length === 0) {
    return c.json({ success: true, applied: 0 });
  }
  const stmts = items.map((it) =>
    db
      .delete(userEntitlement)
      .where(
        and(
          eq(userEntitlement.userId, userId),
          eq(userEntitlement.subsystem, it.subsystem),
          eq(userEntitlement.capability, it.capability)
        )
      )
  );
  const ins = db.insert(userEntitlement).values(
    items.map((it) => ({
      userId,
      subsystem: it.subsystem,
      capability: it.capability,
      value: it.value,
    }))
  );
  await db.batch([stmts[0], ...stmts.slice(1), ins]);
  return c.json({ success: true, applied: items.length });
});

// ── 预设管理与新用户默认权益 ─────────────────────────────────────────────────
// 读:admin/superAdmin(中间件已 gate)。写:entitlement:assign(superAdmin),
// 与 per-user 写入同一档 —— 预设改动等价于批量授权能力。

// GET /api/admin/entitlement-presets - 全部预设(按中文名排序)。
admin.get("/entitlement-presets", async (c) => {
  return c.json({ data: await listPresets(c.env.DATABASE) });
});

// PUT /api/admin/entitlement-presets/:name - 新建或整体更新一个预设。
// body { items: [...] }。name 取 URL(允许中文),1-50 字符;items 过目录校验。
admin.put("/entitlement-presets/:name", async (c) => {
  const auth = createAuth(c.env, c.req.raw);
  if (!(await hasEntitlementPermission(c, auth, "assign"))) {
    return errorResponse(c, "FORBIDDEN", "需要权益写权限", 403);
  }
  const name = decodeURIComponent(c.req.param("name")).trim();
  if (!name || name.length > 50) {
    return errorResponse(c, "INVALID_NAME", "预设名需要 1-50 个字符", 400);
  }
  const body = await c.req
    .json<{ items?: unknown }>()
    .catch(() => ({}) as { items?: unknown });
  const invalid = validateEntitlementItems(body.items as never);
  if (invalid) return errorResponse(c, "INVALID_ENTITLEMENTS", invalid, 400);
  await upsertPreset(
    c.env.DATABASE,
    name,
    body.items as { subsystem: string; capability: string; value: string }[]
  );
  return c.json({ success: true });
});

// DELETE /api/admin/entitlement-presets/:name - 删除预设(幂等)。
// 同时清掉指向它的 default_preset 配置,避免新用户注册时引用不存在的预设。
admin.delete("/entitlement-presets/:name", async (c) => {
  const auth = createAuth(c.env, c.req.raw);
  if (!(await hasEntitlementPermission(c, auth, "assign"))) {
    return errorResponse(c, "FORBIDDEN", "需要权益写权限", 403);
  }
  const name = decodeURIComponent(c.req.param("name"));
  await deletePreset(c.env.DATABASE, name);
  if ((await getDefaultPresetName(c.env.DATABASE)) === name) {
    await setDefaultPresetName(c.env.DATABASE, null);
  }
  return c.json({ success: true });
});

// GET /api/admin/entitlement-default - 新注册用户自动套用的预设名(null = 无)。
admin.get("/entitlement-default", async (c) => {
  return c.json({ preset: await getDefaultPresetName(c.env.DATABASE) });
});

// PUT /api/admin/entitlement-default - body { preset: string | null }。
// 非 null 时预设必须已存在,否则注册钩子会静默 no-op,造成「以为配了其实没生效」。
admin.put("/entitlement-default", async (c) => {
  const auth = createAuth(c.env, c.req.raw);
  if (!(await hasEntitlementPermission(c, auth, "assign"))) {
    return errorResponse(c, "FORBIDDEN", "需要权益写权限", 403);
  }
  const body = await c.req
    .json<{ preset?: string | null }>()
    .catch(() => ({}) as { preset?: string | null });
  const preset = body.preset ?? null;
  if (preset !== null) {
    if (typeof preset !== "string" || !(await getPresetItems(c.env.DATABASE, preset))) {
      return errorResponse(c, "UNKNOWN_PRESET", "未知预设", 400);
    }
  }
  await setDefaultPresetName(c.env.DATABASE, preset);
  return c.json({ success: true, preset });
});

// DELETE /api/admin/users/:id/entitlements/:subsystem/:capability - 撤销单条能力。
// 写权限:entitlement:revoke(superAdmin)。按完整复合主键 (userId,subsystem,capability)
// 删一行;幂等 —— 删不存在的行是安全 no-op。
admin.delete("/users/:id/entitlements/:subsystem/:capability", async (c) => {
  const auth = createAuth(c.env, c.req.raw);
  if (!(await hasEntitlementPermission(c, auth, "revoke"))) {
    return errorResponse(c, "FORBIDDEN", "需要权益撤销权限", 403);
  }
  const userId = c.req.param("id");
  const subsystem = c.req.param("subsystem");
  const capability = c.req.param("capability");
  await drizzle(c.env.DATABASE)
    .delete(userEntitlement)
    .where(
      and(
        eq(userEntitlement.userId, userId),
        eq(userEntitlement.subsystem, subsystem),
        eq(userEntitlement.capability, capability)
      )
    );
  return c.json({ success: true });
});

// Shape of a row returned by adapter.findMany({ model: "oauthClient" }).
// Fields are camelCase (the oauthClient DB model's field names). Array/json
// fields are typed as `unknown` because the adapter's output transform may, in
// degenerate cases, hand back a raw string instead of a parsed value — asArray
// normalizes that. clientSecret is intentionally present here (the adapter
// returns it) but never copied into the response.
interface OAuthClientRow {
  clientId: string;
  name?: string | null;
  uri?: string | null;
  icon?: string | null;
  tos?: string | null;
  policy?: string | null;
  contacts?: unknown;
  redirectUris?: unknown;
  postLogoutRedirectUris?: unknown;
  tokenEndpointAuthMethod?: string | null;
  grantTypes?: unknown;
  responseTypes?: unknown;
  scopes?: unknown;
  type?: string | null;
  requirePKCE?: boolean | null;
  skipConsent?: boolean | null;
  enableEndSession?: boolean | null;
  subjectType?: string | null;
  disabled?: boolean | null;
  metadata?: unknown;
  clientSecret?: string | null;
}

// Parse a value that should be a JSON array; returns [] on anything malformed.
function safeJsonArray(v: string): string[] {
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Defensive coercion to a string[]. The D1/sqlite adapter has
// supportsArrays === false, so its output transform runs safeJSONParse on
// string[] fields and normally yields a real array. We still guard against a
// raw JSON string slipping through, so this endpoint is robust regardless of
// the underlying adapter's serialization behavior.
function asArray(v: unknown): string[] {
  return Array.isArray(v)
    ? (v as string[])
    : typeof v === "string"
      ? safeJsonArray(v)
      : [];
}

// GET /api/admin/oauth-clients - List all registered OAuth clients with their
// full configuration (snake_case, matching the create/update API contract so
// the edit form reads and writes the same field names).
admin.get("/oauth-clients", async (c) => {
  const auth = createAuth(c.env, c.req.raw);
  const ctx = await auth.$context;
  const clients = await ctx.adapter.findMany<OAuthClientRow>({
    model: "oauthClient",
  });

  // Key by the public client_id: scope storage + the scope middleware both
  // match on it (payload.azp ?? payload.client_id), so the frontend's
  // client.id must be that same value for the scope round-trip to line up.
  return c.json({
    data: clients.map((client) => ({
      // Legacy fields kept for the already-deployed frontend, which reads
      // id / clientId / name. Do not remove.
      id: client.clientId,
      clientId: client.clientId,
      name: client.name ?? client.clientId,
      // Full config in snake_case for the edit form.
      client_id: client.clientId,
      client_name: client.name ?? null,
      client_uri: client.uri ?? null,
      logo_uri: client.icon ?? null,
      tos_uri: client.tos ?? null,
      policy_uri: client.policy ?? null,
      contacts: asArray(client.contacts),
      redirect_uris: asArray(client.redirectUris),
      post_logout_redirect_uris: asArray(client.postLogoutRedirectUris),
      token_endpoint_auth_method: client.tokenEndpointAuthMethod ?? null,
      grant_types: asArray(client.grantTypes),
      response_types: asArray(client.responseTypes),
      // DB stores scopes as string[]; the API contract uses a space-delimited
      // string. Use asArray so a raw JSON-string value (sqlite serialization)
      // is parsed too, not joined as the literal "[\"openid\",...]" token.
      scope: asArray(client.scopes).join(" "),
      type: client.type ?? null,
      require_pkce: client.requirePKCE ?? false,
      skip_consent: client.skipConsent ?? false,
      enable_end_session: client.enableEndSession ?? false,
      subject_type: client.subjectType ?? null,
      disabled: client.disabled ?? false,
      metadata: client.metadata ?? null,
      // client_secret is intentionally omitted: it is stored hashed and is
      // sensitive — it must never be returned by a list endpoint.
    })),
  });
});

// PUT /api/admin/oauth-clients/:id/scopes - Configure CQU scopes for an OAuth client
admin.put("/oauth-clients/:id/scopes", async (c) => {
  const clientId = c.req.param("id");
  const { scopes } = await c.req.json<{ scopes: string[] }>();

  if (!Array.isArray(scopes)) {
    return errorResponse(c, "INVALID_SCOPES", "scopes 必须是数组", 400);
  }

  // Validate scope format: cqu:ticket:<service> or cqu:ticket:*
  const validPattern = /^cqu:ticket:([\w*]+)$/;
  for (const scope of scopes) {
    if (!validPattern.test(scope)) {
      return errorResponse(c, "INVALID_SCOPE", `无效的 scope: ${scope}`, 400);
    }
  }

  const db = drizzle(c.env.DATABASE);

  // Replace all scopes for this client atomically
  await db
    .delete(oauthClientCquScopes)
    .where(eq(oauthClientCquScopes.clientId, clientId));

  if (scopes.length > 0) {
    await db
      .insert(oauthClientCquScopes)
      .values(scopes.map((scope) => ({ clientId, scope })));
  }

  return c.json({ success: true, clientId, scopes });
});

// GET /api/admin/oauth-clients/:id/scopes - Get CQU scopes for an OAuth client
admin.get("/oauth-clients/:id/scopes", async (c) => {
  const clientId = c.req.param("id");
  const db = drizzle(c.env.DATABASE);
  const rows = await db
    .select()
    .from(oauthClientCquScopes)
    .where(eq(oauthClientCquScopes.clientId, clientId))
    .all();

  return c.json({ clientId, scopes: rows.map((r) => r.scope) });
});

// POST /api/admin/oauth-clients - Register a new OAuth client.
// adminCreateOAuthClient is a SERVER_ONLY plugin endpoint; body is snake_case
// (redirect_uris, client_name, ...). The plaintext client_secret is returned
// exactly once here and never again — the frontend must surface it immediately.
admin.post("/oauth-clients", async (c) => {
  const auth = createAuth(c.env, c.req.raw);
  if (!(await hasOAuthClientPermission(c, auth, "create"))) {
    return errorResponse(c, "FORBIDDEN", "需要 OAuth 客户端写权限", 403);
  }
  const body = await c.req.json();
  try {
    const result = await auth.api.adminCreateOAuthClient({
      headers: c.req.raw.headers,
      body,
    });
    return c.json({ data: result });
  } catch (e) {
    return oauthClientError(c, e);
  }
});

// PATCH /api/admin/oauth-clients/:id - Edit a client. The plugin update endpoint
// enforces a userId owner check admins can't satisfy for clients they don't own,
// so map snake_case -> DB model and write via the adapter (same as rotate/delete).
admin.patch("/oauth-clients/:id", async (c) => {
  const auth = createAuth(c.env, c.req.raw);
  if (!(await hasOAuthClientPermission(c, auth, "update"))) {
    return errorResponse(c, "FORBIDDEN", "需要 OAuth 客户端写权限", 403);
  }
  const clientId = c.req.param("id");
  const update = await c.req.json<Record<string, unknown>>();
  const dbUpdate = oauthClientUpdateToSchema(update);
  if (Object.keys(dbUpdate).length === 0) {
    return errorResponse(c, "NO_UPDATE", "没有可更新的字段", 400);
  }
  const ctx = await auth.$context;
  // Validate the merged config (existing + this update) the way the provider's
  // create path does, since the adapter-direct write skips checkOAuthClient.
  const existing = await ctx.adapter.findOne<OAuthClientRow>({
    model: "oauthClient",
    where: [{ field: "clientId", value: clientId }],
  });
  if (!existing) return errorResponse(c, "NOT_FOUND", "客户端不存在", 404);
  const invalid = validateOAuthClientUpdate(existing, update);
  if (invalid) return errorResponse(c, "INVALID_CLIENT_METADATA", invalid, 400);
  // Keep the secret consistent with the auth method (the create path does the
  // same via isPublic). Public clients hold no secret; switching a public client
  // to confidential must mint one — returned once — or the token endpoint can
  // neither require nor validate a secret and the client breaks.
  let revealedSecret: string | undefined;
  if (typeof update.token_endpoint_auth_method === "string") {
    if (update.token_endpoint_auth_method === "none") {
      dbUpdate.clientSecret = null;
    } else if (!existing.clientSecret) {
      revealedSecret = generateOAuthClientSecret();
      dbUpdate.clientSecret = await hashOAuthClientSecret(revealedSecret);
    }
  }
  const updated = await ctx.adapter.update({
    model: "oauthClient",
    where: [{ field: "clientId", value: clientId }],
    update: { ...dbUpdate, updatedAt: new Date() },
  });
  if (!updated) return errorResponse(c, "NOT_FOUND", "客户端不存在", 404);
  return c.json(
    revealedSecret
      ? { success: true, data: { client_id: clientId, client_secret: revealedSecret } }
      : { success: true }
  );
});

// POST /api/admin/oauth-clients/:id/rotate-secret - Issue a fresh client secret.
// The plugin's own rotate endpoint enforces an owner check that admins can't
// satisfy, so we write directly via the adapter. The stored value must match
// the plugin's "hashed" mode (SHA-256/base64url) or validateClientCredentials
// rejects it; the plaintext is returned once.
admin.post("/oauth-clients/:id/rotate-secret", async (c) => {
  const auth = createAuth(c.env, c.req.raw);
  if (!(await hasOAuthClientPermission(c, auth, "update"))) {
    return errorResponse(c, "FORBIDDEN", "需要 OAuth 客户端写权限", 403);
  }
  const clientId = c.req.param("id");
  const ctx = await auth.$context;
  const existing = await ctx.adapter.findOne<OAuthClientRow>({
    model: "oauthClient",
    where: [{ field: "clientId", value: clientId }],
  });
  if (!existing) return errorResponse(c, "NOT_FOUND", "客户端不存在", 404);
  // Public clients have no secret (mirrors the plugin's rotate, which rejects
  // them): writing one would be misleading since the token endpoint still
  // accepts requests without it. Make it confidential first.
  if (existing.tokenEndpointAuthMethod === "none" || !existing.clientSecret) {
    return errorResponse(
      c,
      "PUBLIC_CLIENT_NO_SECRET",
      "公开客户端没有可轮换的密钥，请先将其改为机密客户端",
      400
    );
  }
  const secret = generateOAuthClientSecret();
  const hashed = await hashOAuthClientSecret(secret);
  const updated = await ctx.adapter.update({
    model: "oauthClient",
    where: [{ field: "clientId", value: clientId }],
    update: { clientSecret: hashed },
  });
  if (!updated) return errorResponse(c, "NOT_FOUND", "客户端不存在", 404);
  return c.json({ data: { client_id: clientId, client_secret: secret } });
});

// DELETE /api/admin/oauth-clients/:id - Remove a client and its CQU scopes.
// The plugin delete endpoint also enforces an owner check, so we delete via the
// adapter and cascade-clean oauth_client_cqu_scopes (keyed by public client_id)
// since there's no DB-level foreign key.
admin.delete("/oauth-clients/:id", async (c) => {
  const auth = createAuth(c.env, c.req.raw);
  if (!(await hasOAuthClientPermission(c, auth, "delete"))) {
    return errorResponse(c, "FORBIDDEN", "需要 OAuth 客户端写权限", 403);
  }
  const clientId = c.req.param("id");
  const ctx = await auth.$context;
  // Provider tables (oauthAccessToken/oauthRefreshToken/oauthConsent) reference
  // oauthClient(clientId) without ON DELETE CASCADE, so remove dependent rows
  // first or deleting a used client FK-errors (→500) / orphans rows. Access
  // tokens reference refresh tokens, so they must go before refresh tokens.
  for (const model of [
    "oauthAccessToken",
    "oauthRefreshToken",
    "oauthConsent",
  ]) {
    await ctx.adapter.deleteMany({
      model,
      where: [{ field: "clientId", value: clientId }],
    });
  }
  await ctx.adapter.delete({
    model: "oauthClient",
    where: [{ field: "clientId", value: clientId }],
  });
  const db = drizzle(c.env.DATABASE);
  await db
    .delete(oauthClientCquScopes)
    .where(eq(oauthClientCquScopes.clientId, clientId));
  return c.json({ success: true });
});

export { admin };
