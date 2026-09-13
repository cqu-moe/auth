import { describe, it, expect } from "vitest";
import {
  validateCquHarvestUrl,
  validateCquHarvestRecipeHosts,
  isCquHarvestUrl,
} from "./harvest-url";

describe("validateCquHarvestUrl", () => {
  it("accepts my.cqu.edu.cn https and returns canonical href", () => {
    expect(validateCquHarvestUrl("https://my.cqu.edu.cn/workspace/curriculum"))
      .toBe("https://my.cqu.edu.cn/workspace/curriculum");
  });
  it("lowercases host", () => {
    expect(validateCquHarvestUrl("https://MY.CQU.EDU.CN/x")).toBe("https://my.cqu.edu.cn/x");
  });
  it("rejects the retired aTrust rewritten app host", () => {
    expect(() =>
      validateCquHarvestUrl(
        "https://my-cqu-edu-cn-s.atrust.cqu.edu.cn/workspace/curriculum"
      )
    ).toThrow("host not allowed");
  });
  it("rejects other cqu subdomain (only my.cqu.edu.cn)", () => {
    expect(() => validateCquHarvestUrl("https://lib.cqu.edu.cn/x")).toThrow();
    expect(() => validateCquHarvestUrl("https://sso.cqu.edu.cn/login")).toThrow();
  });
  it("rejects apex cqu.edu.cn", () => {
    expect(() => validateCquHarvestUrl("https://cqu.edu.cn/x")).toThrow();
  });
  it("rejects suffix trick", () => {
    expect(() => validateCquHarvestUrl("https://my.cqu.edu.cn.evil.com/x")).toThrow();
  });
  it("rejects http / userinfo / port / backslash / non-ascii", () => {
    expect(() => validateCquHarvestUrl("http://my.cqu.edu.cn/x")).toThrow();
    expect(() => validateCquHarvestUrl("https://u:p@my.cqu.edu.cn/x")).toThrow();
    expect(() => validateCquHarvestUrl("https://my.cqu.edu.cn:8443/x")).toThrow();
    expect(() => validateCquHarvestUrl("https://my.cqu.edu.cn\\@evil.com/x")).toThrow();
    expect(() => validateCquHarvestUrl("https://my．cqu.edu.cn/x")).toThrow();
  });
});

describe("validateCquHarvestRecipeHosts", () => {
  it("returns direct when every recipe URL uses my.cqu.edu.cn", () => {
    expect(
      validateCquHarvestRecipeHosts(
        "https://my.cqu.edu.cn/workspace/curriculum",
        ["https://my.cqu.edu.cn/api/exam/x"]
      )
    ).toBe("direct");
  });

  it("rejects a recipe containing the retired aTrust host", () => {
    expect(() =>
      validateCquHarvestRecipeHosts(
        "https://my-cqu-edu-cn-s.atrust.cqu.edu.cn/workspace/curriculum",
        ["https://my.cqu.edu.cn/api/exam/x"]
      )
    ).toThrow("host not allowed");
  });
});

describe("isCquHarvestUrl (non-throwing predicate)", () => {
  it("true for my.cqu.edu.cn", () => {
    expect(isCquHarvestUrl("https://my.cqu.edu.cn/x")).toBe(true);
  });
  it("false for the retired aTrust app host", () => {
    expect(
      isCquHarvestUrl("https://my-cqu-edu-cn-s.atrust.cqu.edu.cn/x")
    ).toBe(false);
  });
  it("false for disallowed / garbage", () => {
    expect(isCquHarvestUrl("https://evil.com/x")).toBe(false);
    expect(isCquHarvestUrl("@@bad@@")).toBe(false);
  });
});
