import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { createAuth } from "../auth";
import { errorResponse } from "../utils/error";
import { requireCquScope } from "../middleware/scope";
import { validateCquServiceUrl } from "../services/service-url";
import { pickServiceTicketMode } from "../services/service-ticket-mode";
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
// 两种模式(均需带 cqu:ticket:* scope 的 Bearer 令牌):
//   ?service=<symbolic key>  → 一等公民,符号化白名单服务,requireCquScope(service);
//   ?serviceUrl=<https...>   → 广路径快捷登录,先 host 校验再 requireCquScope("any")。
// 校验/400 一律先于 scope 检查与 DO 调用;转发 DO 只传 canonical(绝不回传原始 serviceUrl)。
// 旧的纯 fetch 登录端点（POST/PUT/DELETE /bind）与状态端点（GET /status）已迁移到
// RESTful 资源路由 /api/cqu/binding（见 cqu-bind.ts），此处不再保留。
cqu.get(
  "/service-ticket",
  // 阶段一:定模式 + serviceUrl host 校验 + 选 scope 守卫。
  // 所有 400 与校验都在此(scope 检查与 DO 调用之前),把已校验的 canonical href
  // 暂存到 c.var.stDoUrl 供阶段二转发(只传 canonical,绝不回传原始 serviceUrl)。
  async (c, next) => {
    const picked = pickServiceTicketMode({
      service: c.req.query("service"),
      serviceUrl: c.req.query("serviceUrl"),
    });

    if (picked.mode === "none") {
      return errorResponse(
        c,
        "MISSING_SERVICE",
        "缺少 service 或 serviceUrl 参数",
        400
      );
    }

    const doUrl = new URL("https://do/service-ticket");

    if (picked.mode === "url") {
      let canonical: string;
      try {
        canonical = validateCquServiceUrl(picked.serviceUrl);
      } catch {
        return errorResponse(c, "INVALID_SERVICE_URL", "非法的 serviceUrl", 400);
      }
      doUrl.searchParams.set("serviceUrl", canonical); // 仅传 canonical
      c.set("stDoUrl", doUrl.toString());
      return requireCquScope("any")(c, next);
    }

    doUrl.searchParams.set("service", picked.service);
    c.set("stDoUrl", doUrl.toString());
    return requireCquScope(picked.service)(c, next);
  },
  // 阶段二:scope 通过后转发 DO。
  async (c) => {
    const user = c.get("user") as { id: string };
    const doId = c.env.CQU_SESSION.idFromName(user.id);
    const stub = c.env.CQU_SESSION.get(doId);
    const resp = await stub.fetch(new Request(c.get("stDoUrl")));

    if (!resp.ok) {
      const err = await resp.json<{ error: string; code: string }>();
      return errorResponse(c, err.code ?? "ST_FAILED", err.error, resp.status);
    }

    return c.json(await resp.json());
  }
);

export { cqu };
