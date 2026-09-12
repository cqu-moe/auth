import type { DeviceMetadata, ErrorCode, HeartbeatInput } from "./contracts";

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
  try { return await request.json(); }
  catch { throw new QuickloginHttpError("INVALID_REQUEST", 422); }
}

export function parseEnabled(value: unknown): boolean {
  if (!record(value) || !exactKeys(value, ["enabled"]) ||
      typeof value.enabled !== "boolean") {
    throw new QuickloginHttpError("INVALID_REQUEST", 422);
  }
  return value.enabled;
}

function protocolRecord(value: unknown, keys: string[]): Record<string, unknown> {
  if (!record(value) || !exactKeys(value, keys)) {
    throw new QuickloginHttpError("INVALID_REQUEST", 422);
  }
  if (value.protocolVersion !== 1) {
    throw new QuickloginHttpError("PROTOCOL_UNSUPPORTED", 426);
  }
  return value;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function parseRefreshRequest(value: unknown): {
  protocolVersion: 1; generation: number;
} {
  const body = protocolRecord(value, ["generation", "protocolVersion"]);
  if (!nonNegativeSafeInteger(body.generation)) {
    throw new QuickloginHttpError("INVALID_REQUEST", 422);
  }
  return body as { protocolVersion: 1; generation: number };
}

export function parseExportRequest(value: unknown): {
  protocolVersion: 1; generation: number; sessionVersion: number;
} {
  const body = protocolRecord(value, ["generation", "protocolVersion", "sessionVersion"]);
  if (!nonNegativeSafeInteger(body.generation) ||
      !nonNegativeSafeInteger(body.sessionVersion)) {
    throw new QuickloginHttpError("INVALID_REQUEST", 422);
  }
  return body as { protocolVersion: 1; generation: number; sessionVersion: number };
}

export function parseDeviceMetadata(value: unknown): DeviceMetadata {
  if (!record(value) ||
      !exactKeys(value, ["browserFamily", "browserVersion", "deviceName"])) {
    throw new QuickloginHttpError("INVALID_REQUEST", 422);
  }
  const deviceName = typeof value.deviceName === "string" ? value.deviceName.trim() : "";
  const browserVersion = typeof value.browserVersion === "string"
    ? value.browserVersion.trim() : "";
  if (
    value.browserFamily !== "chrome" ||
    deviceName.length < 1 || deviceName.length > 80 ||
    browserVersion.length < 1 || browserVersion.length > 40 ||
    /[\x00-\x1f\x7f]/.test(deviceName + browserVersion)
  ) throw new QuickloginHttpError("INVALID_REQUEST", 422);
  return { deviceName, browserFamily: "chrome", browserVersion };
}

export function parseHeartbeat(value: unknown): HeartbeatInput {
  const body = protocolRecord(value, [
    "appliedVersion", "browserVersion", "generation", "protocolVersion",
  ]);
  if (!nonNegativeSafeInteger(body.generation) ||
      (body.appliedVersion !== null && !nonNegativeSafeInteger(body.appliedVersion)) ||
      typeof body.browserVersion !== "string" ||
      body.browserVersion.trim().length < 1 || body.browserVersion.trim().length > 40 ||
      /[\x00-\x1f\x7f]/.test(body.browserVersion)) {
    throw new QuickloginHttpError("INVALID_REQUEST", 422);
  }
  return { ...body, browserVersion: body.browserVersion.trim() } as HeartbeatInput;
}
