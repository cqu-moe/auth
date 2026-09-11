import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

const STATUS_TITLES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  415: "Unsupported Media Type",
  426: "Upgrade Required",
  429: "Too Many Requests",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

export function problem(
  c: Context,
  code: string,
  detail: string,
  status: number = 400
) {
  const title = STATUS_TITLES[status] ?? "Error";
  return c.body(
    JSON.stringify({
      type: "about:blank",
      title,
      status,
      detail,
      code,
    }),
    status as ContentfulStatusCode,
    { "content-type": "application/problem+json" }
  );
}
