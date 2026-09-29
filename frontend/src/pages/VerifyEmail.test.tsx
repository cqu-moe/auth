import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@cqu-moe/ui";
import { describe, expect, it, vi } from "vitest";
import VerifyEmail from "./VerifyEmail";

// ThemeProvider 监听系统主题偏好，node/jsdom 测试环境没有 matchMedia。
vi.stubGlobal("matchMedia", (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => undefined,
  removeListener: () => undefined,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => false,
}));

describe("email verification page", () => {
  it("renders a six-digit OTP form without mailbox-link instructions", () => {
    const html = renderToStaticMarkup(
      createElement(
        ThemeProvider,
        null,
        createElement(
          MemoryRouter,
          { initialEntries: ["/verify-email?redirect=%2Fsettings"] },
          createElement(VerifyEmail)
        )
      )
    );

    expect(html).toContain("六位验证码");
    expect(html).toContain("输入邮箱验证码");
    expect(html).toContain("验证并继续");
    expect(html).toContain("重新发送验证码");
    expect(html).toContain('inputMode="numeric"');
    expect(html).toContain('autoComplete="one-time-code"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain("点击邮件中的链接");
    expect(html).not.toContain("重新发送验证邮件");
  });
});
