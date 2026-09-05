import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import TwoFactorSettingsSection from "./TwoFactorSettingsSection";

describe("two-factor settings summary", () => {
  it("shows an unconfigured account and points to the dedicated settings page", () => {
    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: ["/settings"] },
        createElement(TwoFactorSettingsSection, { enabled: false })
      )
    );

    expect(html).toContain("二次验证");
    expect(html).toContain("尚未启用");
    expect(html).toContain('href="/settings/two-factor"');
  });

  it("reports an enabled account without changing the destination", () => {
    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: ["/settings"] },
        createElement(TwoFactorSettingsSection, { enabled: true })
      )
    );

    expect(html).toContain("已启用");
    expect(html).toContain('href="/settings/two-factor"');
  });
});
