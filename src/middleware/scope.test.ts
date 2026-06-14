import { describe, it, expect } from "vitest";
import { scopeSatisfies } from "./scope";

describe("scopeSatisfies", () => {
  it("精确匹配同名 scope → true", () => {
    expect(scopeSatisfies(["cqu:ticket:jwxt"], "cqu:ticket:jwxt")).toBe(true);
  });

  it("通配 cqu:ticket:* 满足符号 key", () => {
    expect(scopeSatisfies(["cqu:ticket:*"], "cqu:ticket:jwxt")).toBe(true);
  });

  it("通配 cqu:ticket:* 满足 any", () => {
    expect(scopeSatisfies(["cqu:ticket:*"], "cqu:ticket:any")).toBe(true);
  });

  it("any 精确匹配 any → true", () => {
    expect(scopeSatisfies(["cqu:ticket:any"], "cqu:ticket:any")).toBe(true);
  });

  it("any 不授予符号 key（最小权限）→ false", () => {
    expect(scopeSatisfies(["cqu:ticket:any"], "cqu:ticket:jwxt")).toBe(false);
  });

  it("符号 key 不授予 any → false", () => {
    expect(scopeSatisfies(["cqu:ticket:jwxt"], "cqu:ticket:any")).toBe(false);
  });

  it("空 scope 集 → false", () => {
    expect(scopeSatisfies([], "cqu:ticket:jwxt")).toBe(false);
  });
});
