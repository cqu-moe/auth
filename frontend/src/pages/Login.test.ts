import { describe, expect, it } from "vitest";
import {
  requiresLoginChallenge,
  getPostAuthNavigationDestination,
} from "../lib/login-routing";
import { withRedirectParam } from "../lib/post-login-redirect";

describe("password login routing", () => {
  it("recognizes a challenge before an authenticated user exists", () => {
    expect(requiresLoginChallenge({ twoFactorRedirect: true })).toBe(true);
    expect(requiresLoginChallenge({ user: { emailVerified: true } })).toBe(false);
  });

  it("returns to the originating app after a verified login", () => {
    expect(
      getPostAuthNavigationDestination(
        true,
        "https://schedule.cqu.moe/dashboard"
      )
    ).toBe("https://schedule.cqu.moe/dashboard");
  });

  it("keeps the CQU binding route around its nested Schedule target", () => {
    const binding = withRedirectParam(
      "/cqu/bind",
      "https://schedule.cqu.moe/dashboard?setup=1"
    );
    expect(getPostAuthNavigationDestination(true, binding)).toBe(binding);
  });

  it("keeps unverified users in the verification flow while preserving the return target", () => {
    expect(
      getPostAuthNavigationDestination(
        false,
        "https://schedule.cqu.moe/dashboard"
      )
    ).toBe("/verify-email?redirect=https%3A%2F%2Fschedule.cqu.moe%2Fdashboard");
  });

  it("sends registration straight back to the originating app once verified", () => {
    expect(
      getPostAuthNavigationDestination(true, "https://schedule.cqu.moe/add")
    ).toBe("https://schedule.cqu.moe/add");
    expect(getPostAuthNavigationDestination(false, "https://schedule.cqu.moe/add")).toBe(
      "/verify-email?redirect=https%3A%2F%2Fschedule.cqu.moe%2Fadd"
    );
    expect(getPostAuthNavigationDestination(true, null)).toBe("/settings");
    expect(getPostAuthNavigationDestination(false, null)).toBe("/verify-email");
  });
});
