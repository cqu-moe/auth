import { describe, expect, it } from "vitest";
import { sanitizePostHogProperties } from "./posthog";

describe("Worker PostHog privacy boundary", () => {
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
