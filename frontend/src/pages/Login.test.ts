import { describe, expect, it } from "vitest";
import {
  getLoginNavigationDestination,
  getPostAuthNavigationDestination,
  shouldSkipPostLoginNavigation,
} from "../lib/login-routing";
import { withRedirectParam } from "../lib/post-login-redirect";

describe("password login routing", () => {
  it("does not navigate while the native two-factor plugin owns the redirect", () => {
    expect(shouldSkipPostLoginNavigation({ twoFactorRedirect: true })).toBe(true);
  });

  it("continues to a normal post-login destination otherwise", () => {
    expect(shouldSkipPostLoginNavigation({ user: { emailVerified: true } })).toBe(false);
    expect(shouldSkipPostLoginNavigation(null)).toBe(false);
    expect(getLoginNavigationDestination({ user: { emailVerified: true } })).toBe("/settings");
    expect(getLoginNavigationDestination({ user: { emailVerified: false } })).toBe("/verify-email");
  });

  it("has no post-login destination when the native plugin redirects to two-factor", () => {
    expect(getLoginNavigationDestination({ twoFactorRedirect: true })).toBeNull();
  });

  it("returns to the originating app after a verified login", () => {
    expect(
      getLoginNavigationDestination(
        { user: { emailVerified: true } },
        "https://schedule.cqu.moe/dashboard"
      )
    ).toBe("https://schedule.cqu.moe/dashboard");
  });

  it("keeps the CQU binding route around its nested Schedule target", () => {
    const binding = withRedirectParam(
      "/cqu/bind",
      "https://schedule.cqu.moe/dashboard?setup=1"
    );
    expect(getLoginNavigationDestination({ user: { emailVerified: true } }, binding)).toBe(binding);
  });

  it("keeps unverified users in the verification flow while preserving the return target", () => {
    expect(
      getLoginNavigationDestination(
        { user: { emailVerified: false } },
        "https://schedule.cqu.moe/dashboard"
      )
    ).toBe("/verify-email?redirect=https%3A%2F%2Fschedule.cqu.moe%2Fdashboard");
  });

  it("still defers to the native two-factor plugin when a return target exists", () => {
    expect(
      getLoginNavigationDestination(
        { twoFactorRedirect: true },
        "https://schedule.cqu.moe/dashboard"
      )
    ).toBeNull();
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
