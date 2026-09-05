import { describe, expect, it } from "vitest";
import {
  getLoginNavigationDestination,
  shouldSkipPostLoginNavigation,
} from "./Login";

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
});
