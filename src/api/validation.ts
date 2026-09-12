import { OpenAPIHono } from "@hono/zod-openapi";
import type { Env } from "hono";
import { HTTPException } from "hono/http-exception";
import { problem } from "./problem";

export class JsonBodyError extends Error {
  constructor(
    public readonly code: "UNSUPPORTED_MEDIA_TYPE" | "INVALID_BODY",
    public readonly status: 415 | 400
  ) {
    super(code);
    this.name = "JsonBodyError";
  }
}

export async function parseJsonBody<T>(
  request: Request,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  options: { optionalEmpty?: boolean } = {}
): Promise<T> {
  const raw = await request.clone().text();
  if (raw.length === 0) {
    if (!options.optionalEmpty) throw new JsonBodyError("INVALID_BODY", 400);
    const parsed = schema.safeParse({});
    if (!parsed.success) throw new JsonBodyError("INVALID_BODY", 400);
    return parsed.data;
  }
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
    throw new JsonBodyError("UNSUPPORTED_MEDIA_TYPE", 415);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new JsonBodyError("INVALID_BODY", 400);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new JsonBodyError("INVALID_BODY", 400);
  return parsed.data;
}

export function jsonBodyProblem(c: Parameters<typeof problem>[0], error: JsonBodyError) {
  return error.code === "UNSUPPORTED_MEDIA_TYPE"
    ? problem(c, error.code, "仅支持 JSON 请求体", error.status)
    : problem(c, error.code, "请求体无效", error.status);
}

export function createApiRouter<E extends Env = Env>() {
  const app = new OpenAPIHono<E>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return problem(c, "INVALID_BODY", "请求体无效", 400);
      }
    },
  });

  app.onError((error, c) => {
    if (error instanceof HTTPException && error.status === 415) {
      return problem(c, "UNSUPPORTED_MEDIA_TYPE", "仅支持 JSON 请求体", 415);
    }
    if (error instanceof HTTPException && error.status === 400) {
      return problem(c, "INVALID_BODY", "请求体不是合法 JSON", 400);
    }
    return problem(c, "INTERNAL_ERROR", "服务器内部错误", 500);
  });

  return app;
}
