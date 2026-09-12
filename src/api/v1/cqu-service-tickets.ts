import { Hono } from "hono";
import type { HonoEnv } from "../../types";
import { requireBearer } from "../../middleware/authentication";
import { issueCquServiceTicket } from "../../routes/cqu";
import { problem } from "../problem";
import { JsonBodyError, jsonBodyProblem, parseJsonBody } from "../validation";
import { TicketTargetSchema } from "./cqu-service-tickets.schema";

export function createCquServiceTicketsApi() {
  const api = new Hono<HonoEnv>();
  api.post("/", requireBearer, async (c) => {
    c.header("Cache-Control", "no-store");
    let input: { service: "jwxt" | "jxpj" | "library" | "card" } | { serviceUrl: string };
    try {
      input = await parseJsonBody(c.req.raw, TicketTargetSchema);
    } catch (error) {
      if (error instanceof JsonBodyError) {
        if (error.code === "UNSUPPORTED_MEDIA_TYPE") return jsonBodyProblem(c, error);
        const raw = await c.req.raw.clone().json().catch(() => null) as Record<string, unknown> | null;
        if (raw && raw.service === undefined && raw.serviceUrl === undefined) {
          return problem(c, "MISSING_SERVICE", "缺少 service 或 serviceUrl", 400);
        }
        if (raw && raw.service !== undefined && raw.serviceUrl !== undefined) {
          return problem(c, "INVALID_TARGET", "service 与 serviceUrl 只能提供一个", 400);
        }
        return problem(c, "INVALID_TARGET", "出票目标无效", 400);
      }
      throw error;
    }

    const response = await issueCquServiceTicket(c, input);
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
