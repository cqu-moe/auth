import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import EmailChangeFlow from "./EmailChangeFlow";

describe("email change OTP flow", () => {
  it("starts a native three-stage verification flow without mailbox links", () => {
    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: ["/settings/email"] },
        createElement(EmailChangeFlow, {
          currentEmail: "old@example.com",
          onSessionRefresh: async () => undefined,
        })
      )
    );

    expect(html).toContain("验证当前邮箱");
    expect(html).toContain("输入新邮箱");
    expect(html).toContain("验证新邮箱");
    expect(html).toContain("发送验证码");
    expect(html).not.toContain("点击链接");
    expect(html).not.toContain("确认邮件");
  });
});
