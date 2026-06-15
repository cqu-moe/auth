import { describe, it, expect } from "vitest";
import { pickSearchField } from "./admin-search";

describe("pickSearchField", () => {
  it("含 @ -> email", () =>
    expect(pickSearchField("a@b.com")).toEqual({ searchField: "email", searchValue: "a@b.com", searchOperator: "contains" }));
  it("无 @ -> name", () =>
    expect(pickSearchField("张三")).toEqual({ searchField: "name", searchValue: "张三", searchOperator: "contains" }));
  it("首尾空白被 trim", () =>
    expect(pickSearchField("  bob ")?.searchValue).toBe("bob"));
  it("空/纯空白 -> null", () => {
    expect(pickSearchField("")).toBeNull();
    expect(pickSearchField("   ")).toBeNull();
  });
});
