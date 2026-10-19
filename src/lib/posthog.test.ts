import { afterEach, describe, expect, it, vi } from "vitest";
import { gunzipSync } from "node:zlib";
import { captureWorkerException, sanitizePostHogProperties } from "./posthog";

afterEach(() => vi.unstubAllGlobals());

describe("Worker PostHog privacy boundary", () => {
  it("sends real SDK frames and groups operations without exposing messages or causes", async () => {
    vi.stubGlobal("_posthogChunkIds", { "Error\n    at index.js:1:1": "11111111-2222-4333-8444-555555555555" });
    const payloads: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      const bytes = Buffer.from(await new Response(init?.body).arrayBuffer());
      payloads.push((bytes[0] === 0x1f ? gunzipSync(bytes) : bytes).toString());
      return new Response("{}", { status: 200 });
    }));
    const pending: Promise<unknown>[] = [];
    const lifecycle = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } };
    for (const operation of ["external_search", "external_capture"]) {
      const error = new TypeError("password=private-password", { cause: new Error("private-cause") });
      error.stack = "TypeError: password=private-password\n    at runOperation (index.js:42:7)\n    at unknown (https://school.example/private-student:1:1)";
      captureWorkerException({ POSTHOG_PROJECT_TOKEN: "phc_offline", ENVIRONMENT: "test", POSTHOG_ENABLED: "true" }, lifecycle, error, { operation, error_code: "TRANSIENT" });
    }
    await Promise.all(pending);
    const events = payloads.flatMap(body => JSON.parse(body).batch);
    expect(events).toHaveLength(2);
    expect(events[0].properties.$exception_list).toMatchObject([{
      type: "TypeError", stacktrace: { type: "raw", frames: [{ filename: "index.js", function: "runOperation", lineno: 42, colno: 7, chunk_id: "11111111-2222-4333-8444-555555555555" }] },
    }]);
    expect(events[0].properties.$exception_fingerprint).not.toBe(events[1].properties.$exception_fingerprint);
    for (const secret of ["private-password", "private-cause", "private-student"]) expect(payloads.join()).not.toContain(secret);
  });

  it("redacts nested secrets, identifiers, and URL query data", () => {
    const properties = sanitizePostHogProperties({
      telemetry_version: 2,
      product: "auth",
      surface: "worker",
      password: "secret-password",
      DPoP: "secret-proof",
      detail: "authorization: DPoP secret-dpop-token dpop=secret-proof-log",
      cookie: "secret-cookie",
      authorization: "Bearer secret-token",
      studentId: "2026000000",
      email: "user@example.com",
      code: "123456",
      url: "https://auth.cqu.moe/api/v1/cqu/binding?token=secret-token#fragment",
      "$exception_type": "TypeError",
      "$exception_message": "password=secret-password",
      "$exception_stack_trace": "Error: ticket=secret-ticket",
      exception: {
        message: "failed with ticket=secret-ticket for user@example.com",
        stack: "safe-stack",
      },
      unauthorized_property: "not part of the v2 contract",
    });

    const serialized = JSON.stringify(properties);
    for (const secret of [
      "secret-password",
      "secret-proof",
      "secret-dpop-token",
      "secret-cookie",
      "secret-token",
      "2026000000",
      "user@example.com",
      "123456",
      "secret-ticket",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(properties).toMatchObject({
      telemetry_version: 2,
      product: "auth",
      surface: "worker",
    });
    expect(properties).not.toHaveProperty("url");
    expect(properties).not.toHaveProperty("exception");
    expect(properties).not.toHaveProperty("unauthorized_property");
    expect(properties).not.toHaveProperty("$exception_message");
    expect(properties).not.toHaveProperty("$exception_stack_trace");
    expect(properties).toMatchObject({ $exception_type: "TypeError" });
  });
});
