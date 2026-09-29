// @vitest-environment jsdom
import { act, createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupUi, renderUi, settleUi } from "../lib/api/quicklogin.testbots";
import MenuSelect from "./MenuSelect";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(async () => {
  await cleanupUi();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

it("focuses the selected option when opened with the keyboard", async () => {
  // jsdom has no layout or scrolling; keep the real Radix focus lifecycle.
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  const container = await renderUi(createElement(MenuSelect, {
    value: "user",
    options: [
      { value: "user", label: "普通用户", hint: "无管理权限" },
      { value: "admin", label: "管理员" },
    ],
    onChange: vi.fn(),
    "aria-label": "角色",
  }));
  const trigger = container.querySelector<HTMLElement>('[role="combobox"]')!;
  expect(trigger.textContent).toBe("普通用户");
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  });
  await settleUi();
  expect(document.activeElement?.getAttribute("role")).toBe("option");
  expect(document.activeElement?.textContent).toContain("普通用户");
});
