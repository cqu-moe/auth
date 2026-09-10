import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import DeviceList, { isDeviceOnline, QUICKLOGIN_REVOKE_WARNING } from "./DeviceList";

describe("quicklogin settings", () => {
  it("keeps quota-zero devices manageable and shows the ownership warning", () => {
    const html = renderToStaticMarkup(createElement(DeviceList, {
      data: {
        masterEnabled: false, deviceLimit: 0, used: 0, revision: 1,
        devices: [{
          deviceId: "device-a", deviceName: "宿舍 Chrome", browserFamily: "chrome",
          browserVersion: "140", enabled: false, enabledAt: null, lastSeenAt: null,
          lastIp: null, revokedAt: null, generation: 2, disabledReason: "quota_reduced",
          appliedVersion: null, online: false,
        }],
      },
      currentDeviceHint: "device-a",
      onRevoke: async () => undefined,
    }));
    expect(html).toContain("当前插件");
    expect(html).toContain("退出设备");
    expect(html).toContain("最近 IP：暂无");
    expect(html).toContain(QUICKLOGIN_REVOKE_WARNING);
  });

  it("uses the exact ten-minute online boundary", () => {
    expect(isDeviceOnline(400_000, 1_000_000)).toBe(true);
    expect(isDeviceOnline(399_999, 1_000_000)).toBe(false);
  });
});
