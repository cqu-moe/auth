import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import TwoFactorSettings, { BackupCodes } from "./TwoFactorSettings";
import { completeTotpEnrollment, shouldShowEnrollmentBackupCodes } from "../lib/two-factor";

describe("two-factor settings page", () => {
  it("reveals issued backup codes before a failed session refresh", async () => {
    const events: string[] = [];

    await expect(completeTotpEnrollment({
      verifyTotp: async () => {
        events.push("verified");
        return { error: null };
      },
      revealBackupCodes: () => events.push("backup-codes"),
      refetchSession: async () => {
        events.push("refresh");
        throw new Error("session refresh refused");
      },
    })).resolves.toBeNull();

    expect(events).toEqual(["verified", "backup-codes", "refresh"]);
  });

  it("keeps newly issued backup codes visible even after session refresh marks 2FA enabled", () => {
    expect(shouldShowEnrollmentBackupCodes("backup-codes", true)).toBe(true);
    expect(shouldShowEnrollmentBackupCodes("scan", true)).toBe(false);
  });

  it("starts with a password gate and keeps recovery codes hidden", () => {
    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: ["/settings/two-factor"] },
        createElement(TwoFactorSettings)
      )
    );

    expect(html).toContain("设置二次验证");
    expect(html).toContain("当前密码");
    expect(html).not.toContain("备用恢复码");
  });

  it("exposes the local QR target and manual-key fallback after enrollment begins", () => {
    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: ["/settings/two-factor"] },
        createElement(TwoFactorSettings, {
          initialEnrollment: {
            totpURI: "otpauth://totp/CQU%20Auth:user@example.com?secret=ABCDEFGH&issuer=CQU%20Auth",
            backupCodes: ["recovery-fallback-x"],
          },
        })
      )
    );

    expect(html).toContain('alt="二次验证二维码"');
    expect(html).toContain("手动输入密钥");
    expect(html).toContain("ABCDEFGH");
    expect(html).not.toContain("recovery-fallback-x");
  });

  it("offers recovery codes as a downloadable file while keeping copy available", () => {
    const html = renderToStaticMarkup(
      createElement(BackupCodes, {
        codes: ["recovery-alpha", "recovery-beta"],
        onComplete: () => undefined,
      })
    );

    expect(html).toContain("下载恢复码");
    expect(html).toContain("复制全部");
    expect(html).toContain("完成设置");
    expect(html).toContain("disabled");
  });
});
