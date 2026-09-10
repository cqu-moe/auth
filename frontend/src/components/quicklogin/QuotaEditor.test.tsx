import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import QuotaEditor, { PREVIEW_CHANGED_MESSAGE } from "./QuotaEditor";

describe("quicklogin quota editor", () => {
  it("starts with a labeled non-negative integer input and preview action", () => {
    const html = renderToStaticMarkup(createElement(QuotaEditor, {
      userId: "synthetic-user", onSaved: () => undefined,
    }));
    expect(html).toContain("设备数");
    expect(html).toContain('type="number"');
    expect(html).toContain('min="0"');
    expect(html).toContain("预览调整");
    expect(html).not.toContain("确认保存额度");
  });

  it("requires a second explicit confirmation when the preview changes", () => {
    expect(PREVIEW_CHANGED_MESSAGE).toBe("设备状态已变化，请确认最新名单");
  });
});
