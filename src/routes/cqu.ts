import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { errorResponse } from "../utils/error";
import { requireCquScope } from "../middleware/scope";
import { validateCquServiceUrl } from "../services/service-url";
import { pickServiceTicketMode } from "../services/service-ticket-mode";
import { requireBearer } from "../middleware/authentication";

const cqu = new Hono<HonoEnv>();

cqu.use("/*", requireBearer);

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
    // per-client 限频/审计身份 + 入口标记;两种模式都带。clientId 缺省传空串(DO 按 null 处理)。
    doUrl.searchParams.set("clientId", c.get("clientId") ?? "");
    doUrl.searchParams.set("source", "route");

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
      // H5 纵深脱敏: 只回稳定 code(对齐 rpc.ts 的 { error: code } 做法), **绝不**回显 DO 派生的
      // err.error/message —— 它是 CquSsoError.message, 可能含节点回传的 detail 片段。前端靠 code
      // 区分错误即可(取票失败的 UX 不依赖原始 message)。
      const err = await resp
        .json<{ error?: string; code?: string }>()
        .catch(() => ({}) as { error?: string; code?: string });
      const code = err.code ?? "ST_FAILED";
      return errorResponse(c, code, "取票失败", resp.status);
    }

    return c.json(await resp.json());
  }
);

export { cqu };
