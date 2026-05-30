import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { APIError } from "better-auth/api";
import type { HonoEnv } from "../types";
import { createAuth } from "../auth";
import { errorResponse } from "../utils/error";
import { oauthClientCquScopes } from "../db/schema";
import {
  hashOAuthClientSecret,
  generateOAuthClientSecret,
} from "../utils/oauth-secret";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";

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

// Middleware: require admin or superAdmin role
admin.use("/*", async (c, next) => {
  const auth = createAuth(c.env, c.req.raw);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) return errorResponse(c, "UNAUTHORIZED", "未登录", 401);

  // Better Auth admin plugin stores role in user object
  const userRole = (session.user as { role?: string }).role;
  if (userRole !== "admin" && userRole !== "superAdmin") {
    return errorResponse(c, "FORBIDDEN", "需要管理员权限", 403);
  }

  c.set("user", session.user);
  return next();
});

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
      // string.
      scope: Array.isArray(client.scopes)
        ? client.scopes.join(" ")
        : typeof client.scopes === "string"
          ? client.scopes
          : "",
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
  const updated = await ctx.adapter.update({
    model: "oauthClient",
    where: [{ field: "clientId", value: clientId }],
    update: { ...dbUpdate, updatedAt: new Date() },
  });
  if (!updated) return errorResponse(c, "NOT_FOUND", "客户端不存在", 404);
  return c.json({ success: true });
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
