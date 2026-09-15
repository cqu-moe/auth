import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./http";
import {
  applyQuickloginQuota,
  getQuickloginPreference,
  getQuickloginOverview,
  reconnectQuickloginDevice,
  listQuickloginDevices,
  previewQuickloginQuota,
  revokeQuickloginDevice,
} from "./quicklogin";

import { overview } from "./quicklogin.fixtures";

afterEach(() => vi.unstubAllGlobals());

describe("QuickLogin API client", () => {
  it("uses the canonical root envelope and native device DTO", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({
        data: { eligible: true, masterEnabled: true, deviceLimit: 5, used: 2 },
      }))
      .mockResolvedValueOnce(Response.json({
        masterEnabled: true, deviceLimit: 5, used: 2, revision: 4, devices: [],
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getQuickloginPreference()).resolves.toMatchObject({
      eligible: true,
      deviceLimit: 5,
    });
    await expect(listQuickloginDevices()).resolves.toMatchObject({
      revision: 4,
      devices: [],
    });
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/cqu/quicklogin",
      "/api/v1/cqu/quicklogin/devices",
    ]);
  });

  it("uses canonical admin preview/apply and handles device DELETE as 204", async () => {
    const preview = {
      token: "preview-token", expiresAt: 1_800_000_300_000, revision: 4,
      oldLimit: 5, newLimit: 3, kept: ["a", "b", "c"], disabled: ["d", "e"],
      keptDevices: [], disabledDevices: [],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: preview }))
      .mockResolvedValueOnce(Response.json({
        data: { masterEnabled: true, deviceLimit: 3, used: 3, revision: 5, devices: [] },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const received = await previewQuickloginQuota("user/a", 3);
    await applyQuickloginQuota("user/a", received);
    await revokeQuickloginDevice("device/a");

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/admin/users/user%2Fa/quicklogin-quota/preview",
      "/api/v1/admin/users/user%2Fa/quicklogin-quota",
      "/api/v1/cqu/quicklogin/devices/device%2Fa",
    ]);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ deviceLimit: 3 }),
    });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify({ token: "preview-token", newLimit: 3 }),
    });
  });

  it("preserves Problem Details extensions needed for a changed preview", async () => {
    const preview = {
      token: "latest-token", expiresAt: 1_800_000_300_000, revision: 5,
      oldLimit: 5, newLimit: 3, kept: ["b", "c", "d"], disabled: ["a", "e"],
      keptDevices: [], disabledDevices: [],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      type: "about:blank",
      title: "Conflict",
      status: 409,
      detail: "设备状态已变化",
      code: "PREVIEW_CHANGED",
      preview,
    }), {
      status: 409,
      headers: { "content-type": "application/problem+json" },
    })));

    await expect(applyQuickloginQuota("user-a", {
      ...preview,
      token: "stale-token",
      revision: 4,
    })).rejects.toMatchObject({
      status: 409,
      code: "PREVIEW_CHANGED",
      body: { preview },
    } satisfies Partial<ApiError>);
  });
});

describe("QuickLogin overview boundary", () => {
  const meta = { protocolVersion: 3, requestId: "request-a", serverTime: 1_800_000_000_000, serverBuild: "build-a" };
  it("reads and validates the v3 envelope instead of trusting a cast", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: overview(), meta })));
    await expect(getQuickloginOverview()).resolves.toMatchObject({ accountRevision: 2 });
    expect(fetch).toHaveBeenCalledWith("/api/v1/cqu/quicklogin/overview", expect.anything());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: { ...overview(), devices: [{}] }, meta })));
    await expect(getQuickloginOverview()).rejects.toMatchObject({ code: "CONTRACT_INVALID" });
  });
  it("sends an in-memory ticket to the fixed extension ID without URL or body transport", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ accepted: true, commandId: "command-a" });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: { resumeTicket: "test-only-ticket", deviceId: "device/a", expiresAt: Date.now() + 60_000 }, meta })));
    await reconnectQuickloginDevice("device/a");
    expect(fetch).toHaveBeenCalledWith("/api/v1/cqu/quicklogin/devices/device%2Fa/resume-ticket", expect.objectContaining({ method: "POST" }));
    expect(vi.mocked(fetch).mock.calls[0][1]?.body).toBeUndefined();
    expect(sendMessage).toHaveBeenCalledWith("igfidegfgfoofnoncpmbcokbffjmmook", expect.objectContaining({ type: "RESUME_DEVICE", deviceId: "device/a", resumeTicket: "test-only-ticket" }));
  });
  it("does not mint a ticket when the extension is unavailable", async () => {
    vi.stubGlobal("chrome", undefined);
    vi.stubGlobal("fetch", vi.fn());
    await expect(reconnectQuickloginDevice("device-a")).rejects.toThrow("插件");
    expect(fetch).not.toHaveBeenCalled();
  });
});

it.each(["wrong-device", "expired", "rejected"])("rejects %s resume results without treating the device as connected", async (scenario) => {
  const sendMessage = vi.fn().mockResolvedValue({ accepted: false });
  vi.stubGlobal("chrome", { runtime: { sendMessage } });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
    data: { resumeTicket: "test-only-ticket", deviceId: scenario === "wrong-device" ? "other-device" : "device-a", expiresAt: Date.now() + (scenario === "expired" ? -1 : 60_000) },
    meta: { protocolVersion: 3, requestId: "request-a", serverTime: Date.now(), serverBuild: "build-a" },
  })));
  await expect(reconnectQuickloginDevice("device-a")).rejects.toThrow();
  expect(sendMessage).toHaveBeenCalledTimes(scenario === "rejected" ? 1 : 0);
});
