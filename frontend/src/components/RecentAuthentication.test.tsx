// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { renderUi, click, cleanupUi } from "../lib/api/quicklogin.testbots";
import { requestAuthentication } from "../lib/recent-authentication";
import RecentAuthentication from "./RecentAuthentication";

const webauthn = vi.hoisted(() => ({ startAuthentication: vi.fn() }));
vi.mock("@simplewebauthn/browser", () => webauthn);
afterEach(async () => { await cleanupUi(); vi.restoreAllMocks(); });

it("allows a Passkey alone to complete the pending operation only after the server accepts it", async () => {
  const requests: string[] = [];
  let accepted = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    const path = String(input); requests.push(path);
    if (path.includes("/status")) return Response.json({ verified: false });
    if (path.endsWith("/options")) return Response.json({ challengeId: "pending", options: { challenge: "webauthn" } });
    return Response.json({ verified: accepted }, { status: accepted ? 200 : 401 });
  });
  webauthn.startAuthentication.mockResolvedValue({ id: "registered-key", response: {} });
  await renderUi(createElement(RecentAuthentication));
  let completed = false;
  await act(async () => { void requestAuthentication("admin").then(result => { completed = result; }); });
  const button = () => Array.from(document.querySelectorAll("button")).find(item => item.textContent === "使用 Passkey 验证")!;
  await click(button());
  expect(completed).toBe(false);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Passkey");
  accepted = true;
  await click(button());
  expect(completed).toBe(true);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(requests.some(path => path.endsWith("/security/challenge") || path.endsWith("/security/complete"))).toBe(false);
});


it("cancels with Escape and restores focus to the initiating control", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ verified: false }));
  let result: boolean | undefined;
  const container = await renderUi(createElement("div", null,
    createElement("button", { onClick: () => { void requestAuthentication("mfa").then(value => { result = value; }); } }, "安全操作"),
    createElement(RecentAuthentication)));
  const trigger = container.querySelector("button")!;
  trigger.focus();
  await click(trigger);
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog).not.toBeNull();
  await act(async () => { trigger.focus(); });
  expect(dialog.contains(document.activeElement)).toBe(true);
  await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(result).toBe(false);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
