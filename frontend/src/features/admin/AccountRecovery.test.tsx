// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupUi, click, renderUi, settleUi } from "../../lib/api/quicklogin.testbots";
import { AccountRecovery } from "./AccountRecovery";
const auth = vi.hoisted(() => vi.fn());
vi.mock("../../lib/recent-authentication", () => ({ requestAuthentication: auth }));
afterEach(() => { cleanupUi(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
const findButton = (name: string) => [...document.querySelectorAll("button")].find(button => button.textContent?.includes(name))!;
it("confirms, verifies admin authentication and displays the password only in the successful result", async () => {
  auth.mockResolvedValue(true);
  const fetch = vi.fn(async () => Response.json({ status: true, password: "random-result-only" })); vi.stubGlobal("fetch", fetch);
  const close = vi.fn();
  await renderUi(createElement(AccountRecovery, { user: { id: "target", name: "用户", email: "u@example.com" }, onClose: close }));
  expect(fetch).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("学校绑定、业务权益和后台同步保留");
  await click(findButton("确认重置")); await settleUi();
  expect(auth).toHaveBeenCalledWith("admin");
  expect(fetch).toHaveBeenCalledWith("/api/v1/auth/admin/reset-authentication", expect.objectContaining({ body: JSON.stringify({ userId: "target" }) }));
  expect((document.querySelector("#recovery-password") as HTMLInputElement).value).toBe("random-result-only");
  expect(findButton("确认重置")).toBeUndefined();
  await click(findButton("已保存，关闭")); await settleUi();
  expect(close).toHaveBeenCalledOnce();
  expect(document.querySelector("#recovery-password")).toBeNull();
});
it("does not send the destructive request if verification is cancelled", async () => {
  auth.mockResolvedValue(false); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await renderUi(createElement(AccountRecovery, { user: { id: "target", name: "用户", email: "u@example.com" }, onClose: vi.fn() }));
  await click(findButton("确认重置")); await settleUi();
  expect(fetch).not.toHaveBeenCalled(); expect(document.querySelector("#recovery-password")).toBeNull();
});
