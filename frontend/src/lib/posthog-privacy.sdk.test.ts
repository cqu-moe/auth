// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PostHog } from "posthog-js/dist/module.no-external";
let PostHogClass: typeof PostHog;
import { sanitizePostHogEvent } from "./posthog";
type EventLike = { event: string; properties: Record<string, unknown> };

type RawEvent = EventLike & {
  uuid?: string;
  timestamp?: unknown;
  $set?: Record<string, unknown>;
  $set_once?: Record<string, unknown>;
};

const token = "phc-real-sdk-public-token";
const rawEvents: RawEvent[] = [];
const sanitizedEvents: RawEvent[] = [];
const requests: Array<{ url: string; body: unknown }> = [];
let client: PostHog | null = null;

beforeEach(async () => {
  vi.resetModules();
  rawEvents.length = 0;
  sanitizedEvents.length = 0;
  requests.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), body: init?.body });
    return Response.json({ status: 1 });
  }));
  PostHogClass = (await import("posthog-js/dist/module.no-external")).PostHog;
});

afterEach(async () => {
  await client?.shutdown();
  client = null;
  vi.unstubAllGlobals();
});

function initClient(): PostHog {
  client = new PostHogClass();
  client.init(token, {
    api_host: "https://p.cqu.moe",
    bootstrap: { distinctID: "central-user-a" },
    persistence: "memory",
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    capture_performance: false,
    disable_session_recording: true,
    disable_surveys: true,
    disable_product_tours: true,
    disable_web_experiments: true,
    advanced_disable_flags: true,
    request_batching: false,
    disable_compression: true,
    person_profiles: "never",
    api_transport: "fetch",
    ip: false,
    before_send: event => {
      rawEvents.push(event as RawEvent);
      const sanitized = sanitizePostHogEvent(event);
      sanitizedEvents.push(sanitized as RawEvent);
      return sanitized;
    },
  });
  return client;
}

function requestBody(body: unknown): Record<string, unknown> {
  if (body instanceof FormData) throw new Error("Unexpected form-data request");
  return JSON.parse(String(body)) as Record<string, unknown>;
}

describe("real posthog-js event sanitization", () => {
  it("preserves transport identity while removing SDK top-level person data and unknown properties", async () => {
    const instance = initClient();
    instance.capture("app_session_ready", {
      telemetry_version: 2,
      product: "auth",
      surface: "web",
      operation: "sync",
      outcome: "failure",
      email: "user@example.com",
      cookie: "secret-cookie",
      $current_url: "https://auth.cqu.moe/?token=secret-token",
    }, {
      send_instantly: true,
      $set: { $initial_current_url: "https://auth.cqu.moe/?email=user@example.com" },
      $set_once: { $initial_referring_domain: "sso.cqu.edu.cn" },
    } as never);

    const raw = rawEvents[0]!;
    expect(raw.properties.token).toBe(token);
    expect(raw.properties.distinct_id).toBe("central-user-a");
    expect(raw.$set).toBeDefined();
    expect(raw.$set_once).toBeDefined();

    const sanitized = sanitizedEvents[0]!;
    expect(Object.keys(sanitized).sort()).toEqual(["event", "properties", "timestamp", "uuid"]);
    expect(sanitized.properties.token).toBe(token);
    expect(sanitized.properties.$geoip_disable).toBe(true);
    expect(sanitized.properties.distinct_id).toBe("central-user-a");
    expect(sanitized.properties.$current_url).toBe("https://auth.cqu.moe/");
    expect(sanitized.properties.email).toBeUndefined();
    expect(sanitized.properties.cookie).toBeUndefined();
    expect(sanitized.$set).toBeUndefined();
    expect(sanitized.$set_once).toBeUndefined();
    expect(JSON.stringify(sanitized)).not.toContain("user@example.com");
    expect(JSON.stringify(sanitized)).not.toContain("secret-cookie");
    expect(JSON.stringify(sanitized)).not.toContain("secret-token");

    await vi.waitFor(() => expect(requests.some(request => {
      if (!request.url.includes("/e/") || request.body === undefined) return false;
      const payload = requestBody(request.body) as { batch: Array<{ event: string; properties: Record<string, unknown> }> };
      const event = payload.batch[0]!;
      return event.event === "app_session_ready" &&
        event.properties?.token === token && event.properties?.distinct_id === "central-user-a";
    }), JSON.stringify(requests)).toBe(true));
  });

  it("keeps only minimal identify association fields", () => {
    const instance = initClient();
    instance.capture("$identify", {
      distinct_id: "central-user-a",
      $anon_distinct_id: "installation-a",
      $user_id: "central-user-a",
      email: "user@example.com",
    }, {
      send_instantly: true,
      $set: { email: "user@example.com", name: "Real User" },
      $set_once: { $initial_browser: "Chrome" },
    } as never);

    const sanitized = sanitizedEvents[0]!;
    expect(sanitized.properties).toMatchObject({
      token,
      distinct_id: "central-user-a",
      $anon_distinct_id: "installation-a",
      $user_id: "central-user-a",
    });
    expect(sanitized.properties.email).toBeUndefined();
    expect(sanitized.$set).toBeUndefined();
    expect(sanitized.$set_once).toBeUndefined();
    expect(JSON.stringify(sanitized)).not.toContain("user@example.com");
    expect(JSON.stringify(sanitized)).not.toContain("Real User");
  });

  it("passes recorder-compressed snapshot data through without recursive rewriting", () => {
    const instance = initClient();
    const snapshotData = [{ type: 2, data: "\x1f\x8bopaque-compressed-dom-payload" }];
    instance.capture("$snapshot", {
      $snapshot_data: snapshotData,
      $snapshot_bytes: 43,
      $session_id: "session-a",
      $window_id: "window-a",
      $lib: "web",
      $lib_version: "1.433.5",
      $snapshot_host: "auth.cqu.moe",
      email: "user@example.com",
    }, {
      send_instantly: true,
      _batchKey: "recordings",
      _noTruncate: true,
    } as never);

    const raw = rawEvents[0]!;
    const sanitized = sanitizedEvents[0]!;
    expect(sanitized.properties.$snapshot_data).toBe(raw.properties.$snapshot_data);
    expect(sanitized.properties.$snapshot_data).toBe(snapshotData);
    expect(sanitized.properties.token).toBe(token);
    expect(sanitized.properties.$geoip_disable).toBe(true);
    expect(sanitized.properties.distinct_id).toBe("central-user-a");
    expect(sanitized.properties.$snapshot_bytes).toBe(43);
    expect(sanitized.properties.$session_id).toBe("session-a");
    expect(sanitized.properties.$window_id).toBe("window-a");
    expect(sanitized.properties.$snapshot_host).toBe("auth.cqu.moe");
    expect(sanitized.properties.email).toBeUndefined();
    expect(Object.keys(sanitized).sort()).toEqual(["event", "properties", "timestamp", "uuid"]);
  });
});
