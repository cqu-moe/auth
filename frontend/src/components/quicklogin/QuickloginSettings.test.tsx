// @vitest-environment jsdom
import { createElement, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupUi,
  click,
  renderUi,
  settleUi,
} from "../../lib/api/quicklogin.testbots";
import type { DeviceListData } from "../../lib/api/quicklogin";
import QuickloginSettings from "./QuickloginSettings";
import DeviceList from "./DeviceList";
import { isDeviceOnline, QUICKLOGIN_REVOKE_WARNING } from "./device-list";

const api = vi.hoisted(() => ({
  getQuickloginPreference: vi.fn(),
  listQuickloginDevices: vi.fn(),
  setQuickloginMasterEnabled: vi.fn(),
  revokeQuickloginDevice: vi.fn(),
  isDeviceQuickloginPreference: vi.fn((value: Record<string, unknown>) =>
    value.eligible === true && "masterEnabled" in value
  ),
}));

vi.mock("../../lib/api/quicklogin", () => api);

const DEVICE_LIST: DeviceListData = {
  masterEnabled: false,
  deviceLimit: 0,
  used: 0,
  revision: 2,
  devices: [{
    deviceId: "device-a",
    deviceName: "宿舍 Chrome",
    browserFamily: "chrome",
    browserVersion: "140.0.1",
    enabled: false,
    enabledAt: null,
    lastSeenAt: null,
    lastIp: null,
    revokedAt: null,
    generation: 2,
    disabledReason: "quota_reduced",
    appliedVersion: null,
    online: false,
  }],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function button(container: HTMLElement, name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")]
    .find((element) => element.textContent?.includes(name));
  if (!(found instanceof HTMLButtonElement)) throw new Error(`missing button: ${name}`);
  return found;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
});

afterEach(async () => {
  await cleanupUi();
  vi.unstubAllGlobals();
});

