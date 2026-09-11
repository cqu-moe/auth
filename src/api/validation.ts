import { OpenAPIHono } from "@hono/zod-openapi";
import type { Env } from "hono";
import { HTTPException } from "hono/http-exception";
import { problem } from "./problem";

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
