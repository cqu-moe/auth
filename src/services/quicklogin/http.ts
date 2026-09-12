import { z } from "@hono/zod-openapi";
import type { DeviceMetadata, ErrorCode, HeartbeatInput } from "./contracts";

const SafeNonNegativeInteger = z.number().int().nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const boundedCanonicalText = (maxLength: number) => z.string()
  .min(1)
  .max(maxLength)
  .regex(/^(?!\s)(?!.*\s$)[^\x00-\x1f\x7f-\x9f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb\ud800-\udfff]+$/);

export const QuickloginDeviceUpdateBody = z.strictObject({
  enabled: z.boolean(),
});

export const QuickloginDeviceRegistrationBody = z.strictObject({
  deviceName: boundedCanonicalText(80),
  browserFamily: z.literal("chrome"),
  browserVersion: boundedCanonicalText(40),
});

export const QuickloginDeviceHeartbeatBody = z.strictObject({
  protocolVersion: z.literal(1),
  appliedVersion: SafeNonNegativeInteger.nullable(),
  generation: SafeNonNegativeInteger,
  browserVersion: boundedCanonicalText(40),
});

export const QuickloginDeviceRefreshBody = z.strictObject({
  protocolVersion: z.literal(1),
  generation: SafeNonNegativeInteger,
});

export const QuickloginDeviceExportBody = z.strictObject({
  protocolVersion: z.literal(1),
  generation: SafeNonNegativeInteger,
  sessionVersion: SafeNonNegativeInteger,
});

export class QuickloginHttpError extends Error {
  constructor(public readonly code: ErrorCode, public readonly status: number) {
    super(code);
    this.name = "QuickloginHttpError";
  }
}

export function getTrustedClientIp(request: Request): string | null {
  const value = request.headers.get("CF-Connecting-IP")?.trim();
  return value || null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

export async function readJson(request: Request): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
    throw new QuickloginHttpError("INVALID_REQUEST", 415);
  }
  try { return await request.json(); }
  catch { throw new QuickloginHttpError("INVALID_REQUEST", 400); }
}

export function parseEnabled(value: unknown): boolean {
  const parsed = QuickloginDeviceUpdateBody.safeParse(value);
  if (!parsed.success) {
    throw new QuickloginHttpError("INVALID_REQUEST", 400);
  }
  return parsed.data.enabled;
}

function parseProtocol<T>(
  schema: z.ZodType<T>,
  value: unknown,
  keys: string[]
): T {
  if (record(value) && exactKeys(value, keys) && value.protocolVersion !== 1) {
    throw new QuickloginHttpError("PROTOCOL_UNSUPPORTED", 426);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new QuickloginHttpError("INVALID_REQUEST", 400);
  return parsed.data;
}

export function parseRefreshRequest(value: unknown): {
  protocolVersion: 1; generation: number;
} {
  return parseProtocol(
    QuickloginDeviceRefreshBody,
    value,
    ["generation", "protocolVersion"]
  );
}

export function parseExportRequest(value: unknown): {
  protocolVersion: 1; generation: number; sessionVersion: number;
} {
  return parseProtocol(
    QuickloginDeviceExportBody,
    value,
    ["generation", "protocolVersion", "sessionVersion"]
  );
}

export function parseDeviceMetadata(value: unknown): DeviceMetadata {
  const parsed = QuickloginDeviceRegistrationBody.safeParse(value);
  if (!parsed.success) throw new QuickloginHttpError("INVALID_REQUEST", 400);
  return parsed.data;
}

export function parseHeartbeat(value: unknown): HeartbeatInput {
  return parseProtocol(
    QuickloginDeviceHeartbeatBody,
    value,
    ["appliedVersion", "browserVersion", "generation", "protocolVersion"]
  );
}
