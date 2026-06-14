import { describe, it, expect } from "vitest";
// 从纯模块导入(rpc.ts 会 import cloudflare:workers,Node-pool vitest 解析不了)。
// rpc.ts 也 re-export 此函数,生产代码一处定义、两处可用。
import { requiredScopeForTarget } from "./services/required-scope";

describe("requiredScopeForTarget", () => {
  it("serviceUrl → cqu:ticket:any (广路径)", () => {
    expect(
      requiredScopeForTarget({ serviceUrl: "https://my.cqu.edu.cn/x" })
    ).toEqual({ required: "cqu:ticket:any" });
  });

  it("service jwxt → cqu:ticket:jwxt (符号 key)", () => {
    expect(requiredScopeForTarget({ service: "jwxt" })).toEqual({
      required: "cqu:ticket:jwxt",
    });
  });

  it("serviceUrl 优先于 service", () => {
    expect(
      requiredScopeForTarget({
        service: "jwxt",
        serviceUrl: "https://my.cqu.edu.cn/x",
      })
    ).toEqual({ required: "cqu:ticket:any" });
  });

  it("两者皆缺 → error", () => {
    expect(requiredScopeForTarget({})).toEqual({ error: "MISSING_TARGET" });
  });

  it("空字符串视为缺省 → error", () => {
    expect(
      requiredScopeForTarget({ service: "", serviceUrl: "" })
    ).toEqual({ error: "MISSING_TARGET" });
  });
});
