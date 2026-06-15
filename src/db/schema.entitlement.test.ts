import { describe, it, expect } from "vitest";
import { userEntitlement } from "./schema";

// 轻量编译/导入检查：确认 userEntitlement 表已定义（schema/config 变更，TDD 配置例外）。
describe("userEntitlement schema", () => {
  it("is defined", () => {
    expect(userEntitlement).toBeDefined();
  });
});
