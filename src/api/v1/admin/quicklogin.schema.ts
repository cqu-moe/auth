import { z } from "@hono/zod-openapi";

const DeviceLimit = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const QuickloginPolicyPreviewBody = z.strictObject({
  migrationId: z.string().min(1),
  deviceLimit: DeviceLimit,
});

export const QuickloginPolicyInitializeBody = z.strictObject({
  migrationId: z.string().min(1),
  deviceLimit: DeviceLimit,
  previewHash: z.string().min(1),
});

export const QuickloginQuotaPreviewBody = z.strictObject({
  deviceLimit: DeviceLimit,
});

export const QuickloginQuotaApplyBody = z.strictObject({
  token: z.string().min(1),
  newLimit: DeviceLimit,
});
