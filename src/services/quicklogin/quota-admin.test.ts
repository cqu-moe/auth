import { describe, expect, it, vi } from "vitest";
import { validateEntitlementItems } from "../entitlements";
import type { DeviceList, QuotaPreview } from "./contracts";
import {
  assertGenericEntitlementWriteAllowed,
  QuickloginQuotaAdminError,
  routeQuickloginEntitlementWrite,
  type QuickloginQuotaCoordinator,
} from "./quota-admin";

const PREVIEW: QuotaPreview = {
  token: "preview-token",
  expiresAt: 1_800_000_300_000,
  revision: 4,
  oldLimit: 5,
  newLimit: 3,
  kept: ["device-a", "device-b", "device-c"],
  disabled: ["device-d", "device-e"],
};

const LIST: DeviceList = {
  masterEnabled: true,
  deviceLimit: 3,
  used: 3,
  revision: 5,
  devices: [],
};

function coordinator(): QuickloginQuotaCoordinator {
  return {
    previewQuota: vi.fn().mockResolvedValue(PREVIEW),
    applyQuota: vi.fn().mockResolvedValue(LIST),
  };
}

describe("quicklogin entitlement validation", () => {
  it("rejects unlimited device quota while preserving other unlimited quotas", () => {
    expect(
      validateEntitlementItems([
        {
          subsystem: "cqu",
          capability: "quicklogin_device_limit",
          value: "",
        },
      ])
    ).toContain("非负整数");
    expect(
      validateEntitlementItems([
        { subsystem: "calendar", capability: "sub_limit", value: "" },
      ])
    ).toBeNull();
  });

  it("blocks generic replacement when incoming or existing policy rows are involved", () => {
    const quickloginLimit = {
      subsystem: "cqu",
      capability: "quicklogin_device_limit",
      value: "3",
    };
    expect(() =>
      assertGenericEntitlementWriteAllowed([quickloginLimit], [])
    ).toThrowError(
      expect.objectContaining({ code: "QUICKLOGIN_PREVIEW_REQUIRED" })
    );
    expect(() =>
      assertGenericEntitlementWriteAllowed(
        [{ subsystem: "calendar", capability: "sync", value: "1" }],
        [quickloginLimit]
      )
    ).toThrowError(
      expect.objectContaining({ code: "QUICKLOGIN_PREVIEW_REQUIRED" })
    );
  });
});

describe("routeQuickloginEntitlementWrite", () => {
  it("previews the exact device limit without forwarding actor identity", async () => {
    const client = coordinator();
    const result = await routeQuickloginEntitlementWrite({
      userId: "target-user",
      actorId: "trusted-admin",
      items: [
        {
          subsystem: "cqu",
          capability: "quicklogin_device_limit",
          value: "3",
        },
      ],
      now: 1_800_000_000_000,
      coordinator: client,
    });

    expect(result).toEqual({ kind: "preview", preview: PREVIEW });
    expect(client.previewQuota).toHaveBeenCalledWith(
      "target-user",
      3,
      1_800_000_000_000
    );
  });

  it("applies only the supplied preview token", async () => {
    const client = coordinator();
    const result = await routeQuickloginEntitlementWrite({
      userId: "target-user",
      actorId: "trusted-admin",
      items: [
        {
          subsystem: "cqu",
          capability: "quicklogin_device_limit",
          value: "3",
        },
      ],
      previewToken: "preview-token",
      now: 1_800_000_000_001,
      coordinator: client,
    });

    expect(result).toEqual({ kind: "applied", list: LIST });
    expect(client.applyQuota).toHaveBeenCalledTimes(1);
    expect(client.applyQuota).toHaveBeenCalledWith(
      "target-user",
      { token: "preview-token", newLimit: 3 },
      1_800_000_000_001
    );
  });

  it("rejects mixed and forged policy inputs before coordination", async () => {
    const client = coordinator();
    const base = {
      userId: "target-user",
      actorId: "trusted-admin",
      now: 1_800_000_000_000,
      coordinator: client,
    };

    await expect(
      routeQuickloginEntitlementWrite({
        ...base,
        items: [
          {
            subsystem: "cqu",
            capability: "quicklogin_device_limit",
            value: "3",
          },
          { subsystem: "calendar", capability: "sync", value: "1" },
        ],
      })
    ).rejects.toBeInstanceOf(QuickloginQuotaAdminError);
    await expect(
      routeQuickloginEntitlementWrite({ ...base, actorId: "", items: [] })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(client.previewQuota).not.toHaveBeenCalled();
    expect(client.applyQuota).not.toHaveBeenCalled();
  });
});
