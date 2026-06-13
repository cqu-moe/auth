import { describe, it, expect } from "vitest";
import { decodeJwtExp } from "./jwt-exp";

// 构造一个 base64url 编码的 payload(无 padding, 模拟真实 JWT)。
function makeJwt(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload);
  const b64 = btoa(json)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  // header 段内容无关紧要(decodeJwtExp 不读它), signature 段同理。
  return `eyJhbGciOiJIUzI1NiJ9.${b64}.sigsig`;
}

describe("decodeJwtExp", () => {
  it("合法 JWT 带数字 exp -> 返回该 exp", () => {
    const exp = 1_900_000_000;
    expect(decodeJwtExp(makeJwt({ sub: "u", exp }))).toBe(exp);
  });

  it("非 JWT(无点分段) -> null", () => {
    expect(decodeJwtExp("not-a-jwt")).toBeNull();
  });

  it("payload 无 exp 字段 -> null", () => {
    expect(decodeJwtExp(makeJwt({ sub: "u", iat: 123 }))).toBeNull();
  });

  it("坏 base64(payload 段非法) -> null", () => {
    // '!' 不是合法 base64url 字符, atob 抛错 -> null。
    expect(decodeJwtExp("header.!!!bad!!!.sig")).toBeNull();
  });

  it("payload 非 JSON -> null", () => {
    // 'eHh4' 是 'xxx' 的合法 base64, 但不是 JSON。
    expect(decodeJwtExp("header.eHh4.sig")).toBeNull();
  });

  it("exp 为字符串(非 NumericDate) -> null", () => {
    expect(decodeJwtExp(makeJwt({ exp: "1900000000" }))).toBeNull();
  });

  it("空字符串 -> null", () => {
    expect(decodeJwtExp("")).toBeNull();
  });

  it("payload 为 JSON 数组(非对象) -> null", () => {
    // [] 的 base64url。
    const b64 = btoa("[]").replace(/=+$/, "");
    expect(decodeJwtExp(`header.${b64}.sig`)).toBeNull();
  });

  it("exp = NaN(JSON 里以 null 表示, typeof 非 number) -> null", () => {
    expect(decodeJwtExp(makeJwt({ exp: null }))).toBeNull();
  });
});
