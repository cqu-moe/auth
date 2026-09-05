import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import EmailChangeFlow, { NewEmailOtpDeliveryNotice } from "./EmailChangeFlow";

describe("email change OTP flow", () => {
  it("does not claim an occupied new mailbox received an OTP and keeps the restart route", () => {
    const deliveryHtml = renderToStaticMarkup(
      createElement(NewEmailOtpDeliveryNotice, {
        newEmail: "occupied@example.com",
        cooldown: 60,
        onRestart: () => undefined,
      })
    );
    const restartHtml = renderToStaticMarkup(
      createElement(NewEmailOtpDeliveryNotice, {
        newEmail: "occupied@example.com",
        cooldown: 0,
        onRestart: () => undefined,
      })
    );

    expect(deliveryHtml).toContain("若该地址可用，验证码已发送至 occupied@example.com");
    expect(deliveryHtml).not.toContain("已向 occupied@example.com 发送验证码");
    expect(restartHtml).toContain("重新验证当前邮箱");
  });

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
