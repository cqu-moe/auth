import posthog from "posthog-js";

type EventLike = {
  event: string;
  uuid?: unknown;
  timestamp?: unknown;
  properties: Record<string, unknown>;
};

type IdentityTransition = {
  identify: string | null;
  reset: boolean;
};

const REDACTED = "[redacted]";
const ORIGIN = "https://auth.cqu.moe";
const ALLOWED_EVENTS = new Set(["app_session_ready", "$identify", "$snapshot", "$exception"]);
const KNOWN_PATHS = new Set(["/", "/login", "/register", "/forgot-password", "/reset-password", "/settings", "/security", "/sessions", "/devices", "/quicklogin", "/oauth/authorize", "/auth/error"]);
const TRANSPORT_KEYS = new Set(["token", "distinct_id", "$device_id", "$session_id", "$window_id", "$lib", "$lib_version", "$process_person_profile"]);
const PROPERTY_ALLOWLIST = new Set(["telemetry_version", "product", "surface", "environment", "release", "actor_type", "trigger", "operation", "stage", "flow", "outcome", "error_code", "warning_code", "duration_ms", "duration_basis", "operation_id", "no_op", "is_test", "format", "source_type", "view_type", "route", "$process_person_profile"]);
const SNAPSHOT_KEYS = new Set([...TRANSPORT_KEYS, "$snapshot_data", "$snapshot_bytes", "$snapshot_host"]);
const IDENTIFY_KEYS = new Set([...TRANSPORT_KEYS, "$anon_distinct_id", "$user_id"]);
const EXCEPTION_CLASSES = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError", "DOMException", "AbortError"]);
export function templateRoutePath(pathname: string): string {
  if (KNOWN_PATHS.has(pathname)) return pathname;
  return "/unknown";
}

function safeUrl(value: unknown): string {
  try {
    const url = new URL(String(value), ORIGIN);
    return url.origin === ORIGIN ? ORIGIN + templateRoutePath(url.pathname) : ORIGIN + "/unknown";
  } catch { return ORIGIN + "/unknown"; }
}

function sanitizeValue(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    if (key === "$current_url") return safeUrl(value);
    if ((key === "error_code" || key === "warning_code") && !/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(value)) return "UNKNOWN_ERROR";
    return value.length <= 128 ? value : REDACTED;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || value === null) return value;
  return REDACTED;
}

export function sanitizePostHogEvent<T extends EventLike>(event: T | null): T | null {
  if (!event || !ALLOWED_EVENTS.has(event.event)) return null;
  const source = event.properties ?? {};
  const keys = event.event === "$snapshot" ? SNAPSHOT_KEYS
    : event.event === "$identify" ? IDENTIFY_KEYS
    : new Set([...TRANSPORT_KEYS, ...PROPERTY_ALLOWLIST, "$current_url"]);
  const properties: Record<string, unknown> = { $geoip_disable: true };
  for (const key of keys) {
    if (!(key in source)) continue;
    properties[key] = event.event === "$snapshot" || TRANSPORT_KEYS.has(key) || IDENTIFY_KEYS.has(key)
      ? source[key] : sanitizeValue(source[key], key);
  }
  {
    // reset() clears registered properties; every business event keeps its contract.
    Object.assign(properties, { telemetry_version: 2, product: "auth", surface: "web", environment, release,
      ...(isTestEvent ? { is_test: true } : {}) });
  }
  if (event.event === "$exception") {
    const first = Array.isArray(source.$exception_list) ? source.$exception_list[0] : undefined;
    const type = first && EXCEPTION_CLASSES.has(first.type) ? first.type : "Error";
    properties.$exception_list = [{ type, value: "Unhandled browser error", mechanism: { type: "generic", handled: false } }];
    properties.$exception_type = type;
    properties.error_code = "EXCEPTION";
    properties.operation = "exception";
    properties.outcome = "failure";
  }
  // SDK-generated $set and $set_once may contain initial URLs and referrers.
  return { event: event.event, ...(event.uuid === undefined ? {} : { uuid: event.uuid }),
    ...(event.timestamp === undefined ? {} : { timestamp: event.timestamp }), properties } as T;
}

export function identityTransition(
  previousUserId: string | null | undefined,
  currentUserId: string | null
): IdentityTransition {
  if (currentUserId) {
    return {
      identify: currentUserId,
      reset: typeof previousUserId === "string" && previousUserId !== currentUserId,
    };
  }
  return {
    identify: null,
    reset: typeof previousUserId === "string",
  };
}

