import { createRoute, z } from "@hono/zod-openapi";
import { createApiRouter } from "../validation";
import type { HonoEnv } from "../../types";

const Health = z.object({
  data: z.object({
    status: z.literal("ok"),
    timestamp: z.iso.datetime(),
  }),
});

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  operationId: "getHealth",
  responses: {
    200: {
      description: "Service health",
      content: { "application/json": { schema: Health } },
    },
  },
});

export function createV1Api() {
  const api = createApiRouter<HonoEnv>();
  api.openapi(healthRoute, (c) =>
    c.json({ data: { status: "ok" as const, timestamp: new Date().toISOString() } }, 200)
  );
  return api;
}
