// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api/http";
import type { QuotaPreview } from "../../lib/api/quicklogin";
import {
  cleanupUi,
  click,
  renderUi,
  setInputValue,
  submit,
} from "../../lib/api/quicklogin.testbots";
import QuotaEditor, { PREVIEW_CHANGED_MESSAGE } from "./QuotaEditor";

const api = vi.hoisted(() => ({
  previewQuickloginQuota: vi.fn(),
  applyQuickloginQuota: vi.fn(),
  previewFromApiError: vi.fn((error: ApiError) => error.body?.preview ?? null),
}));

vi.mock("../../lib/api/quicklogin", () => api);

const PREVIEW: QuotaPreview = {
  token: "preview-token",
  expiresAt: 1_800_000_300_000,
  revision: 4,
  oldLimit: 5,
  newLimit: 3,
  kept: ["device-a", "device-b", "device-c"],
  disabled: ["device-d", "device-e"],
  keptDevices: [
    { deviceId: "device-a", deviceName: "实验室 Chrome", browserVersion: "140", lastSeenAt: 100 },
  ],
  disabledDevices: [
    { deviceId: "device-d", deviceName: "旧电脑 Chrome", browserVersion: "139", lastSeenAt: 50 },
    { deviceId: "device-e", deviceName: "备用 Chrome", browserVersion: "138", lastSeenAt: null },
  ],
};

const LATEST_PREVIEW: QuotaPreview = {
  ...PREVIEW,
  token: "latest-token",
  revision: 5,
  kept: ["device-b", "device-c", "device-d"],
  disabled: ["device-a", "device-e"],
  keptDevices: [
    { deviceId: "device-b", deviceName: "当前 Chrome", browserVersion: "140", lastSeenAt: 200 },
  ],
  disabledDevices: [
    { deviceId: "device-a", deviceName: "实验室 Chrome", browserVersion: "140", lastSeenAt: 100 },
    { deviceId: "device-e", deviceName: "备用 Chrome", browserVersion: "138", lastSeenAt: null },
  ],
};

function button(container: HTMLElement, name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")]
    .find((element) => element.textContent?.includes(name));
  if (!(found instanceof HTMLButtonElement)) throw new Error(`missing button: ${name}`);
  return found;
}

async function requestPreview(container: HTMLElement, value = "3") {
  const input = container.querySelector('input[type="number"]');
  const form = container.querySelector("form");
  if (!(input instanceof HTMLInputElement) || !(form instanceof HTMLFormElement)) {
    throw new Error("missing quota form");
  }
  await setInputValue(input, value);
  await submit(form);
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
});

afterEach(async () => {
  await cleanupUi();
});

describe("QuickLogin quota editor", () => {
  it("uses a labeled non-negative integer form and supports cancelling a preview", async () => {
    api.previewQuickloginQuota.mockResolvedValue(PREVIEW);
    const container = await renderUi(createElement(QuotaEditor, {
      userId: "synthetic-user",
      onSaved: () => undefined,
    }));
    const input = container.querySelector('input[type="number"]');
    expect(input?.getAttribute("min")).toBe("0");
    expect(input?.id).not.toBe("");
    expect(container.querySelector(`label[for="${input?.id}"]`)).not.toBeNull();

    await requestPreview(container);
    expect(container.textContent).toContain("将停用 2 台设备");
    expect(container.textContent).toContain("旧电脑 Chrome");
    expect(container.textContent).toContain("实验室 Chrome");
    await click(button(container, "取消调整"));
    expect(container.textContent).not.toContain("确认保存额度");
  });

  it("requires a second explicit confirmation when the preview changes", async () => {
    api.previewQuickloginQuota.mockResolvedValue(PREVIEW);
    api.applyQuickloginQuota.mockRejectedValue(new ApiError(
      409,
      "PREVIEW_CHANGED",
      "设备状态已变化",
      { preview: LATEST_PREVIEW }
    ));
    const container = await renderUi(createElement(QuotaEditor, {
      userId: "synthetic-user",
      onSaved: () => undefined,
    }));

    await requestPreview(container);
    await click(button(container, "确认保存额度"));

    expect(api.applyQuickloginQuota).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(PREVIEW_CHANGED_MESSAGE);
    expect(container.textContent).toContain("将停用 2 台设备");
    expect(container.textContent).toContain("额度从 5 调整为 3");
    expect(container.textContent).toContain("当前 Chrome");
    expect(container.textContent).toContain("实验室 Chrome");
  });

  it("does not announce success when apply fails", async () => {
    api.previewQuickloginQuota.mockResolvedValue(PREVIEW);
    api.applyQuickloginQuota.mockRejectedValue(new ApiError(
      503,
      "TEMPORARY_UNAVAILABLE",
      "服务暂时不可用"
    ));
    const saved = vi.fn();
    const container = await renderUi(createElement(QuotaEditor, {
      userId: "synthetic-user",
      onSaved: saved,
    }));

    await requestPreview(container);
    await click(button(container, "确认保存额度"));

    expect(container.textContent).toContain("服务暂时不可用");
    expect(container.textContent).not.toContain("设备额度已保存");
    expect(saved).not.toHaveBeenCalled();
  });
});
