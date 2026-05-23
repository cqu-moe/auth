import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export function errorResponse(
  c: Context,
  code: string,
  message: string,
  status: number = 400
) {
  return c.json(
    { detail: { error: { code, message } } },
    status as ContentfulStatusCode
  );
}
