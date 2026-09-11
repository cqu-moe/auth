import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { cquBinding } from "../../routes/cqu-bind";
import type { HonoEnv } from "../../types";
import { problem } from "../problem";
import { CquCredentialsBody, CreateCquBindingBody } from "./cqu-binding.schema";

const operations = [
  ["POST", "/"],
  ["GET", "/"],
  ["PUT", "/credentials"],
  ["GET", "/events"],
  ["DELETE", "/"],
] as const;

function resourcePath(pathname: string): string {
  const prefix = "/api/v1/cqu/binding";
  return pathname.slice(prefix.length) || "/";
}

export function createCquBindingApi() {
  const api = new Hono<HonoEnv>();
  const handler = async (c: Parameters<typeof problem>[0]) => {
    c.header("Cache-Control", "no-store");
    const url = new URL(c.req.url);
    if ((c.req.method === "GET" || c.req.method === "DELETE") && url.search) {
      return problem(c, "INVALID_QUERY", "请求参数无效", 400);
    }
    if (c.req.method === "POST" || c.req.method === "PUT") {
      const raw = await c.req.raw.clone().text();
      if (raw.length > 0 && !/^application\/json(?:\s*;|$)/i.test(c.req.header("content-type") ?? "")) {
        return problem(c, "UNSUPPORTED_MEDIA_TYPE", "仅支持 JSON 请求体", 415);
      }
      if (raw.length === 0 && c.req.method === "PUT") {
        return problem(c, "INVALID_BODY", "请求体无效", 400);
      }
      let parsed: unknown = {};
      if (raw.length > 0) {
        try {
          parsed = JSON.parse(raw);
        } catch {
          return problem(c, "INVALID_BODY", "请求体不是合法 JSON", 400);
        }
      }
      const schema = c.req.method === "POST" ? CreateCquBindingBody : CquCredentialsBody;
      if (!schema.safeParse(parsed).success) {
        return problem(c, "INVALID_BODY", "请求体无效", 400);
      }
    }
    url.pathname = resourcePath(url.pathname);
    const response = await cquBinding.request(new Request(url, c.req.raw), undefined, c.env);
    if (response.status === 101 || response.status === 204) return response;

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) return response;
    const body = await response.json() as Record<string, any>;
    if (!response.ok) {
      if (typeof body.status === "number" && typeof body.code === "string") {
        return new Response(JSON.stringify(body), response);
      }
      const legacy = body.detail?.error;
      return problem(
        c,
        typeof legacy?.code === "string" ? legacy.code : "INTERNAL_ERROR",
        typeof legacy?.message === "string" ? legacy.message : "服务器内部错误",
        response.status
      );
    }

    const data = c.req.method === "PUT" && url.pathname === "/credentials"
      ? { studentId: body.studentId }
      : body;
    return c.json({ data }, response.status as ContentfulStatusCode);
  };

  for (const [method, path] of operations) api.on(method, path, handler);
  return api;
}
