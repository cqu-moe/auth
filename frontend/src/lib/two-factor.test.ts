import { describe, expect, it } from "vitest";
import {
  availableSecondFactorMethods,
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

  it("maps invalid, expired, attempt-limit, backup-code, and rate-limit errors", () => {
    expect(mapAuthError("INVALID_CODE", "验证失败")).toBe("验证码不正确");
    expect(mapAuthError("INVALID_OTP", "验证失败")).toBe("验证码不正确");
    expect(mapAuthError("OTP_HAS_EXPIRED", "验证失败")).toBe("验证码已过期，请重新获取");
    expect(mapAuthError("TOO_MANY_ATTEMPTS", "验证失败")).toBe("尝试次数过多，请重新获取验证码");
    expect(mapAuthError("INVALID_BACKUP_CODE", "验证失败")).toBe("备用恢复码无效或已使用");
    expect(mapAuthError("RATE_LIMITED", "验证失败")).toBe("操作过于频繁，请稍后重试");
  });
});
