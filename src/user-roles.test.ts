import { describe, expect, it } from "vitest";
import { canAccessAdmin, USER_ROLE_OPTIONS } from "./user-roles";

describe("user role presentation", () => {
  it("displays superAdmin as a super administrator", () => {
    expect(USER_ROLE_OPTIONS.find(({ value }) => value === "superAdmin"))
      .toEqual({ value: "superAdmin", label: "超级管理员" });
  });

  it("allows superAdmin to access administrator navigation", () => {
    expect(canAccessAdmin("superAdmin")).toBe(true);
  });
});