describe("QuickLogin settings", () => {
  it("renders nothing after an explicit ineligible response without listing devices", async () => {
    api.getQuickloginPreference.mockResolvedValue({ eligible: false });

    const container = await renderUi(createElement(QuickloginSettings));

    expect(container.textContent).toBe("");
    expect(api.listQuickloginDevices).not.toHaveBeenCalled();
  });

  it("keeps quota-zero devices manageable with the exact ownership warning", async () => {
    api.getQuickloginPreference.mockResolvedValue({
      eligible: true,
      masterEnabled: false,
      deviceLimit: 0,
      used: 0,
    });
    api.listQuickloginDevices.mockResolvedValue(DEVICE_LIST);

    const container = await renderUi(createElement(QuickloginSettings, {
      currentDeviceHint: "device-a",
    }));

    expect(container.textContent).toContain("已启用 0 / 0 台");
    expect(container.textContent).toContain("当前插件");
    expect(container.textContent).toContain("最近 IP：暂无");
    expect(container.textContent).toContain("退出设备");
    expect(container.textContent).toContain(QUICKLOGIN_REVOKE_WARNING);
  });

  it("reloads the summary and devices after changing the master switch", async () => {
    api.getQuickloginPreference
      .mockResolvedValueOnce({ eligible: true, masterEnabled: false, deviceLimit: 2, used: 0 })
      .mockResolvedValueOnce({ eligible: true, masterEnabled: true, deviceLimit: 2, used: 0 });
    api.listQuickloginDevices
      .mockResolvedValueOnce({
        ...DEVICE_LIST,
        deviceLimit: 2,
        devices: [],
      })
      .mockResolvedValueOnce({
        ...DEVICE_LIST,
        masterEnabled: true,
        deviceLimit: 2,
        devices: [],
      });
    api.setQuickloginMasterEnabled.mockResolvedValue({
      eligible: true,
      masterEnabled: true,
      deviceLimit: 2,
      used: 0,
    });
    const container = await renderUi(createElement(QuickloginSettings));
    const toggle = container.querySelector('[role="switch"]');
    if (!(toggle instanceof HTMLButtonElement)) throw new Error("missing master switch");

    await click(toggle);

    expect(api.setQuickloginMasterEnabled).toHaveBeenCalledWith(true);
    expect(api.getQuickloginPreference).toHaveBeenCalledTimes(2);
    expect(api.listQuickloginDevices).toHaveBeenCalledTimes(2);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("retains the previous list when a post-revoke refresh fails", async () => {
    api.getQuickloginPreference.mockResolvedValue({
      eligible: true,
      masterEnabled: false,
      deviceLimit: 0,
      used: 0,
    });
    api.listQuickloginDevices
      .mockResolvedValueOnce(DEVICE_LIST)
      .mockRejectedValueOnce(new Error("offline"));
    api.revokeQuickloginDevice.mockResolvedValue(undefined);
    vi.stubGlobal("confirm", vi.fn(() => true));
    const container = await renderUi(createElement(QuickloginSettings));

    await click(button(container, "退出设备"));

    expect(api.revokeQuickloginDevice).toHaveBeenCalledWith("device-a");
    expect(container.textContent).toContain("宿舍 Chrome");
    expect(container.textContent).toContain("无法刷新设备列表");
  });

  it("shows the empty state and uses the exact ten-minute online boundary", async () => {
    api.getQuickloginPreference.mockResolvedValue({
      eligible: true,
      masterEnabled: true,
      deviceLimit: 3,
      used: 0,
    });
    api.listQuickloginDevices.mockResolvedValue({
      ...DEVICE_LIST,
      masterEnabled: true,
      deviceLimit: 3,
      devices: [],
    });
    const container = await renderUi(createElement(QuickloginSettings));

    expect(container.textContent).toContain("还没有授权的浏览器");
    expect(isDeviceOnline(400_000, 1_000_000)).toBe(true);
    expect(isDeviceOnline(399_999, 1_000_000)).toBe(false);
  });

  it("filters revoked devices before deciding the empty state and actions", async () => {
    const revoked = { ...DEVICE_LIST.devices[0], revokedAt: 1_800_000_000_000 };
    const active = {
      ...DEVICE_LIST.devices[0],
      deviceId: "device-active",
      deviceName: "仍在使用的 Chrome",
    };

    const revokedOnly = await renderUi(createElement(DeviceList, {
      data: { ...DEVICE_LIST, devices: [revoked] },
      onRevoke: async () => undefined,
    }));
    expect(revokedOnly.textContent).toContain("还没有授权的浏览器");
    expect(revokedOnly.textContent).not.toContain("宿舍 Chrome");
    expect(revokedOnly.querySelectorAll("button")).toHaveLength(0);

    const mixed = await renderUi(createElement(DeviceList, {
      data: { ...DEVICE_LIST, devices: [revoked, active] },
      onRevoke: async () => undefined,
    }));
    expect(mixed.textContent).not.toContain("宿舍 Chrome");
    expect(mixed.textContent).toContain("仍在使用的 Chrome");
    expect(mixed.querySelectorAll("button")).toHaveLength(1);
  });

  it("ignores a superseded StrictMode load that resolves last", async () => {
    const first = deferred<{ eligible: false }>();
    const second = deferred<{
      eligible: true;
      masterEnabled: boolean;
      deviceLimit: number;
      used: number;
    }>();
    api.getQuickloginPreference
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    api.listQuickloginDevices.mockResolvedValue({
      ...DEVICE_LIST,
      deviceLimit: 1,
      devices: [{ ...DEVICE_LIST.devices[0], deviceName: "最新 Chrome" }],
    });
    const container = await renderUi(createElement(
      StrictMode,
      null,
      createElement(QuickloginSettings)
    ));
    expect(api.getQuickloginPreference).toHaveBeenCalledTimes(2);

    second.resolve({
      eligible: true,
      masterEnabled: false,
      deviceLimit: 1,
      used: 0,
    });
    await settleUi();
    expect(container.textContent).toContain("最新 Chrome");

    first.resolve({ eligible: false });
    await settleUi();
    expect(container.textContent).toContain("最新 Chrome");
  });

  it("invalidates an in-flight load on unmount before it can list devices", async () => {
    const pending = deferred<{
      eligible: true;
      masterEnabled: boolean;
      deviceLimit: number;
      used: number;
    }>();
    api.getQuickloginPreference.mockReturnValue(pending.promise);
    await renderUi(createElement(QuickloginSettings));

    await cleanupUi();
    pending.resolve({
      eligible: true,
      masterEnabled: false,
      deviceLimit: 1,
      used: 0,
    });
    await settleUi();

    expect(api.listQuickloginDevices).not.toHaveBeenCalled();
  });

  it("uses one action mutex so a master save blocks device revoke", async () => {
    api.getQuickloginPreference.mockResolvedValue({
      eligible: true,
      masterEnabled: false,
      deviceLimit: 1,
      used: 0,
    });
    api.listQuickloginDevices.mockResolvedValue({ ...DEVICE_LIST, deviceLimit: 1 });
    const pending = deferred<{
      eligible: true;
      masterEnabled: boolean;
      deviceLimit: number;
      used: number;
    }>();
    api.setQuickloginMasterEnabled.mockReturnValue(pending.promise);
    const container = await renderUi(createElement(QuickloginSettings));
    const toggle = container.querySelector('[role="switch"]');
    if (!(toggle instanceof HTMLButtonElement)) throw new Error("missing master switch");

    await click(toggle);
    const revoke = button(container, "退出设备");
    expect(revoke.disabled).toBe(true);
    await click(revoke);
    expect(api.revokeQuickloginDevice).not.toHaveBeenCalled();

    pending.resolve({
      eligible: true,
      masterEnabled: true,
      deviceLimit: 1,
      used: 0,
    });
    await settleUi();
  });
});
