import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { QuickloginAccountClient } from "../../src/services/quicklogin/account-client";

describe("quicklogin policy initialization", () => {
  it("is idempotent for the same migration and preserves registered devices", async () => {
    const client = new QuickloginAccountClient(env);
    const userId = `migration-${crypto.randomUUID()}`;
    const grant = await client.createPendingGrant(userId, "migration-client", Date.now());
    await client.activateGrant(userId, grant.grantId, Date.now());
    const device = await client.registerDevice(userId, grant.grantId, {
      deviceName: "Existing Chrome", browserFamily: "chrome", browserVersion: "140",
    });

    const input = {
      migrationId: "quicklogin-devices-2026-09-09",
      deviceLimit: 3,
      masterEnabled: true,
    };
    await client.initializeQuickloginPolicy(userId, input);
    await client.initializeQuickloginPolicy(userId, input);

    const list = await client.listDevices(userId, Date.now());
    expect(list).toMatchObject({ masterEnabled: true, deviceLimit: 3 });
    expect(list.devices.map((entry) => entry.deviceId)).toContain(device.deviceId);
    await expect(client.initializeQuickloginPolicy(userId, {
      ...input, deviceLimit: 4,
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});
