// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { click, cleanupUi, renderUi } from "../lib/api/quicklogin.testbots";
import EmailChangeFlow, { NewEmailOtpDeliveryNotice } from "./EmailChangeFlow";

const authClient = vi.hoisted(() => ({
  emailOtp: {
    sendVerificationOtp: vi.fn(),
  },
}));
vi.mock("../lib/auth-client", () => ({ authClient }));

afterEach(async () => {
  await cleanupUi();
  vi.clearAllMocks();
});

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

  it("recovers the send action after a network exception", async () => {
    authClient.emailOtp.sendVerificationOtp.mockRejectedValueOnce(new Error("offline"));
    const container = await renderUi(createElement(
      MemoryRouter,
      { initialEntries: ["/settings/email"] },
      createElement(EmailChangeFlow, {
        currentEmail: "old@example.com",
        onSessionRefresh: async () => undefined,
      })
    ));

    await click(Array.from(container.querySelectorAll("button"))
      .find(button => button.textContent?.includes("发送验证码"))!);

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("网络错误");
    const retry = Array.from(container.querySelectorAll("button"))
      .find(button => button.textContent?.includes("发送验证码"))!;
    expect(retry.getAttribute("aria-disabled")).not.toBe("true");
  });
});
