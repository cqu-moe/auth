import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import AccountProfileSection, {
  AccountEmailChangeSection,
} from "./AccountProfileSection";

function renderWithRouter(element: ReturnType<typeof createElement>) {
  return renderToStaticMarkup(
    createElement(MemoryRouter, { initialEntries: ["/settings"] }, element)
  );
}

describe("account profile settings", () => {
  it("keeps the settings card as a compact summary with edit actions", () => {
    const html = renderWithRouter(
      createElement(AccountProfileSection, {
        name: "现有昵称",
        email: "old@example.com",
        onSessionRefresh: async () => undefined,
      })
    );

    expect(html).toContain("个人信息");
    expect(html).toContain("现有昵称");
    expect(html).toContain("old@example.com");
    expect(html).toContain('aria-label="修改昵称"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('href="/settings/email"');
    expect(html).toContain('aria-label="修改邮箱"');
    expect(html).not.toContain('id="displayName"');
    expect(html).not.toContain("请输入新邮箱");
    expect(html).not.toContain("旧邮箱确认");
  });

  it("puts the two-step email flow in its own section", () => {
    const html = renderWithRouter(
      createElement(AccountEmailChangeSection, {
        email: "old@example.com",
        emailFlowReturned: true,
      })
    );

    expect(html).toContain("修改登录邮箱");
    expect(html).toContain('href="/settings"');
    expect(html).toContain("old@example.com");
    expect(html).toContain("旧邮箱确认");
    expect(html).toContain("新邮箱确认");
    expect(html).toContain("请输入新邮箱");
    expect(html).toContain("确认操作已处理");
  });
});
