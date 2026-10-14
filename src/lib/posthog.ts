import { PostHog, type EventMessage } from "posthog-node";
import type { Context } from "hono";
import type { HonoEnv } from "../types";

type TelemetryEnv = {
  POSTHOG_PROJECT_TOKEN?: string;
  POSTHOG_HOST?: string;
  ENVIRONMENT?: string;
  POSTHOG_ENABLED?: string;
  RELEASE?: string;
};

type Lifecycle = {
  waitUntil(promise: Promise<unknown>): void;
};

const REDACTED = "[redacted]";
const PROPERTY_ALLOWLIST = new Set([
  "telemetry_version",
  "is_test",
  "$exception_list",
  "product",
  "surface",
  "environment",
  "release",
  "actor_type",
  "trigger",
  "flow",
  "operation",
  "stage",
  "outcome",
  "no_op",
  "duration_ms",
  "end_to_end_duration_ms",
  "duration_basis",
  "error_code",
  "warning_code",
  "request_id",
  "method",
  "route",
  "component",
  "operation_id",
  "$process_person_profile",
  "$exception_type",
  "$exception_level",
  "$exception_is_synthetic",
  "$exception_timestamp",
  "$level",
  "$lib",
  "$lib_version",
  "$sdk",
]);
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const LABELED_SECRET = /\b(dpop|password|cookie|authorization|token|student_?id|email|otp|code|ticket)\s*[:=]\s*[^\s,;&]+/gi;
const BEARER = /\b(?:Bearer|DPoP)\s+[^\s,;&]+/gi;

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return normalized === "password"
    || normalized === "authorization"
    || normalized === "dpop"
    || normalized === "dpopproof"
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
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(LABELED_SECRET, (_match, label: string) => `${label}=${REDACTED}`);
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
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeValue(item, key));
  }
  return REDACTED;
}

export function sanitizePostHogProperties(
  properties: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(properties)
      .filter(([key]) => PROPERTY_ALLOWLIST.has(key))
      .map(([key, value]) => [key, key === "$exception_list" ? [{ type: "Error", value: "Worker error", mechanism: { type: "generic", handled: true } }] : sanitizeValue(value, key)])
  );
}

function boundedExceptionClass(error: unknown): string {
  const source = error instanceof Error ? error.name : "Error";
  const normalized = source.replace(/[^A-Za-z0-9_$]/g, "");
  return /^[A-Z][A-Za-z0-9_$]{0,63}$/.test(normalized) ? normalized : "Error";
}

function sanitizedError(error: unknown): Error {
  // The original message and stack must never reach the SDK transport. Raw text
  // redaction is not used as the privacy boundary for exception payloads.
  const safe = new Error(REDACTED);
  safe.name = boundedExceptionClass(error);
  safe.stack = "";
  return safe;
}

function createClient(env: TelemetryEnv): PostHog | null {
  const token = env.POSTHOG_PROJECT_TOKEN?.trim();
  if (!token || !isWorkerTelemetryConfigured(env)) return null;
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
        properties: { ...sanitizePostHogProperties(event.properties ?? {}), $geoip_disable: true },
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
  const environment = env.ENVIRONMENT === "production" || env.ENVIRONMENT === "test"
    ? env.ENVIRONMENT
    : "development";
  return {
    telemetry_version: 2,
    product: "auth",
    surface: "worker",
    environment,
    release: env.RELEASE || "development",
    ...(environment !== "production" ? { is_test: true } : {}),
  };
}

export function isWorkerTelemetryConfigured(env: TelemetryEnv): boolean {
  return Boolean(env.POSTHOG_PROJECT_TOKEN?.trim()) && (env.POSTHOG_ENABLED === "true" || env.ENVIRONMENT === "production");
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

type AuthFlow = "login" | "binding" | "authorization";

function captureAuthFlow(
  c: Context<HonoEnv>,
  event: "auth_flow_started" | "auth_flow_finished",
  flow: AuthFlow,
  properties: Record<string, unknown>,
  distinctId?: string
): void {
  captureHonoEvent(
    c,
    event,
    distinctId ?? crypto.randomUUID(),
    {
      actor_type: distinctId ? "user" : "system",
      trigger: "user",
      flow,
      ...properties,
      ...(distinctId ? {} : { $process_person_profile: false }),
    }
  );
}

export function captureAuthFlowStarted(
  c: Context<HonoEnv>,
  flow: AuthFlow,
  properties: Record<string, unknown>,
  distinctId?: string
): string | null {
  if (!isWorkerTelemetryConfigured(c.env)) return null;
  const operationId = crypto.randomUUID();
  captureAuthFlow(c, "auth_flow_started", flow, { operation_id: operationId, ...properties }, distinctId);
  return operationId;
}

export function captureAuthFlowFinished(
  c: Context<HonoEnv>,
  flow: AuthFlow,
  operationId: string | null,
  outcome: "success" | "failure" | "partial" | "canceled" | "needs_input" | "unverified",
  properties: Record<string, unknown>,
  options: { durationMs?: number; distinctId?: string } = {}
): void {
  if (!isWorkerTelemetryConfigured(c.env) || !operationId) return;
  captureAuthFlow(
    c,
    "auth_flow_finished",
    flow,
    {
      operation_id: operationId,
      outcome,
      ...(options.durationMs === undefined ? {} : { duration_ms: options.durationMs }),
      ...(options.durationMs === undefined ? {} : { duration_basis: "request" }),
      ...properties,
    },
    options.distinctId
  );
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
  captureWorkerEvent(c.env, lifecycleFromContext(c), event, distinctId, { ...properties, ...(c.req.header("x-cqu-telemetry-test") === "1" ? { is_test: true } : {}) });
}
