import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { HonoEnv } from "../../types";
import { cquQuicklogin } from "../../routes/cqu-quicklogin";
import { problem } from "../problem";
import { QuickloginPreferenceBody } from "./cqu-quicklogin.schema";

export function createCquQuickloginApi() {
  const api = new Hono<HonoEnv>();
  const forward = async (c: Parameters<typeof problem>[0]) => {
    c.header("Cache-Control", "no-store");
    if (c.req.method === "PUT") {
      if (!/^application\/json(?:\s*;|$)/i.test(c.req.header("content-type") ?? "")) {
        return problem(c, "UNSUPPORTED_MEDIA_TYPE", "仅支持 JSON 请求体", 415);
      }
      let body: unknown;
      try {
        body = await c.req.raw.clone().json();
      } catch {
        return problem(c, "INVALID_BODY", "请求体不是合法 JSON", 400);
      }
      if (!QuickloginPreferenceBody.safeParse(body).success) {
        return problem(c, "INVALID_BODY", "请求体无效", 400);
      }
    }
    const url = new URL(c.req.url);
    url.pathname = "/";
    const response = await cquQuicklogin.request(new Request(url, c.req.raw), undefined, c.env);
    const body = await response.json() as Record<string, any>;
    if (!response.ok) {
      if (typeof body.status === "number" && typeof body.code === "string") {
        return new Response(JSON.stringify(body), response);
      }
      const error = body.detail?.error;
      return problem(c, error?.code ?? "INTERNAL_ERROR", error?.message ?? "服务器内部错误", response.status);
    }
    return c.json({ data: body }, response.status as ContentfulStatusCode);
  };
  api.get("/", forward);
  api.put("/", forward);
  return api;
}
