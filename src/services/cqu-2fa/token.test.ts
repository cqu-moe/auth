import { describe, it, expect } from "vitest";
import { genAddressToken } from "./token";
describe("genAddressToken", () => {
  it("returns 16-char url-safe lowercase, unique", () => {
    const a = genAddressToken(),
      b = genAddressToken();
    expect(a).toMatch(/^[a-z0-9]{16}$/); // 邮箱地址友好：纯小写字母数字
    expect(a).not.toBe(b);
  });
});
