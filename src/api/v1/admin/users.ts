import { Hono } from "hono";
import { APIError } from "better-auth/api";
import { createAuth } from "../../../auth";
import { requireAdmin } from "../../../middleware/authentication";
import { admin as legacyAdmin } from "../../../routes/admin";
import type { HonoEnv } from "../../../types";
import { problem } from "../../problem";
import { JsonBodyError, jsonBodyProblem, parseJsonBody } from "../../validation";
import { parsePositiveInteger, UserPatchSchema } from "./users.schema";

function apiError(c: Parameters<typeof problem>[0], error: unknown) {
  if (error instanceof APIError) {
    if (error.body?.code === "RECENT_AUTH_REQUIRED" || error.body?.code === "STRONG_AUTH_REQUIRED") {
      return problem(c, error.body.code, error.message, 403);
    }
    return problem(c, "AUTH_ADMIN_ERROR", "管理操作被拒绝", error.statusCode || 400);
  }
  return problem(c, "INTERNAL_ERROR", "服务器内部错误", 500);
}

export function createAdminUsersApi() {
  const api = new Hono<HonoEnv>();
  api.use("/*", requireAdmin);

  api.get("/", async (c) => {
    const page = parsePositiveInteger(c.req.query("page"), 1);
    const limit = parsePositiveInteger(c.req.query("limit"), 20, 100);
    if (page === null || limit === null) return problem(c, "INVALID_PAGINATION", "分页参数无效", 400);
    const auth = createAuth(c.env, c.req.raw);
    try {
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
    } catch (error) {
      return apiError(c, error);
    }
  });

  api.get("/:id", async (c) => {
    const auth = createAuth(c.env, c.req.raw);
    try {
      const user = await auth.api.getUser({
        headers: c.req.raw.headers,
        query: { id: c.req.param("id") },
      });
      if (!user) return problem(c, "NOT_FOUND", "用户不存在", 404);
      return c.json({ data: user });
    } catch (error) {
      return apiError(c, error);
    }
  });

  api.patch("/:id", async (c) => {
    try {
      const input = await parseJsonBody(c.req.raw, UserPatchSchema);
      const auth = createAuth(c.env, c.req.raw);
      const userId = c.req.param("id");
      if ("banned" in input) {
        if (input.banned) await auth.api.banUser({ headers: c.req.raw.headers, body: { userId } });
        else await auth.api.unbanUser({ headers: c.req.raw.headers, body: { userId } });
        return c.json({ data: { id: userId, banned: input.banned } });
      }
      await auth.api.setRole({
        headers: c.req.raw.headers,
        body: { userId, role: input.role },
      });
      return c.json({ data: { id: userId, role: input.role } });
    } catch (error) {
      if (error instanceof JsonBodyError) return jsonBodyProblem(c, error);
      return apiError(c, error);
    }
  });

  api.patch("/:id/cqu-binding", async (c) => {
    const url = new URL(c.req.url);
    url.pathname = `/users/${encodeURIComponent(c.req.param("id"))}/cqu-binding`;
    const response = await legacyAdmin.request(new Request(url, c.req.raw), undefined, c.env);
    const body = await response.json() as Record<string, any>;
    if (!response.ok) {
      if (typeof body.status === "number") return new Response(JSON.stringify(body), response);
      return problem(c, body.detail?.error?.code ?? "INTERNAL_ERROR", body.detail?.error?.message ?? "更新失败", response.status);
    }
    return c.json({ data: { status: body.status } });
  });

  return api;
}
