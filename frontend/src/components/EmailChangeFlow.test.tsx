// @vitest-environment jsdom
import { installPassingTurnstile } from "../lib/turnstile.testbots";
import type { TurnstileOptions } from "../lib/turnstile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { click, cleanupUi, renderUi, setInputValue, settleUi } from "../lib/api/quicklogin.testbots";
import EmailChangeFlow, { NewEmailOtpDeliveryNotice } from "./EmailChangeFlow";

const authClient = vi.hoisted(() => ({
  emailOtp: {
    sendVerificationOtp: vi.fn(),
    checkVerificationOtp: vi.fn(),
  },
}));
vi.mock("../lib/auth-client", () => ({ authClient }));

beforeEach(installPassingTurnstile);

afterEach(async () => {
  await cleanupUi();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
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

  it("keeps current-email OTP verification independent of a waiting resend", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let renderCount = 0;
    let pendingTurnstile: TurnstileOptions | undefined;
    vi.stubGlobal("turnstile", {
      ready: (ready: () => void) => ready(),
      render: (_container: HTMLElement, options: TurnstileOptions) => {
        renderCount += 1;
        if (renderCount === 1) queueMicrotask(() => options.callback("first-token"));
        else pendingTurnstile = options;
        return String(renderCount);
      },
      remove: () => undefined,
    });
    authClient.emailOtp.sendVerificationOtp.mockResolvedValue({ error: null });
    authClient.emailOtp.checkVerificationOtp.mockReturnValue(new Promise(() => undefined));
    try {
      const container = await renderUi(createElement(
        MemoryRouter,
        { initialEntries: ["/settings/email"] },
        createElement(EmailChangeFlow, {
          currentEmail: "old@example.com",
          onSessionRefresh: async () => undefined,
        })
      ));
      const buttonWith = (text: string) =>
        Array.from(container.querySelectorAll("button"))
          .find(button => button.textContent?.includes(text))!;

      await click(buttonWith("发送验证码"));
      expect(authClient.emailOtp.sendVerificationOtp).toHaveBeenCalledTimes(1);
      await act(async () => {
        vi.advanceTimersByTime(60_000);
        await Promise.resolve();
      });

      await click(buttonWith("重新发送验证码"));
      expect(authClient.emailOtp.sendVerificationOtp).toHaveBeenCalledTimes(1);
      const verifyButton = buttonWith("验证并继续");
      expect(verifyButton.getAttribute("aria-disabled")).not.toBe("true");

      await setInputValue(container.querySelector("input")!, "123456");
      await click(verifyButton);
      pendingTurnstile?.callback("late-token");
      await settleUi();

      expect(authClient.emailOtp.sendVerificationOtp).toHaveBeenCalledTimes(1);
      expect(authClient.emailOtp.checkVerificationOtp).toHaveBeenCalledTimes(1);
      expect(verifyButton.getAttribute("aria-busy")).toBe("true");
    } finally {
      vi.useRealTimers();
    }
  });
});
