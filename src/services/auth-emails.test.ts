import { describe, expect, it } from "vitest";
import {
  renderEmailChangeEmail,
  renderPasswordResetEmail,
  renderVerificationEmail,
} from "./auth-emails";
import { extractEmailSecrets } from "../../e2e/runtime.mjs";

describe("auth email rendering", () => {
  it.each([
    ["verification", renderVerificationEmail("123456"), "验证你的邮箱", "123456"],
    ["email change", renderEmailChangeEmail("654321"), "验证新登录邮箱", "654321"],
  ])("renders the %s email in HTML and text", (_name, email, title, otp) => {
    expect(email.subject).toBe(`${title} - CQU Auth`);
    expect(email.html).toContain('src="https://auth.cqu.moe/brand/icon-192.png" width="32" height="32" alt="CQU Auth"');
    expect(email.html).toContain("验证码 5 分钟内有效");
    expect(email.text).toContain(`${title}\n\n`);
    expect(email.text).toContain(`\n\n${otp}\n\n`);
  });

  it("renders the password reset email without inventing an expiry", () => {
    const url = "https://auth.cqu.moe/reset/password?token=abc";
    const email = renderPasswordResetEmail(url);

    expect(email.subject).toBe("重置密码 - CQU Auth");
    expect(email.html).toContain(`href="${url}"`);
    expect(email.html).not.toMatch(/有效期|过期/);
    expect(email.text).toContain(url);
    expect(email.text).not.toMatch(/有效期|过期/);
  });

  it("extracts email secrets from plain-text payloads", () => {
    const resetUrl = "https://auth.cqu.moe/reset-password/token?callbackURL=%2Fsettings";
    expect(extractEmailSecrets({ text: renderVerificationEmail("123456").text })).toEqual({
      otp: "123456",
      resetUrl: undefined,
    });
    expect(extractEmailSecrets({ text: renderPasswordResetEmail(resetUrl).text })).toEqual({
      otp: undefined,
      resetUrl,
    });
  });
});
