// @vitest-environment jsdom
import { act, createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@cqu-moe/ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { click, cleanupUi, renderUi, setInputValue, settleUi } from "../lib/api/quicklogin.testbots";
import type { TurnstileOptions } from "../lib/turnstile";
import VerifyEmail from "./VerifyEmail";

const authClient = vi.hoisted(() => ({
  useSession: vi.fn(() => ({
    data: { user: { email: "user@example.com" } },
    refetch: vi.fn(async () => undefined),
  })),
  emailOtp: {
    verifyEmail: vi.fn(),
    sendVerificationOtp: vi.fn(),
  },
  signOut: vi.fn(async () => undefined),
}));
const completeEmailVerification = vi.hoisted(() => vi.fn());
vi.mock("../lib/auth-client", () => ({ authClient }));
vi.mock("../lib/email-verification-flow", () => ({ completeEmailVerification }));

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

afterEach(async () => {
  await cleanupUi();
  vi.clearAllMocks();
});

describe("email verification behavior", () => {
  it("suppresses same-tick retries and recovers after a network exception", async () => {
    let rejectVerification: ((error: Error) => void) | undefined;
    completeEmailVerification.mockReturnValue(new Promise<never>((_, reject) => {
      rejectVerification = reject;
    }));
    const container = await renderUi(createElement(
      ThemeProvider,
      null,
      createElement(
        MemoryRouter,
        { initialEntries: ["/verify-email"] },
        createElement(VerifyEmail)
      )
    ));
    const form = container.querySelector("form")!;

    await setInputValue(container.querySelector("input")!, "123456");
    await act(async () => {
      form.requestSubmit();
      form.requestSubmit();
    });
    await settleUi();

    expect(completeEmailVerification).toHaveBeenCalledTimes(1);
    expect(form.getAttribute("aria-busy")).toBe("true");
    await act(async () => rejectVerification?.(new Error("offline")));
    await settleUi();

    expect(completeEmailVerification).toHaveBeenCalledTimes(1);
    expect(form.getAttribute("aria-busy")).toBe("false");
    expect(container.querySelector("input")?.disabled).toBe(false);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("网络错误");
  });

  it("lets an existing OTP proceed while a resend waits for Turnstile", async () => {
    let pendingTurnstile: TurnstileOptions | undefined;
    vi.stubGlobal("turnstile", {
      ready: (ready: () => void) => ready(),
      render: (_container: HTMLElement, options: TurnstileOptions) => {
        pendingTurnstile = options;
        return "pending";
      },
      remove: () => undefined,
    });
    completeEmailVerification.mockReturnValue(new Promise(() => undefined));
    authClient.emailOtp.sendVerificationOtp.mockResolvedValue({ error: null });
    const container = await renderUi(createElement(
      ThemeProvider,
      null,
      createElement(
        MemoryRouter,
        { initialEntries: ["/verify-email"] },
        createElement(VerifyEmail)
      )
    ));
    const buttonWith = (text: string) =>
      Array.from(container.querySelectorAll("button"))
        .find(button => button.textContent?.includes(text))!;

    await click(buttonWith("重新发送验证码"));
    expect(authClient.emailOtp.sendVerificationOtp).not.toHaveBeenCalled();
    expect(buttonWith("验证并继续").getAttribute("aria-disabled")).not.toBe("true");

    await setInputValue(container.querySelector("input")!, "123456");
    await click(buttonWith("验证并继续"));
    pendingTurnstile?.callback("late-token");
    await settleUi();

    expect(authClient.emailOtp.sendVerificationOtp).not.toHaveBeenCalled();
    expect(completeEmailVerification).toHaveBeenCalledTimes(1);
    expect(container.querySelector("form")?.getAttribute("aria-busy")).toBe("true");
  });
});
