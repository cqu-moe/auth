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
  const container = await renderUi(createElement(RecentAuthentication));
  let completed = false;
  await act(async () => { void requestAuthentication("admin").then(result => { completed = result; }); });
  const button = () => Array.from(container.querySelectorAll("button")).find(item => item.textContent === "使用 Passkey 验证")!;
  await click(button());
  expect(completed).toBe(false);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Passkey");
  accepted = true;
  await click(button());
  expect(completed).toBe(true);
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(requests.some(path => path.endsWith("/security/challenge") || path.endsWith("/security/complete"))).toBe(false);
});
