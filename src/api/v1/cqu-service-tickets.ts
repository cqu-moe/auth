import { Hono } from "hono";
import type { HonoEnv } from "../../types";
import { cqu } from "../../routes/cqu";
import { problem } from "../problem";
import { TicketTargetSchema } from "./cqu-service-tickets.schema";

export function createCquServiceTicketsApi() {
  const api = new Hono<HonoEnv>();
  api.post("/", async (c) => {
    c.header("Cache-Control", "no-store");
    const contentType = c.req.header("content-type") ?? "";
    if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
      return problem(c, "UNSUPPORTED_MEDIA_TYPE", "仅支持 JSON 请求体", 415);
    }
    let input: unknown;
    try {
      input = await c.req.json();
    } catch {
      return problem(c, "INVALID_BODY", "请求体不是合法 JSON", 400);
    }
    if (input && typeof input === "object") {
      const value = input as Record<string, unknown>;
      if (value.service === undefined && value.serviceUrl === undefined) {
        return problem(c, "MISSING_SERVICE", "缺少 service 或 serviceUrl", 400);
      }
      if (value.service !== undefined && value.serviceUrl !== undefined) {
        return problem(c, "INVALID_TARGET", "service 与 serviceUrl 只能提供一个", 400);
      }
    }
    const parsed = TicketTargetSchema.safeParse(input);
    if (!parsed.success) return problem(c, "INVALID_TARGET", "出票目标无效", 400);

    const url = new URL("http://cqu/service-ticket");
    if ("service" in parsed.data) url.searchParams.set("service", parsed.data.service);
    else url.searchParams.set("serviceUrl", parsed.data.serviceUrl);
    const response = await cqu.request(new Request(url, {
      method: "GET",
      headers: c.req.raw.headers,
    }), undefined, c.env);
    const body = await response.json() as Record<string, any>;
    if (!response.ok) {
      if (typeof body.status === "number" && typeof body.code === "string") {
        return new Response(JSON.stringify(body), response);
      }
      const error = body.detail?.error;
      return problem(
        c,
        typeof error?.code === "string" ? error.code : "ST_FAILED",
        typeof error?.message === "string" ? error.message : "取票失败",
        response.status
      );
    }
    return c.json({ data: { ticket: body.ticket } }, 201);
  });
  return api;
}
