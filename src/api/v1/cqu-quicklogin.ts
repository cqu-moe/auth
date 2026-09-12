import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { HonoEnv } from "../../types";
import { cquQuicklogin } from "../../routes/cqu-quicklogin";
import { problem } from "../problem";

export function createCquQuickloginApi() {
  const api = new Hono<HonoEnv>();
  const forward = async (c: Parameters<typeof problem>[0]) => {
    c.header("Cache-Control", "no-store");
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
