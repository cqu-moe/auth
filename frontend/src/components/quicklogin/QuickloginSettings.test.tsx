// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupUi,
  click,
  renderUi,
  settleUi,
} from "../../lib/api/quicklogin.testbots";
import { deviceSnapshot, overview } from "../../lib/api/quicklogin.fixtures";
import type { Overview } from "../../lib/api/quicklogin-protocol.generated";
import QuickloginSettings from "./QuickloginSettings";
import DeviceList from "./DeviceList";
import { QUICKLOGIN_REVOKE_WARNING } from "./device-list";

const api = vi.hoisted(() => ({
  getQuickloginPreference: vi.fn(),
  getQuickloginOverview: vi.fn(),
  setQuickloginMasterEnabled: vi.fn(),
  revokeQuickloginDevice: vi.fn(),
  reconnectQuickloginDevice: vi.fn(),
  isDeviceQuickloginPreference: vi.fn((value: Record<string, unknown>) =>
    value.eligible === true && "masterEnabled" in value
  ),
}));

vi.mock("../../lib/api/quicklogin", () => api);

const DEVICE_LIST: Overview = {
  ...overview(), masterEnabled: false, deviceLimit: 0, used: 0,
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

async function openDeviceMenu(container: HTMLElement): Promise<HTMLElement> {
  const trigger = container.querySelector('button[aria-haspopup="menu"]');
  if (!(trigger instanceof HTMLButtonElement)) throw new Error("missing device menu");
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  await settleUi();
  const item = document.querySelector('[role="menuitem"]');
  if (!(item instanceof HTMLElement)) throw new Error("missing exit action");
  return item;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  api.isDeviceQuickloginPreference.mockImplementation((value) => value.eligible === true && "masterEnabled" in value);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});

