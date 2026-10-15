// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { click, cleanupUi, renderUi, setInputValue, settleUi, submit } from "../lib/api/quicklogin.testbots";
import PasskeySettings from "./PasskeySettings";

const api = vi.hoisted(() => ({
  listUserPasskeys: vi.fn(), addPasskey: vi.fn(), updatePasskey: vi.fn(), deletePasskey: vi.fn(),
}));
const authenticate = vi.hoisted(() => vi.fn());
vi.mock("../lib/auth-client", () => ({ authClient: { passkey: api } }));
vi.mock("../lib/recent-authentication", () => ({ requestAuthentication: authenticate }));
const button = (name: string) => Array.from(document.querySelectorAll("button")).find(item => item.textContent === name)!;
const input = () => document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
const form = () => document.querySelector<HTMLFormElement>('[role="dialog"] form')!;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetAllMocks();
  api.listUserPasskeys.mockResolvedValue({ data: [{ id: "key-1", name: "1Password" }], error: null });
  for (const method of [api.addPasskey, api.updatePasskey, api.deletePasskey]) method.mockResolvedValue({ error: null });
  authenticate.mockResolvedValue(true);
});
afterEach(async () => { await cleanupUi(); vi.unstubAllGlobals(); });

it("keeps saved names read-only and discards a cancelled rename without writing", async () => {
  await renderUi(createElement(PasskeySettings));
  expect(document.querySelector("input")).toBeNull();
  const trigger = button("重命名");
  trigger.focus();
  await click(trigger);
  expect(input().value).toBe("1Password");
  await setInputValue(input(), "未保存的名称");
  await click(button("取消"));
  expect(api.updatePasskey).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("1Password");
  expect(document.activeElement).toBe(trigger);
  await click(trigger);
  expect(input().value).toBe("1Password");
});

it("opens creation on demand, preserves a failed draft, and closes only after success", async () => {
  await renderUi(createElement(PasskeySettings));
  await click(button("添加 Passkey"));
  await setInputValue(input(), "我的手机");
  api.addPasskey.mockResolvedValueOnce({ error: { message: "cancelled" } });
  await submit(form());
  expect(input().value).toBe("我的手机");
  expect(document.querySelector('[role="dialog"] [role="alert"]')).not.toBeNull();
  api.listUserPasskeys.mockResolvedValue({ data: [{ id: "key-1", name: "1Password" }, { id: "key-2", name: "我的手机" }], error: null });
  await submit(form());
  expect(api.addPasskey).toHaveBeenLastCalledWith({ name: "我的手机" });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.querySelector("input")).toBeNull();
  expect(document.body.textContent).toContain("我的手机");
});

it("keeps the persisted name until a rename succeeds and blocks duplicate submissions", async () => {
  await renderUi(createElement(PasskeySettings));
  await click(button("重命名"));
  await setInputValue(input(), "  我的电脑  ");
  let resolve!: (result: { error: null }) => void;
  api.updatePasskey.mockImplementation(() => new Promise(done => { resolve = done; }));
  await submit(form());
  await submit(form());
  expect(api.updatePasskey).toHaveBeenCalledTimes(1);
  expect(api.updatePasskey).toHaveBeenCalledWith({ id: "key-1", name: "我的电脑" });
  expect(document.querySelector("ul")?.textContent).toContain("1Password");
  api.listUserPasskeys.mockResolvedValue({ data: [{ id: "key-1", name: "我的电脑" }], error: null });
  await act(async () => resolve({ error: null }));
  await settleUi();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.body.textContent).toContain("我的电脑");
});

it("requires deletion confirmation and never writes when identity verification is cancelled", async () => {
  await renderUi(createElement(PasskeySettings));
  await click(button("删除"));
  expect(api.deletePasskey).not.toHaveBeenCalled();
  await click(button("取消"));
  await click(button("删除"));
  authenticate.mockResolvedValueOnce(false);
  await submit(form());
  expect(api.deletePasskey).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  api.listUserPasskeys.mockResolvedValue({ data: [], error: null });
  await submit(form());
  expect(api.deletePasskey).toHaveBeenCalledWith({ id: "key-1" });
  expect(document.activeElement).toBe(button("添加 Passkey"));
});

it("distinguishes a failed list request from an empty account and allows retry", async () => {
  api.listUserPasskeys.mockResolvedValueOnce({ data: null, error: { message: "offline" } });
  await renderUi(createElement(PasskeySettings));
  expect(document.body.textContent).not.toContain("尚未添加 Passkey");
  await click(button("重新加载"));
  expect(document.body.textContent).toContain("1Password");
});
