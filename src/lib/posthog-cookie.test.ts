import { describe, expect, it } from "vitest";
import { postHogCookieResetResponse } from "./posthog-cookie";

describe("PostHog cookie recovery", () => {
  it("clears the host and cross-domain cookie without touching auth cookies", () => {
    const response = postHogCookieResetResponse("test");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("ph_test_posthog=");
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("Domain=.cqu.moe");
    expect(cookie).not.toContain("better-auth");
  });
});
