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

// GET /api/admin/oauth-clients - List all registered OAuth clients
admin.get("/oauth-clients", async (c) => {
  const auth = createAuth(c.env, c.req.raw);
  const ctx = await auth.$context;
  const clients = await ctx.adapter.findMany<{
    clientId: string;
    name?: string | null;
  }>({ model: "oauthClient" });

  // Key by the public client_id: scope storage + the scope middleware both
  // match on it (payload.azp ?? payload.client_id), so the frontend's
  // client.id must be that same value for the scope round-trip to line up.
  return c.json({
    data: clients.map((client) => ({
      id: client.clientId,
      clientId: client.clientId,
      name: client.name ?? client.clientId,
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

// PATCH /api/admin/oauth-clients/:id - Edit an existing OAuth client.
// adminUpdateOAuthClient expects { client_id, update } where update holds the
// snake_case fields to change. :id is the public client_id.
admin.patch("/oauth-clients/:id", async (c) => {
  const auth = createAuth(c.env, c.req.raw);
  const clientId = c.req.param("id");
  const update = await c.req.json();
  try {
    const result = await auth.api.adminUpdateOAuthClient({
      headers: c.req.raw.headers,
      body: { client_id: clientId, update },
    });
    return c.json({ data: result });
  } catch (e) {
    return oauthClientError(c, e);
  }
});

// POST /api/admin/oauth-clients/:id/rotate-secret - Issue a fresh client secret.
// The plugin's own rotate endpoint enforces an owner check that admins can't
// satisfy, so we write directly via the adapter. The stored value must match
// the plugin's "hashed" mode (SHA-256/base64url) or validateClientCredentials
// rejects it; the plaintext is returned once.
admin.post("/oauth-clients/:id/rotate-secret", async (c) => {
  const auth = createAuth(c.env, c.req.raw);
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
  const clientId = c.req.param("id");
  const ctx = await auth.$context;
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
