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
        service: "auth-web",
        password: "secret-password",
        nested: {
          cookie: "session=secret-cookie",
          message: "request failed token=secret-token for user@example.com",
        },
        $current_url: "https://auth.cqu.moe/login?code=secret-code#fragment",
        $referrer: "https://schedule.cqu.moe/?subscription=secret-link",
      },
    });

    expect(JSON.stringify(event)).not.toContain("secret-password");
    expect(JSON.stringify(event)).not.toContain("secret-cookie");
    expect(JSON.stringify(event)).not.toContain("secret-token");
    expect(JSON.stringify(event)).not.toContain("secret-code");
    expect(JSON.stringify(event)).not.toContain("secret-link");
    expect(JSON.stringify(event)).not.toContain("user@example.com");
    expect(event?.properties).toMatchObject({
      service: "auth-web",
      password: "[redacted]",
      $current_url: "https://auth.cqu.moe/login",
      $referrer: "https://schedule.cqu.moe/",
    });
  });
});

describe("browser identity transitions", () => {
  it("identifies a restored session without reporting a fresh login", () => {
    expect(identityTransition(undefined, "user-1")).toEqual({
      identify: "user-1",
      captureLogin: false,
      reset: false,
    });
  });

  it("reports one login only when an anonymous session becomes authenticated", () => {
    expect(identityTransition(null, "user-1")).toEqual({
      identify: "user-1",
      captureLogin: true,
      reset: false,
    });
  });

  it("resets before switching accounts and after logout", () => {
    expect(identityTransition("user-1", "user-2")).toEqual({
      identify: "user-2",
      captureLogin: false,
      reset: true,
    });
    expect(identityTransition("user-1", null)).toEqual({
      identify: null,
      captureLogin: false,
      reset: true,
    });
  });
});
