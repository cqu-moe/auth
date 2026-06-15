import { describe, it, expect } from "vitest";
import { capsToView } from "./caps";

describe("capsToView", () => {
  it("flag true -> 已开通", () => {
    const v = capsToView({ calendar: { sync: true } }, "calendar");
    expect(v.find((c) => c.key === "sync")?.display).toBe("已开通");
  });
  it("flag false/缺省 -> 未开通", () => {
    const v = capsToView({ calendar: {} }, "calendar");
    expect(v.find((c) => c.key === "sync")?.display).toBe("未开通");
  });
  it("quota number -> 值 + 单位", () => {
    const v = capsToView({ calendar: { sub_limit: 50 } }, "calendar");
    expect(v.find((c) => c.key === "sub_limit")?.display).toBe("50 条");
  });
  it("quota null/缺省 -> 无限", () => {
    const v = capsToView({ calendar: { sub_limit: null } }, "calendar");
    expect(v.find((c) => c.key === "sub_limit")?.display).toBe("无限");
  });
  it("caps 整体缺失 -> 全部安全降级（flag 未开通 / quota 无限）", () => {
    const v = capsToView(undefined, "calendar");
    expect(v.every((c) => c.display === "未开通" || c.display === "无限")).toBe(true);
  });
});
