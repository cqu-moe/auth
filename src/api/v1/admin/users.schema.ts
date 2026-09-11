import { z } from "@hono/zod-openapi";

export const UserPatchSchema = z.union([
  z.strictObject({ banned: z.boolean() }),
  z.strictObject({ role: z.enum(["user", "admin", "superAdmin"]) }),
]);

export function parsePositiveInteger(value: string | undefined, fallback: number, max?: number) {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (max !== undefined && parsed > max)) return null;
  return parsed;
}
