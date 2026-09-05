import { describe, expect, it } from "vitest";
import { validateDisplayName, validateNewEmail } from "./account-settings";

describe("account settings validation", () => {
  it("trims a valid nickname before saving", () => {
    expect(validateDisplayName("  重庆大学生  ")).toEqual({
      value: "重庆大学生",
      error: null,
    });
  });

  it("rejects empty and overlong nicknames", () => {
    expect(validateDisplayName("   ")).toEqual({
      value: null,
      error: "请输入昵称",
    });
    expect(validateDisplayName("a".repeat(65))).toEqual({
      value: null,
      error: "昵称不能超过 64 个字符",
    });
  });

  it("normalizes a new email and rejects the current address", () => {
    expect(validateNewEmail("old@example.com", "  NEW@Example.com ")).toEqual({
      value: "new@example.com",
      error: null,
    });
    expect(validateNewEmail("User@Example.com", " user@example.com ")).toEqual({
      value: null,
      error: "新邮箱不能与当前邮箱相同",
    });
  });
});
