import { z } from "@hono/zod-openapi";

export const EntitlementItemBody = z.strictObject({
  subsystem: z.string(),
  capability: z.string(),
  value: z.string(),
});

export const ReplaceEntitlementsBody = z.strictObject({
  items: z.array(EntitlementItemBody),
});

export const MergeEntitlementPresetBody = z.strictObject({
  preset: z.string().min(1),
});

export const EntitlementDefaultBody = z.strictObject({
  preset: z.string().nullable(),
});