const token = import.meta.env.VITE_POSTHOG_PROJECT_TOKEN?.trim();
const host = import.meta.env.VITE_POSTHOG_HOST?.trim() || "https://p.cqu.moe";
const isTestEvent = !import.meta.env.PROD || (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("telemetry_test") === "1");
const environment = import.meta.env.PROD ? "production" : import.meta.env.MODE === "test" ? "test" : "development";
const release = import.meta.env.VITE_RELEASE?.trim() || "development";
let initialized = false;

function clearLegacyPostHogCookie(projectToken: string): void {
  const encodedToken = projectToken.replace(/\+/g, "PL").replace(/\//g, "SL").replace(/=/g, "EQ");
  const name = `ph_${encodedToken}_posthog`;
  document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax`;
  if (window.location.hostname === "cqu.moe" || window.location.hostname.endsWith(".cqu.moe")) {
    document.cookie = `${name}=; Max-Age=0; Path=/; Domain=.cqu.moe; Secure; SameSite=Lax`;
  }
}

export function initPostHog(): boolean {
  if (initialized) return true;
  if (!import.meta.env.PROD && import.meta.env.VITE_POSTHOG_ALLOW_NON_PRODUCTION !== "true") return false;
  if (!token) {
    if (import.meta.env.DEV) {
      console.error(
        "VITE_POSTHOG_PROJECT_TOKEN is not configured; PostHog events will be missed in this development build."
      );
    }
    return false;
  }

  clearLegacyPostHogCookie(token);
  posthog.init(token, {
    api_host: host,
    asset_host: host,
    ui_host: "https://us.posthog.com",
    persistence: "localStorage",
    cross_subdomain_cookie: false,
    defaults: "2026-05-30",
    capture_pageview: false,
    capture_pageleave: false,
    capture_exceptions: {
      capture_unhandled_errors: true,
      capture_unhandled_rejections: true,
      capture_console_errors: false,
    },
    autocapture: false,
    capture_performance: false,
    capture_dead_clicks: false,
    disable_surveys: true,
    disable_product_tours: true,
    disable_web_experiments: true,
    disable_conversations: true,
    advanced_disable_flags: true,
    save_referrer: false,
    save_campaign_params: false,
    disable_scroll_properties: true,
    logs: { captureConsoleLogs: false },
    capture_heatmaps: false,
    disable_session_recording: true,
    session_recording: {
      sampleRate: 1,
      maskAllInputs: true,
      maskTextSelector: "*",
      maskTextFn: () => REDACTED,
      maskAllElementAttributes: true,
      blockSelector: "img,picture,svg,video,audio,canvas,iframe,[data-sensitive],[data-ph-no-capture]",
      slimDOMOptions: "all",
      collectFonts: false,
      captureJsonLd: false,
      recordCrossOriginIframes: false,
      recordHeaders: false,
      recordBody: false,
      streamNetworkBody: false,
      captureCanvas: { recordCanvas: false },
      maskCapturedNetworkRequestFn: request => Object.keys(request).length === 1
        ? { ...request, name: safeUrl(request.name) } : null,
    },
    before_send: event => event?.event === "$snapshot" && window.location.origin !== ORIGIN ? null : sanitizePostHogEvent(event),
    person_profiles: "identified_only",
    ip: false,
  });
  posthog.register({
    telemetry_version: 2,
    product: "auth",
    surface: "web",
    environment,
    release,
    actor_type: "user",
    trigger: "user",
    ...(isTestEvent ? { is_test: true } : {}),
  });
  initialized = true;
  return true;
}

export function isPostHogEnabled(): boolean {
  return initialized;
}

export function syncPostHogIdentity(
  previousUserId: string | null | undefined,
  currentUserId: string | null
): void {
  if (!initialized) return;
  const persistedUserId = posthog.get_property("$user_id");
  const action = identityTransition(typeof persistedUserId === "string" ? persistedUserId : previousUserId, currentUserId);
  if (action.reset) posthog.reset();
  if (action.identify) posthog.identify(action.identify);
}

export function capturePostHogSessionReady(): void {
  if (!initialized) return;
  posthog.capture("app_session_ready", {
    operation: "session",
    stage: "ready",
    outcome: "success",
  });
}

export function syncPostHogReplay(pathname: string): void {
  if (!initialized) return;
  if (window.location.origin === ORIGIN && pathname.startsWith("/")) posthog.startSessionRecording(true);
  else posthog.stopSessionRecording();
}

export { posthog };
