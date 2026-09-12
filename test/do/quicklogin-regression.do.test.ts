import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { QuickloginAccountClient } from "../../src/services/quicklogin/account-client";
import type { AccountState } from "../../src/services/quicklogin/contracts";

describe("quicklogin account integration regressions", () => {
  it("keeps occupied slots and child switches while the master switch is off", async () => {
    const client = new QuickloginAccountClient(env);
    const userId = `master-cycle-${crypto.randomUUID()}`;
    await client.setMasterEnabled(userId, true);
    const preview = await client.previewQuota(userId, 1, Date.now());
    await client.applyQuota(userId, { token: preview.token, newLimit: 1 }, Date.now());
    const grant = await client.createPendingGrant(userId, "cycle-client", Date.now());
    await client.activateGrant(userId, grant.grantId, Date.now());
    const device = await client.registerDevice(userId, grant.grantId, {
      deviceName: "Cycle Chrome",
      browserFamily: "chrome",
      browserVersion: "140",
    });
    const accountStub = env.CQU_QUICKLOGIN_ACCOUNT.get(
      env.CQU_QUICKLOGIN_ACCOUNT.idFromName(userId)
    );
    await runInDurableObject(accountStub, async (_instance, state) => {
      const account = await state.storage.get<AccountState>("account");
      if (!account) throw new Error("missing account fixture");
      account.devices[device.deviceId].enabled = true;
      account.devices[device.deviceId].enabledAt = Date.now();
      await state.storage.put("account", account);
    });

    const off = await client.setMasterEnabled(userId, false);
    expect(off).toMatchObject({ masterEnabled: false, deviceLimit: 1, used: 1 });
    expect(off.devices[0]).toMatchObject({ enabled: true, revokedAt: null });
    await expect(client.getQuickloginTicketEligibility(userId)).resolves.toEqual({
      masterEnabled: false,
      deviceLimit: 1,
    });

    await expect(client.getDeviceAuthority(userId, device.deviceId)).resolves
      .toMatchObject({
        allowed: false,
        enabled: true,
        reason: "MASTER_DISABLED",
      });
  });
});