afterEach(async () => {
  await cleanupUi();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("QuickLogin settings", () => {
  it("renders nothing after an explicit ineligible response without listing devices", async () => {
    api.getQuickloginPreference.mockResolvedValue({ eligible: false });

    const container = await renderUi(createElement(QuickloginSettings));

    expect(container.textContent).toBe("");
    expect(api.getQuickloginOverview).not.toHaveBeenCalled();
  });

  it("keeps quota-zero devices manageable and reserves consequences for confirmation", async () => {
    api.getQuickloginPreference.mockResolvedValue({
      eligible: true,
      masterEnabled: false,
      deviceLimit: 0,
      used: 0,
    });
    api.getQuickloginOverview.mockResolvedValue(DEVICE_LIST);

    const container = await renderUi(createElement(QuickloginSettings, {
      currentDeviceHint: "device-a",
    }));

    expect(container.textContent).toContain("已启用 0 / 0 台");
    expect(container.textContent).toContain("当前插件");
    expect(container.textContent).toContain("最近联系");
    expect(container.textContent).not.toContain("最近 IP");
    expect(container.textContent).not.toContain("退出设备");
    expect(container.textContent).not.toContain(QUICKLOGIN_REVOKE_WARNING);
    vi.stubGlobal("confirm", vi.fn(() => false));
    const exit = await openDeviceMenu(container);
    expect(exit.textContent).toContain("退出设备");
    await click(exit);
    expect(confirm).toHaveBeenCalledWith(QUICKLOGIN_REVOKE_WARNING);
    expect(api.revokeQuickloginDevice).not.toHaveBeenCalled();
  });

  it("reloads the summary and devices after changing the master switch", async () => {
    api.getQuickloginPreference
      .mockResolvedValueOnce({ eligible: true, masterEnabled: false, deviceLimit: 2, used: 0 })
      .mockResolvedValueOnce({ eligible: true, masterEnabled: true, deviceLimit: 2, used: 0 });
    api.getQuickloginOverview
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
    expect(api.getQuickloginOverview).toHaveBeenCalledTimes(2);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("retains the previous list when a post-revoke refresh fails", async () => {
    api.getQuickloginPreference.mockResolvedValue({
      eligible: true,
      masterEnabled: false,
      deviceLimit: 0,
      used: 0,
    });
    api.getQuickloginOverview
      .mockResolvedValueOnce(DEVICE_LIST)
      .mockRejectedValueOnce(new Error("offline"));
    api.revokeQuickloginDevice.mockResolvedValue(undefined);
    vi.stubGlobal("confirm", vi.fn(() => true));
    const container = await renderUi(createElement(QuickloginSettings));

    await click(await openDeviceMenu(container));

    expect(api.revokeQuickloginDevice).toHaveBeenCalledWith("device-a");
    expect(container.textContent).toContain("宿舍 Chrome");
    expect(container.textContent).toContain("无法刷新设备列表");
  });

  it("shows the empty state", async () => {
    api.getQuickloginPreference.mockResolvedValue({
      eligible: true,
      masterEnabled: true,
      deviceLimit: 3,
      used: 0,
    });
    api.getQuickloginOverview.mockResolvedValue({
      ...DEVICE_LIST,
      masterEnabled: true,
      deviceLimit: 3,
      devices: [],
    });
    const container = await renderUi(createElement(QuickloginSettings));

    expect(container.textContent).toContain("还没有授权的浏览器");

  });

  it("keeps revoked devices visible with a reconnect action", async () => {
    const revoked = deviceSnapshot();
    revoked.authorization.state = "revoked";
    const container = await renderUi(createElement(DeviceList, {
      data: overview([revoked]), onRevoke: async () => undefined,
      onReconnect: async () => undefined, onRefresh: async () => undefined,
    }));
    expect(container.textContent).toContain("此设备已退出");
    expect(container.textContent).toContain("重新连接");
    expect(container.textContent).not.toContain("退出设备");
  });

  it("regresses the screenshot contradiction: two devices never inherit presence as readiness", async () => {
    const pending = deviceSnapshot();
    pending.cloud.state = "logging_in";
    pending.cloud.lastValidatedAt = null;
    pending.capabilities.canUseExistingSession = false;
    const noReport = deviceSnapshot();
    noReport.identity = { ...noReport.identity, deviceId: "device-b", deviceName: "教室 Chrome" };
    const container = await renderUi(createElement(DeviceList, {
      data: overview([pending, noReport]), currentDeviceHint: "device-a",
      onRevoke: async () => undefined, onReconnect: async () => undefined, onRefresh: async () => undefined,
    }));
    const rows = [...container.querySelectorAll("li")];
    expect(rows[0].textContent).toContain("正在准备学校登录");
    expect(rows[0].textContent).toContain("当前插件");
    expect(rows[1].textContent).toContain("等待插件同步");
    for (const row of rows) {
      expect(row.querySelectorAll("p")).toHaveLength(1);
      expect(row.textContent).not.toContain("此设备云端会话");
      expect(row.textContent).not.toContain("本地报告");
      expect(row.textContent).not.toContain("尚未上报");
    }
    expect(container.textContent).not.toContain("在线");
    expect(container.textContent).not.toContain("已就绪");
    expect(container.querySelector(".text-success")).toBeNull();
  });

  it("polls active devices every five seconds, pauses hidden and reloads on focus", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const active = deviceSnapshot();
    active.cloud.state = "logging_in";
    api.getQuickloginPreference.mockResolvedValue({ eligible: true, masterEnabled: true });
    api.getQuickloginOverview.mockResolvedValue(overview([active]));
    await renderUi(createElement(QuickloginSettings));
    await act(async () => vi.advanceTimersByTime(5_000));
    expect(api.getQuickloginOverview).toHaveBeenCalledTimes(2);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(api.getQuickloginOverview).toHaveBeenCalledTimes(2);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(api.getQuickloginOverview).toHaveBeenCalledTimes(3);
  });

  it("polls idle devices every thirty seconds and marks retained results unreachable", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    api.getQuickloginPreference.mockResolvedValue({ eligible: true, masterEnabled: true });
    api.getQuickloginOverview.mockResolvedValueOnce(overview()).mockRejectedValue(new Error("offline"));
    const container = await renderUi(createElement(QuickloginSettings));
    await act(async () => vi.advanceTimersByTime(29_999));
    expect(api.getQuickloginOverview).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(1));
    expect(container.textContent).toContain("暂时无法连接 Auth");
    expect(container.textContent).toContain("仍显示上次结果");
    expect(container.textContent).not.toContain("已就绪");
  });

  it("reconnects only on an explicit device action and reloads afterwards", async () => {
    const revoked = deviceSnapshot();
    revoked.authorization.state = "revoked";
    api.getQuickloginPreference.mockResolvedValue({ eligible: true, masterEnabled: true });
    api.getQuickloginOverview.mockResolvedValue(overview([revoked]));
    api.reconnectQuickloginDevice.mockResolvedValue(undefined);
    const container = await renderUi(createElement(QuickloginSettings, { currentDeviceHint: "device-a" }));
    expect(api.reconnectQuickloginDevice).not.toHaveBeenCalled();
    await click(button(container, "重新连接"));
    expect(api.reconnectQuickloginDevice).toHaveBeenCalledWith("device-a");
    expect(api.getQuickloginOverview).toHaveBeenCalledTimes(2);
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
    api.getQuickloginOverview.mockResolvedValue({
      ...DEVICE_LIST,
      deviceLimit: 1,
      devices: [{ ...DEVICE_LIST.devices[0], identity: { ...DEVICE_LIST.devices[0].identity, deviceName: "最新 Chrome" } }],
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

    expect(api.getQuickloginOverview).not.toHaveBeenCalled();
  });

  it("uses one action mutex so a master save blocks device revoke", async () => {
    api.getQuickloginPreference.mockResolvedValue({
      eligible: true,
      masterEnabled: false,
      deviceLimit: 1,
      used: 0,
    });
    api.getQuickloginOverview.mockResolvedValue({ ...DEVICE_LIST, deviceLimit: 1 });
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
    const menu = container.querySelector('button[aria-haspopup="menu"]') as HTMLButtonElement;
    expect(menu.disabled).toBe(true);
    await click(menu);
    expect(document.querySelector('[role="menu"]')).toBeNull();
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

it("preserves an enabled master preference when the first overview fails", async () => {
  api.getQuickloginPreference.mockResolvedValue({ eligible: true, masterEnabled: true });
  api.getQuickloginOverview.mockRejectedValue(new Error("offline"));
  const container = await renderUi(createElement(QuickloginSettings));
  expect(container.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
});

it("does not present a contract mismatch as a missing binding or expose machine error codes", async () => {
  api.getQuickloginPreference.mockResolvedValue({ eligible: true, masterEnabled: true });
  api.getQuickloginOverview.mockRejectedValue(Object.assign(new Error("CONTRACT_INVALID"), { code: "CONTRACT_INVALID" }));
  const container = await renderUi(createElement(QuickloginSettings));
  expect(container.textContent).toContain("状态格式暂时无法识别");
  expect(container.textContent).not.toContain("尚未绑定");
  expect(container.textContent).not.toContain("CONTRACT_INVALID");
});

it("updates the reported plugin version live and withdraws ready when refresh fails", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const device = deviceSnapshot();
  const now = Date.now();
  device.reportedLocal = {
    reportEpoch: "epoch-a", clientReportSeq: 1, cookieState: "applied", receivedAt: now,
    verificationAge: 0, acknowledgedAt: now, enabledIntent: true, mode: "automatic", schoolAccess: "unverified",
    client: { extensionVersion: "0.2.0", buildId: "build-a", browserVersion: "140.0.1", installationId: "installation-a" },
    receipt: { deviceId: "device-a", generation: 2, bindingEpoch: 1, credentialRevision: 1, sessionVersion: 2, exportId: "export-a", result: "applied", verifiedAt: now },
  };
  api.getQuickloginPreference.mockResolvedValue({ eligible: true, masterEnabled: true });
  api.getQuickloginOverview.mockResolvedValueOnce(overview())
    .mockResolvedValueOnce(overview([device])).mockRejectedValue(new Error("offline"));
  const container = await renderUi(createElement(QuickloginSettings));
  expect(container.textContent).not.toContain("已就绪");
  await act(async () => vi.advanceTimersByTime(30_000));
  expect(container.textContent).toContain("已就绪");
  expect(container.textContent).toContain("插件 0.2.0 · 最近联系");
  expect(container.textContent).not.toContain("Chrome 140.0.1");
  await act(async () => vi.advanceTimersByTime(30_000));
  expect(container.textContent).toContain("暂时无法连接 Auth");
  expect(container.textContent).not.toContain("已就绪");
  expect(container.querySelector(".text-success")).toBeNull();
});

it("ignores an older overview arriving after a focus refresh", async () => {
  const old = deferred<Overview>();
  const next = deviceSnapshot();
  next.identity.deviceName = "更新后的设备";
  api.getQuickloginPreference.mockResolvedValue({ eligible: true, masterEnabled: true });
  api.getQuickloginOverview.mockReturnValueOnce(old.promise).mockResolvedValueOnce(overview([next]));
  const container = await renderUi(createElement(QuickloginSettings));
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(container.textContent).toContain("更新后的设备");
  old.resolve(overview());
  await settleUi();
  expect(container.textContent).toContain("更新后的设备");
  expect(container.textContent).not.toContain("宿舍 Chrome");
});


it("offers reconnect for the explicitly hinted active device without adding it to other rows", async () => {
  const second = deviceSnapshot();
  second.identity = { ...second.identity, deviceId: "device-b", deviceName: "教室 Chrome" };
  api.getQuickloginPreference.mockResolvedValue({ eligible: true, masterEnabled: true });
  api.getQuickloginOverview.mockResolvedValue(overview([deviceSnapshot(), second]));
  api.reconnectQuickloginDevice.mockResolvedValue(undefined);
  const container = await renderUi(createElement(QuickloginSettings, {
    currentDeviceHint: "device-a", reconnectDeviceHint: "device-a",
  }));
  const rows = [...container.querySelectorAll("li")];
  expect(rows[0].textContent).toContain("重新连接");
  expect(rows[1].textContent).not.toContain("重新连接");
  expect(api.reconnectQuickloginDevice).not.toHaveBeenCalled();
  await click(button(rows[0], "重新连接"));
  expect(api.reconnectQuickloginDevice).toHaveBeenCalledWith("device-a");
  expect(api.getQuickloginOverview).toHaveBeenCalledTimes(2);
});

it("keeps a normally opened active-device row free of reconnect controls", async () => {
  api.getQuickloginPreference.mockResolvedValue({ eligible: true, masterEnabled: true });
  api.getQuickloginOverview.mockResolvedValue(overview());
  const container = await renderUi(createElement(QuickloginSettings, { currentDeviceHint: "device-a" }));
  expect(container.textContent).not.toContain("重新连接");
});
