import { z } from "@hono/zod-openapi";

export const TicketTargetSchema = z.union([
  z.strictObject({ service: z.enum(["jwxt", "jxpj", "library", "card", "friends"]) }),
  z.strictObject({ serviceUrl: z.string().min(1) }),
]);
