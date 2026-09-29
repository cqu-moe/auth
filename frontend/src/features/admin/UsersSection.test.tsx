// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupUi,
  click,
  renderUi,
  setInputValue,
  settleUi,
  submit,
} from "../../lib/api/quicklogin.testbots";
import { EntitlementPanel } from "./UsersSection";

const mocks = vi.hoisted(() => ({
  adminFetch: vi.fn(),
  previewQuickloginQuota: vi.fn(),
  applyQuickloginQuota: vi.fn(),
}));

vi.mock("../../lib/api/admin", () => ({ adminFetch: mocks.adminFetch }));
vi.mock("../../lib/api/quicklogin", () => ({
  previewQuickloginQuota: mocks.previewQuickloginQuota,
  applyQuickloginQuota: mocks.applyQuickloginQuota,
  previewFromApiError: () => null,
}));

function button(root: ParentNode, name: string): HTMLButtonElement {
  const found = [...root.querySelectorAll("button")]
    .find((element) => element.textContent?.includes(name));
  if (!(found instanceof HTMLButtonElement)) throw new Error(`missing button: ${name}`);
  return found;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function checkbox(root: ParentNode, label: string): HTMLInputElement {
  const row = [...root.querySelectorAll("label")]
    .find((element) => element.textContent?.includes(label));
  const input = row?.querySelector('input[type="checkbox"]');
  if (!(input instanceof HTMLInputElement)) throw new Error(`missing checkbox: ${label}`);
  return input;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.adminFetch.mockImplementation(async (path: string) => {
    if (path.endsWith("/entitlements")) {
      return Response.json({ data: [] });
    }
    if (path === "/admin/entitlement-presets") {
      return Response.json({ data: [] });
    }
    throw new Error(`unexpected admin path: ${path}`);
  });
  mocks.previewQuickloginQuota.mockResolvedValue({
    token: "preview-token",
    expiresAt: 1_800_000_300_000,
    revision: 4,
    oldLimit: 5,
    newLimit: 3,
    kept: [],
    disabled: [],
    keptDevices: [],
    disabledDevices: [],
  });
  mocks.applyQuickloginQuota.mockResolvedValue({
    masterEnabled: true,
    deviceLimit: 3,
    used: 0,
    revision: 5,
    devices: [],
  });
});

afterEach(async () => {
  await cleanupUi();
});

describe("admin QuickLogin quota integration", () => {
  it("updates only quota and preserves local entitlement edits when apply completes", async () => {
    const apply = deferred<{
      masterEnabled: boolean;
      deviceLimit: number;
      used: number;
      revision: number;
      devices: never[];
    }>();
    mocks.applyQuickloginQuota.mockReturnValue(apply.promise);
    await renderUi(createElement(EntitlementPanel, {
      user: {
        id: "user-a",
        name: "测试用户",
        email: "user-a@example.com",
        role: "user",
        banned: false,
        createdAt: "2026-09-12T00:00:00.000Z",
      },
      canEditQuota: true,
      onClose: () => undefined,
    }));
    // 权益面板渲染在共享 Dialog 的传送门里，内容挂载到 document.body。
    const input = document.querySelector("#quicklogin-device-limit");
    const form = document.querySelector("form");
    if (!(input instanceof HTMLInputElement) || !(form instanceof HTMLFormElement)) {
      throw new Error("missing quota form");
    }

    await setInputValue(input, "3");
    await submit(form);
    await click(button(document, "确认保存额度"));
    const calendarSync = checkbox(document, "日历同步");
    await click(calendarSync);
    expect(calendarSync.checked).toBe(true);

    apply.resolve({
      masterEnabled: true,
      deviceLimit: 3,
      used: 0,
      revision: 5,
      devices: [],
    });
    await settleUi();

    expect(document.body.textContent).toContain("设备额度已保存");
    expect(calendarSync.checked).toBe(true);
    expect(document.querySelector('[aria-label="快捷登录设备额度当前值"]')?.textContent)
      .toContain("3 台");
    expect(mocks.adminFetch).toHaveBeenCalledTimes(2);
  });
});
