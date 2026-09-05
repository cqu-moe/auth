import { describe, expect, it } from "vitest";
import {
  availableSecondFactorMethods,
  createBackupCodesDownload,
  mapAuthError,
  normalizeOtp,
  type SecondFactorMethod,
} from "./two-factor";

describe("two-factor helpers", () => {
  it("reserves passkey without exposing it as an available method", () => {
    const future: SecondFactorMethod = "passkey";

    expect(future).toBe("passkey");
    expect(availableSecondFactorMethods).toEqual(["totp", "email-otp", "backup-code"]);
  });

  it("normalizes six-digit codes", () => {
    expect(normalizeOtp(" 12 34-56 ")).toBe("123456");
  });

  it("builds a dated UTF-8 text download containing every backup code", () => {
    expect(createBackupCodesDownload(
      ["recovery-alpha", "recovery-beta"],
      new Date(2026, 8, 5)
    )).toEqual({
      filename: "cqu-moe-recovery-codes-2026-09-05.txt",
      content: [
        "CQU MOE 账户备用恢复码",
        "生成日期：2026-09-05",
        "",
        "请妥善保管此文件。每个恢复码只能使用一次。",
        "",
        "recovery-alpha",
        "recovery-beta",
        "",
      ].join("\n"),
    });
  });

  it("maps invalid, expired, attempt-limit, backup-code, and rate-limit errors", () => {
    expect(mapAuthError("INVALID_CODE", "验证失败")).toBe("验证码不正确");
    expect(mapAuthError("INVALID_OTP", "验证失败")).toBe("验证码不正确");
    expect(mapAuthError("OTP_HAS_EXPIRED", "验证失败")).toBe("验证码已过期，请重新获取");
    expect(mapAuthError("TOO_MANY_ATTEMPTS", "验证失败")).toBe("尝试次数过多，请重新获取验证码");
    expect(mapAuthError("INVALID_BACKUP_CODE", "验证失败")).toBe("备用恢复码无效或已使用");
    expect(mapAuthError("RATE_LIMITED", "验证失败")).toBe("操作过于频繁，请稍后重试");
  });
});
