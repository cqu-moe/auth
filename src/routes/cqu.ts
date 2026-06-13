import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { createAuth } from "../auth";
import { errorResponse } from "../utils/error";
import { requireCquScope } from "../middleware/scope";
import { verifyAccessToken } from "better-auth/oauth2";

const cqu = new Hono<HonoEnv>();

cqu.use("/*", async (c, next) => {
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

// GET /api/cqu/service-ticket — OAuth 客户端凭 cqu:ticket:* scope 取 CAS Service Ticket。
// 旧的纯 fetch 登录端点（POST/PUT/DELETE /bind）与状态端点（GET /status）已迁移到
// RESTful 资源路由 /api/cqu/binding（见 cqu-bind.ts），此处不再保留。
cqu.get("/service-ticket", async (c, next) => {
  const service = c.req.query("service");
  if (!service)
    return errorResponse(c, "MISSING_SERVICE", "缺少 service 参数", 400);
  return requireCquScope(service)(c, next);
}, async (c) => {
  const service = c.req.query("service")!;
  const user = c.get("user") as { id: string };
  const doId = c.env.CQU_SESSION.idFromName(user.id);
  const stub = c.env.CQU_SESSION.get(doId);
  const resp = await stub.fetch(
    new Request(`https://do/service-ticket?service=${service}`)
  );

  if (!resp.ok) {
    const err = await resp.json<{ error: string; code: string }>();
    return errorResponse(c, err.code ?? "ST_FAILED", err.error, resp.status);
  }

  return c.json(await resp.json());
});

export { cqu };
