// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { click, cleanupUi, renderUi, setInputValue, submit } from "../lib/api/quicklogin.testbots";
import SecuritySection from "./SecuritySection";
import TwoFactorSettings from "../pages/TwoFactorSettings";

const state = vi.hoisted(() => ({ enabled: true, refetch: vi.fn(async () => undefined), nativeMutation: vi.fn() }));
vi.mock("../lib/auth-client", () => ({ authClient: {
  useSession: () => ({ data: { user: { twoFactorEnabled: state.enabled, role: "user" } }, refetch: state.refetch }),
  twoFactor: { enable: state.nativeMutation, disable: state.nativeMutation, generateBackupCodes: state.nativeMutation },
  changePassword: state.nativeMutation,
} }));
vi.mock("@simplewebauthn/browser", () => ({ startAuthentication: vi.fn(async () => ({ id: "own-key", response: {} })) }));
vi.mock("./Layout", () => ({ default: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("./DeviceSessions", () => ({ default: () => null }));
afterEach(async () => { await cleanupUi(); vi.restoreAllMocks(); state.nativeMutation.mockClear(); });

it.each(["password", "enable", "disable", "generate-backup-codes"] as const)("offers an independent Passkey path for %s without sending a password", async operation => {
  state.enabled = operation !== "enable";
  const submitted: Array<{ path: string; body: Record<string, unknown> }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = String(input); const body = JSON.parse(String(init?.body ?? "{}"));
    submitted.push({ path, body });
    if (path.endsWith("/options")) return Response.json({ challengeId: "one-use", options: { challenge: "webauthn" } });
    if (path.endsWith("/complete")) return Response.json({ verified: true });
    if (path.endsWith("/enable")) return Response.json({ method: "totp", totpURI: "otpauth://totp/Auth:user?secret=JBSWY3DPEHPK3PXP", backupCodes: ["new-code"] });
    if (path.endsWith("/generate-backup-codes")) return Response.json({ backupCodes: ["new-code"] });
    return Response.json({ status: true });
  });
  const container = await renderUi(createElement(MemoryRouter, null, operation === "password" ? createElement(SecuritySection, { twoFactorEnabled: true }) : createElement(TwoFactorSettings)));
  const button = (label: string) => Array.from(container.querySelectorAll("button")).find(element => element.textContent?.trim() === label)!;
  if (operation === "password") await click(container.querySelector('[aria-label="修改密码"]')!);
  else if (operation !== "enable") await click(button(operation === "disable" ? "关闭二次验证" : "重新生成恢复码"));
  await click(button("使用 Passkey"));
  expect(container.querySelector('input[autocomplete="current-password"]')).toBeNull();
  if (operation === "password") {
    await setInputValue(container.querySelector<HTMLInputElement>("#newPassword")!, "new-password-123");
    await setInputValue(container.querySelector<HTMLInputElement>("#confirmNewPassword")!, "new-password-123");
  }
  await submit(container.querySelector("form")!);
  expect(state.nativeMutation).not.toHaveBeenCalled();
  const suffix = operation === "password" ? "change-password" : `two-factor/${operation}`;
  expect(submitted[submitted.length - 1]?.path).toBe(`/api/v1/auth/security/passkey/${suffix}`);
  expect(submitted.every(({ body }) => !("password" in body) && !("currentPassword" in body))).toBe(true);
  expect(submitted[0].body).toEqual({ purpose: operation === "password" ? "password" : "mfa" });
  if (operation === "generate-backup-codes") expect(container.textContent).toContain("new-code");
  if (operation === "enable") expect(container.querySelector("#two-factor-totp")).not.toBeNull();
});
