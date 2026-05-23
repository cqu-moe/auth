import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { createAuth } from "../auth";
import { errorResponse } from "../utils/error";
import { oauthClientCquScopes } from "../db/schema";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";

const admin = new Hono<HonoEnv>();

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
    pagination: { page, limit, total: result.total },
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

export { admin };
