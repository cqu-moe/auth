import { describe, expect, it } from "vitest";
import {
  identityTransition,
  sanitizePostHogEvent,
} from "./posthog";

describe("browser PostHog privacy boundary", () => {
  it("removes secrets and personal data while keeping safe diagnostics", () => {
    const event = sanitizePostHogEvent({
      event: "$exception",
      properties: {
        product: "auth",
        "$exception_list": [{
          type: "TypeError",
          value: "password=secret-password ticket=secret-ticket user@example.com",
          stacktrace: { frames: [{ filename: "https://auth.cqu.moe/assets/index.js?token=secret-token" }] },
        }],
        "$exception_message": "cookie=secret-cookie",
        "$exception_stack_trace": "Error: token=secret-token",
        password: "secret-password",
        nested: {
          cookie: "session=secret-cookie",
          message: "request failed token=secret-token for user@example.com",
        },
        $current_url: "https://auth.cqu.moe/login?code=secret-code#fragment",
        $referrer: "https://schedule.cqu.moe/?subscription=secret-link",
        arbitrary_property: "removed",
      },
    });

    expect(JSON.stringify(event)).not.toContain("secret-password");
    expect(JSON.stringify(event)).not.toContain("secret-cookie");
    expect(JSON.stringify(event)).not.toContain("secret-token");
    expect(JSON.stringify(event)).not.toContain("secret-code");
    expect(JSON.stringify(event)).not.toContain("secret-link");
    expect(JSON.stringify(event)).not.toContain("user@example.com");
    expect(event?.properties).toMatchObject({ $exception_type: "TypeError", error_code: "EXCEPTION" });
    expect(event?.properties.$exception_list).toEqual([expect.objectContaining({ type: "TypeError", value: "Unhandled browser error" })]);
    expect(event?.properties).not.toHaveProperty("$exception_message");
    expect(event?.properties).not.toHaveProperty("$exception_stack_trace");
    expect(event?.properties).toMatchObject({
      product: "auth",
      $current_url: "https://auth.cqu.moe/login",
    });
    expect(event?.properties).not.toHaveProperty("password");
    expect(event?.properties).not.toHaveProperty("arbitrary_property");
    expect(sanitizePostHogEvent({ event: "$autocapture", properties: {} })).toBeNull();
  });

  it("allows identify while withholding person properties", () => {
    const event = sanitizePostHogEvent({
      event: "$identify",
      properties: {
        "$anon_distinct_id": "anonymous-device-id",
        "$set": { email: "user@example.com", name: "Private User" },
      },
    });

    expect(JSON.stringify(event)).not.toContain("user@example.com");
    expect(event?.properties).toMatchObject({ $anon_distinct_id: "anonymous-device-id" });
    expect(event?.properties).not.toHaveProperty("$set");
  });
});

describe("browser identity transitions", () => {
  it("identifies restored sessions and resets only on account change or logout", () => {
    expect(identityTransition(undefined, "user-1")).toEqual({ identify: "user-1", reset: false });
    expect(identityTransition(null, "user-1")).toEqual({ identify: "user-1", reset: false });
    expect(identityTransition("user-1", "user-2")).toEqual({ identify: "user-2", reset: true });
    expect(identityTransition("user-1", null)).toEqual({ identify: null, reset: true });
  });
});
