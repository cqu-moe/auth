// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import {
  click,
  cleanupUi,
  renderUi,
  setInputValue,
  submit,
} from "../lib/api/quicklogin.testbots";
import RecentAuthentication from "./RecentAuthentication";
import SecuritySection from "./SecuritySection";

const authClient = vi.hoisted(() => ({ changePassword: vi.fn() }));

vi.mock("../lib/auth-client", () => ({ authClient }));

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
  afterEach(async () => {
    await cleanupUi();
    authClient.changePassword.mockReset();
    vi.restoreAllMocks();
  });

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

  it("revokes other sessions when changing the password", async () => {
    authClient.changePassword.mockResolvedValue({});
    vi.spyOn(globalThis, "fetch").mockImplementation(async input => Response.json({ verified: String(input).endsWith("/challenge") }));
    const container = await renderUi(
      createElement(
        MemoryRouter,
        { initialEntries: ["/settings"] },
        createElement(SecuritySection, { twoFactorEnabled: false }),
        createElement(RecentAuthentication)
      )
    );

    await click(container.querySelector('[aria-label="修改密码"]')!);
    await setInputValue(container.querySelector<HTMLInputElement>("#currentPassword")!, "old-password");
    await setInputValue(container.querySelector<HTMLInputElement>("#newPassword")!, "new-password-123");
    await setInputValue(container.querySelector<HTMLInputElement>("#confirmNewPassword")!, "new-password-123");
    await submit(container.querySelector<HTMLFormElement>("#change-password-form")!);
    expect(authClient.changePassword).not.toHaveBeenCalled();
    await setInputValue(container.querySelector<HTMLInputElement>("#recent-password")!, "old-password");
    await submit(container.querySelector<HTMLFormElement>('[role="dialog"] form')!);

    expect(authClient.changePassword).toHaveBeenCalledWith({
      currentPassword: "old-password",
      newPassword: "new-password-123",
      revokeOtherSessions: true,
    });
  });
});
