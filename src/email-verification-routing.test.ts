import { describe, expect, it } from "vitest";
import {
  getEmailVerificationRedirect,
  getPostAuthDestination,
  getVerificationLinkErrorMessage,
} from "../frontend/src/lib/email-verification-routing";

describe("email verification routing", () => {
  it("forces a signed-in unverified user onto the verification page from every app route", () => {
    for (const pathname of ["/", "/login", "/settings", "/admin", "/oauth/authorize"]) {
      expect(
        getEmailVerificationRedirect({
          hasSession: true,
          emailVerified: false,
          pathname,
        })
      ).toBe("/verify-email");
    }
  });

  it("does not redirect an unverified user away from the verification page", () => {
    expect(
      getEmailVerificationRedirect({
        hasSession: true,
        emailVerified: false,
        pathname: "/verify-email",
      })
    ).toBeNull();
  });

  it("moves a verified user out of the verification page", () => {
    expect(
      getEmailVerificationRedirect({
        hasSession: true,
        emailVerified: true,
        pathname: "/verify-email",
      })
    ).toBe("/settings");
  });

  it("leaves signed-out visitors and verified users on their requested route", () => {
    expect(
      getEmailVerificationRedirect({
        hasSession: false,
        emailVerified: false,
        pathname: "/login",
      })
    ).toBeNull();
    expect(
      getEmailVerificationRedirect({
        hasSession: true,
        emailVerified: true,
        pathname: "/admin",
      })
    ).toBeNull();
  });

  it("sends successful registration and login to the correct account home", () => {
    expect(getPostAuthDestination(false)).toBe("/verify-email");
    expect(getPostAuthDestination(true)).toBe("/settings");
  });

  it("turns failed verification callbacks into actionable Chinese messages", () => {
    expect(getVerificationLinkErrorMessage("TOKEN_EXPIRED")).toBe(
      "验证链接已过期，请重新发送验证邮件。"
    );
    expect(getVerificationLinkErrorMessage("INVALID_TOKEN")).toBe(
      "验证链接无效，请重新发送验证邮件。"
    );
    expect(getVerificationLinkErrorMessage("UNEXPECTED_ERROR")).toBe(
      "邮箱验证失败，请重新发送验证邮件。"
    );
    expect(getVerificationLinkErrorMessage(null)).toBeNull();
  });
});
