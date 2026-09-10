import { describe, expect, it } from "vitest";
import {
  isExternalHttpTarget,
  postLoginRedirectFromSearch,
  sanitizePostLoginRedirect,
  withRedirectParam,
} from "./post-login-redirect";

// better-auth's allowRelativePaths trust check (trusted-origins.mjs):
// a relative callbackURL's query may only contain [\w\-.+/=&%@].
const betterAuthRelativeCallbackPattern =
  /^\/(?!\/|\\|%2f|%5c)[\w\-.+/@]*(?:\?[\w\-.+/=&%@]*)?$/;

describe("sanitizePostLoginRedirect", () => {
  it("accepts cqu.moe apps and loopback dev servers", () => {
    expect(sanitizePostLoginRedirect("https://schedule.cqu.moe/dashboard")).toBe(
      "https://schedule.cqu.moe/dashboard"
    );
    expect(sanitizePostLoginRedirect("https://cqu.moe/")).toBe("https://cqu.moe/");
    expect(sanitizePostLoginRedirect("http://localhost:5173/add?x=1")).toBe(
      "http://localhost:5173/add?x=1"
    );
  });

  it("accepts same-app relative paths", () => {
    expect(sanitizePostLoginRedirect("/settings")).toBe("/settings");
    expect(sanitizePostLoginRedirect("/cqu/bind?next=1")).toBe("/cqu/bind?next=1");
  });

  it("rejects open-redirect vectors", () => {
    for (const candidate of [
      "https://evil.com",
      "https://cqu.moe.evil.com/",
      "https://evil-cqu.moe",
      "https://cqu.moe@evil.com/",
      "https://evil@schedule.cqu.moe/",
      "//evil.com",
      "/\\evil.com",
      "/settings\nnext",
      "https://schedule.cqu.moe/dashboard\\next",
      "javascript:alert(1)",
      "data:text/html,hi",
      "dashboard",
      "",
      null,
      undefined,
    ]) {
      expect(sanitizePostLoginRedirect(candidate)).toBeNull();
    }
  });
});

describe("postLoginRedirectFromSearch", () => {
  it("extracts and sanitizes the redirect parameter", () => {
    expect(
      postLoginRedirectFromSearch("?redirect=https%3A%2F%2Fschedule.cqu.moe%2F")
    ).toBe("https://schedule.cqu.moe/");
    expect(postLoginRedirectFromSearch("?redirect=https%3A%2F%2Fevil.com%2F")).toBeNull();
    expect(postLoginRedirectFromSearch("")).toBeNull();
    expect(postLoginRedirectFromSearch("?code=ABCD1234")).toBeNull();
  });
});

describe("withRedirectParam", () => {
  it("strictly encodes values that better-auth relative callback URLs accept", () => {
    const target = "https://schedule.cqu.moe/订阅?title=Hi!~*'()";
    const callbackURL = withRedirectParam("/verify-email?mode=otp", target);

    expect(callbackURL).toMatch(
      /^\/verify-email\?mode=otp&redirect=[\w\-.%]+$/
    );
    expect(callbackURL).toMatch(betterAuthRelativeCallbackPattern);
  });

  it("joins onto an existing query and preserves the target verbatim when decoded", () => {
    const callbackURL = withRedirectParam(
      "/verify-email?mode=otp",
      "https://schedule.cqu.moe/dashboard"
    );
    expect(callbackURL).toBe(
      "/verify-email?mode=otp&redirect=https%3A%2F%2Fschedule.cqu.moe%2Fdashboard"
    );
    expect(
      new URLSearchParams(callbackURL.split("?")[1]).get("redirect")
    ).toBe("https://schedule.cqu.moe/dashboard");
  });

  it("returns the path unchanged without a target", () => {
    expect(withRedirectParam("/register", null)).toBe("/register");
    expect(withRedirectParam("/login", undefined)).toBe("/login");
  });
});

describe("isExternalHttpTarget", () => {
  it("distinguishes full URLs from in-app paths", () => {
    expect(isExternalHttpTarget("https://schedule.cqu.moe/")).toBe(true);
    expect(isExternalHttpTarget("http://localhost:5173/")).toBe(true);
    expect(isExternalHttpTarget("/settings")).toBe(false);
  });
});
