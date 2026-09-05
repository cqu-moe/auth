import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import TwoFactorChallenge from "./TwoFactorChallenge";
import {
  getLoginChallengeError,
  loginChallengeMethods,
  sendLoginChallengeOtp,
  verifyLoginChallenge,
} from "../lib/two-factor-challenge";

describe("two-factor login challenge", () => {
  it("renders the supported challenge controls without passkey", () => {
    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: ["/two-factor"] },
        createElement(TwoFactorChallenge)
      )
    );

    expect(html).toContain("二次验证");
    expect(html).toContain("身份验证器");
    expect(html).toContain("邮箱验证码");
    expect(html).toContain("备用恢复码");
    expect(html).toContain("在这台设备上保持信任 30 天");
    expect(html).not.toContain("Passkey");
    expect(loginChallengeMethods.map((method) => method.value)).toEqual([
      "totp",
      "email-otp",
      "backup-code",
    ]);
  });

  it("dispatches every verification method through its native client action with trust", async () => {
    const actions = {
      verifyTotp: vi.fn(async (input: { code: string; trustDevice: boolean }) => ({ data: input, error: null })),
      verifyOtp: vi.fn(async (input: { code: string; trustDevice: boolean }) => ({ data: input, error: null })),
      verifyBackupCode: vi.fn(async (input: { code: string; trustDevice: boolean }) => ({ data: input, error: null })),
      sendOtp: vi.fn(async () => ({ data: null, error: null })),
    };

    await verifyLoginChallenge(actions, "totp", "123456", true);
    await verifyLoginChallenge(actions, "email-otp", "234567", true);
    await verifyLoginChallenge(actions, "backup-code", "recovery-code", true);

    expect(actions.verifyTotp).toHaveBeenCalledWith({ code: "123456", trustDevice: true });
    expect(actions.verifyOtp).toHaveBeenCalledWith({ code: "234567", trustDevice: true });
    expect(actions.verifyBackupCode).toHaveBeenCalledWith({ code: "recovery-code", trustDevice: true });
  });

  it("sends email OTPs natively and leaves success distinguishable from failure", async () => {
    const sendOtp = vi.fn(async (input: { fetchOptions: { body: { trustDevice: boolean } } }) => ({
      data: input,
      error: null,
    }));
    const sent = await sendLoginChallengeOtp(
      {
        verifyTotp: async () => ({ data: null, error: null }),
        verifyOtp: async () => ({ data: null, error: null }),
        verifyBackupCode: async () => ({ data: null, error: null }),
        sendOtp,
      },
      true
    );
    const failed = await sendLoginChallengeOtp(
      {
        verifyTotp: async () => ({ data: null, error: null }),
        verifyOtp: async () => ({ data: null, error: null }),
        verifyBackupCode: async () => ({ data: null, error: null }),
        sendOtp: vi.fn(async () => ({ data: null, error: { code: "RATE_LIMITED" } })),
      },
      false
    );

    expect(sent).toEqual({
      data: { fetchOptions: { body: { trustDevice: true } } },
      error: null,
    });
    expect(sendOtp).toHaveBeenCalledWith({ fetchOptions: { body: { trustDevice: true } } });
    expect(failed.error?.code).toBe("RATE_LIMITED");
  });

  it("maps native challenge errors including expired sessions", () => {
    expect(getLoginChallengeError({ code: "INVALID_CODE" }, "验证失败")).toEqual({
      message: "验证码不正确",
      expired: false,
    });
    expect(getLoginChallengeError({ code: "OTP_HAS_EXPIRED" }, "验证失败")).toEqual({
      message: "验证码已过期，请重新获取",
      expired: false,
    });
    expect(getLoginChallengeError({ code: "RATE_LIMITED" }, "验证失败")).toEqual({
      message: "操作过于频繁，请稍后重试",
      expired: false,
    });
    expect(getLoginChallengeError({ code: "INVALID_TWO_FACTOR_COOKIE" }, "验证失败")).toEqual({
      message: "验证会话已过期，请重新登录",
      expired: true,
    });
  });
});
