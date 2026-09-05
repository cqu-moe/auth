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

  it("maps verification and rate-limit errors to clear messages", () => {
    expect(mapAuthError("INVALID_CODE", "验证失败")).toBe("验证码不正确");
    expect(mapAuthError("RATE_LIMITED", "验证失败")).toBe("操作过于频繁，请稍后重试");
  });
});
