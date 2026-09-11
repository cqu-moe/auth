import { z } from "@hono/zod-openapi";

export const QuickloginPreferenceBody = z.strictObject({ enabled: z.boolean() });
