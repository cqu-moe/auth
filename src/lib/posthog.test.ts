import { describe, expect, it } from "vitest";
import { sanitizePostHogProperties } from "./posthog";

describe("Worker PostHog privacy boundary", () => {
  it("redacts nested secrets, identifiers, and URL query data", () => {
    const properties = sanitizePostHogProperties({
      service: "auth-worker",
      password: "secret-password",
      DPoP: "secret-proof",
      detail: "DPoP secret-dpop-token dpop=secret-proof-log",
      cookie: "secret-cookie",
      authorization: "Bearer secret-token",
      studentId: "2026000000",
      email: "user@example.com",
      code: "123456",
      url: "https://auth.cqu.moe/api/v1/cqu/binding?token=secret-token#fragment",
      exception: {
        message: "failed with ticket=secret-ticket for user@example.com",
        stack: "safe-stack",
      },
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
      service: "auth-worker",
      url: "https://auth.cqu.moe/api/v1/cqu/binding",
      exception: { stack: "safe-stack" },
    });
  });
});
