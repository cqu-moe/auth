import { describe, expect, it } from "vitest";
import {
  bindingReturnTarget,
  isScheduleBindingContinuation,
  protectedLoginUrl,
  verificationContinuation,
} from "./cqu-bind-continuation";
import { withRedirectParam } from "./post-login-redirect";
import { getLoginNavigationDestination } from "./login-routing";

const service = "https://schedule.cqu.moe/dashboard?setup=1";
const binding = withRedirectParam("/cqu/bind", service);

describe("CQU binding continuation", () => {
  it("returns to binding after login, keeping the service nested", () => {
    const url = new URL(binding, "https://auth.cqu.moe");
    const login = protectedLoginUrl(url.pathname, url.search);
    const target = new URL(login, url.origin).searchParams.get("redirect");
    expect(target).toBe(binding);
    expect(getLoginNavigationDestination({ user: { emailVerified: true } }, target)).toBe(binding);
  });

  it("does not unwrap the service when verifying on the binding route", () => {
    const url = new URL(binding, "https://auth.cqu.moe");
    expect(verificationContinuation(url.pathname, url.search)).toBe(binding);
  });

  it("keeps the already stored target on login and verification pages", () => {
    const search = `?redirect=${encodeURIComponent(binding)}`;
    for (const path of ["/login", "/register", "/two-factor", "/verify-email"]) {
      expect(verificationContinuation(path, search)).toBe(binding);
    }
  });

  it.each([
    "https://evil.example/",
    "https://user:pass@schedule.cqu.moe/",
    "https://auth.cqu.moe/cqu/bind",
    "//schedule.cqu.moe/",
    "/cqu/bind",
    "javascript:alert(1)",
  ])("rejects unsafe or looping final targets: %s", (target) => {
    expect(bindingReturnTarget(target, "https://auth.cqu.moe")).toBeNull();
  });

  it("accepts the intended service", () => {
    expect(bindingReturnTarget(service, "https://auth.cqu.moe")).toBe(service);
  });

  it("identifies only a binding route with a valid nested Schedule target", () => {
    expect(isScheduleBindingContinuation(binding, "https://auth.cqu.moe")).toBe(true);
    expect(isScheduleBindingContinuation(service, "https://auth.cqu.moe")).toBe(false);
    expect(isScheduleBindingContinuation(
      `/oauth/authorize?redirect=${encodeURIComponent(service)}`,
      "https://auth.cqu.moe",
    )).toBe(false);
    expect(isScheduleBindingContinuation(
      withRedirectParam("/cqu/bind", "https://docs.cqu.moe/"),
      "https://auth.cqu.moe",
    )).toBe(false);
    expect(isScheduleBindingContinuation(
      withRedirectParam("/cqu/bind", "https://evil.example/"),
      "https://auth.cqu.moe",
    )).toBe(false);
  });
});
