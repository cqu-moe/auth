import { PostHog, type EventMessage } from "posthog-node";
import type { Context } from "hono";
import type { HonoEnv } from "../types";

type TelemetryEnv = {
  POSTHOG_PROJECT_TOKEN?: string;
  POSTHOG_HOST?: string;
  ENVIRONMENT?: string;
  RELEASE?: string;
};

type Lifecycle = {
  waitUntil(promise: Promise<unknown>): void;
};

const REDACTED = "[redacted]";
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const LABELED_SECRET = /\b(password|cookie|authorization|token|student_?id|email|otp|code|ticket)\s*[:=]\s*[^\s,;&]+/gi;
const BEARER = /\bBearer\s+[^\s,;&]+/gi;

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return normalized === "password"
    || normalized === "authorization"
    || normalized === "studentid"
    || normalized === "email"
    || normalized === "otp"
    || normalized === "code"
    || normalized === "ticket"
    || normalized === "schedule"
    || normalized === "subscriptionurl"
    || normalized.endsWith("password")
    || normalized.endsWith("cookie")
    || normalized.endsWith("token")
    || (normalized.endsWith("code") && normalized !== "errorcode");
}

function redactText(value: string): string {
  return value
    .replace(EMAIL, REDACTED)
    .replace(LABELED_SECRET, (_match, label: string) => `${label}=${REDACTED}`)
    .replace(BEARER, `Bearer ${REDACTED}`);
}

function normalizedPath(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => {
      if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(segment)) return ":id";
      if (/^\d{6,}$/.test(segment)) return ":id";
      if (/^(?=.*[a-z])(?=.*\d)[a-z0-9_-]{16,}$/i.test(segment)) return ":id";
      return segment;
    })
    .join("/");
}

function sanitizeUrl(value: string): string {
  try {
    const relative = value.startsWith("/");
    const url = new URL(value, "https://redacted.invalid");
    url.pathname = normalizedPath(url.pathname);
    url.search = "";
    url.hash = "";
    return relative ? url.pathname : url.toString();
  } catch {
    return redactText(value.split(/[?#]/, 1)[0] ?? "");
  }
}

function sanitizeValue(value: unknown, key = ""): unknown {
  if (isSensitiveKey(key)) return REDACTED;
  if (typeof value === "string") {
    const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    return normalized.includes("url") || normalized.includes("referrer")
      ? sanitizeUrl(value)
      : redactText(value);
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        sanitizeValue(childValue, childKey),
      ])
    );
  }
  return value;
}

export function sanitizePostHogProperties(
  properties: Record<string, unknown>
): Record<string, unknown> {
  return sanitizeValue(properties) as Record<string, unknown>;
}

function sanitizedError(error: unknown): Error {
  if (!(error instanceof Error)) return new Error(redactText(String(error)));
  const safe = new Error(redactText(error.message));
  safe.name = error.name;
  if (error.stack) safe.stack = redactText(error.stack);
  return safe;
}

function createClient(env: TelemetryEnv): PostHog | null {
  const token = env.POSTHOG_PROJECT_TOKEN?.trim();
  if (!token) return null;
  return new PostHog(token, {
    host: env.POSTHOG_HOST?.trim() || "https://p.cqu.moe",
    flushAt: 1,
    flushInterval: 0,
    requestTimeout: 2_000,
    fetchRetryCount: 1,
    privacyMode: true,
    enableExceptionAutocapture: false,
    before_send: (event: EventMessage | null) => {
      if (!event) return null;
      return {
        ...event,
        properties: sanitizePostHogProperties(event.properties ?? {}),
      };
    },
  });
}

function finish(client: PostHog, lifecycle?: Lifecycle): void {
  const closing = client.shutdown(2_000).catch(() => undefined);
  try {
    lifecycle?.waitUntil(closing);
  } catch {
    void closing;
  }
}

function baseProperties(env: TelemetryEnv): Record<string, unknown> {
  return {
    service: "auth-worker",
    environment: env.ENVIRONMENT || "development",
    release: env.RELEASE || "development",
  };
}

export function captureWorkerEvent(
  env: TelemetryEnv,
  lifecycle: Lifecycle | undefined,
  event: string,
  distinctId: string,
  properties: Record<string, unknown>
): void {
  try {
    const client = createClient(env);
    if (!client) return;
    client.capture({
      distinctId,
      event,
      properties: sanitizePostHogProperties({ ...baseProperties(env), ...properties }),
    });
    finish(client, lifecycle);
  } catch {
    // Telemetry must never change a business response.
  }
}

export function captureWorkerException(
  env: TelemetryEnv,
  lifecycle: Lifecycle | undefined,
  error: unknown,
  properties: Record<string, unknown> = {},
  distinctId = crypto.randomUUID()
): void {
  try {
    const client = createClient(env);
    if (!client) return;
    client.captureException(sanitizedError(error), distinctId, sanitizePostHogProperties({
      ...baseProperties(env),
      ...properties,
      $process_person_profile: false,
    }));
    finish(client, lifecycle);
  } catch {
    // Telemetry must never change a business response.
  }
}

export function captureHonoException(
  error: unknown,
  c: Context<HonoEnv>,
  properties: Record<string, unknown> = {}
): void {
  const lifecycle = lifecycleFromContext(c);
  captureWorkerException(c.env, lifecycle, error, {
    method: c.req.method,
    route: normalizedPath(c.req.path),
    request_id: c.req.header("cf-ray")?.split("-")[0] || crypto.randomUUID(),
    ...properties,
  });
}

function lifecycleFromContext(c: Context<HonoEnv>): Lifecycle | undefined {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}

export function captureHonoEvent(
  c: Context<HonoEnv>,
  event: string,
  distinctId: string,
  properties: Record<string, unknown>
): void {
  captureWorkerEvent(c.env, lifecycleFromContext(c), event, distinctId, properties);
}
