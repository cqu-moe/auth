import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import SecuritySection from "./SecuritySection";

function render(enabled: boolean) {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: ["/settings"] },
      createElement(SecuritySection, { twoFactorEnabled: enabled })
    )
  );
}

describe("security settings section", () => {
  it("shows an unconfigured account and points to the dedicated settings page", () => {
    const html = render(false);

    expect(html).toContain("二次验证");
    expect(html).toContain("尚未启用");
    expect(html).toContain('href="/settings/two-factor"');
  });

  it("reports an enabled account without changing the destination", () => {
    const html = render(true);

    expect(html).toContain("已启用");
    expect(html).toContain('href="/settings/two-factor"');
  });

  it("keeps the password editor collapsed until requested", () => {
    const html = render(true);

    expect(html).toContain('aria-label="修改密码"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('id="change-password-form"');
  });
});
