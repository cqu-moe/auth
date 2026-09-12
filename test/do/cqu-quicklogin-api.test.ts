import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { createApiFixture } from "./api-fixture";

describe("CQU quicklogin preference API v1", () => {
  it("reports ineligible without creating account state and gates website device access", async () => {
    env.QUICKLOGIN_DEVICE_MODE = "on";
    const fixture = await createApiFixture();
    try {
      const sessionHeaders = await fixture.signIn("user");
      const session = await fixture.request("/api/v1/auth/get-session", {
        headers: sessionHeaders,
      }).then((response) => response.json() as Promise<{ user: { id: string } }>);

      const preference = await fixture.request("/api/v1/cqu/quicklogin", {
        headers: sessionHeaders,
      });
      expect(preference.status).toBe(200);
      expect(await preference.json()).toEqual({ data: { eligible: false } });

      const devices = await fixture.request("/api/v1/cqu/quicklogin/devices", {
        headers: sessionHeaders,
      });
      expect(devices.status).toBe(403);

      const deleteHeaders = new Headers(sessionHeaders);
      deleteHeaders.set("origin", env.BETTER_AUTH_URL);
      const revoked = await fixture.request(
        "/api/v1/cqu/quicklogin/devices/nonexistent-device",
        { method: "DELETE", headers: deleteHeaders }
      );
      expect(revoked.status).toBe(403);

      const stub = env.CQU_QUICKLOGIN_ACCOUNT.get(
        env.CQU_QUICKLOGIN_ACCOUNT.idFromName(session.user.id)
      );
      await expect(runInDurableObject(stub, async (_instance, state) => ({
        owner: await state.storage.get("ownerUserId"),
        account: await state.storage.get("account"),
      }))).resolves.toEqual({ owner: undefined, account: undefined });
    } finally {
      await fixture.close();
    }
  });

  it("keeps eligible/enabled compatibility while device mode is off", async () => {
    env.QUICKLOGIN_DEVICE_MODE = "off";
    const fixture = await createApiFixture();
    try {
      const sessionHeaders = await fixture.signIn("user");
      const initial = await fixture.request("/api/v1/cqu/quicklogin", {
        headers: sessionHeaders,
      });
      expect(initial.status).toBe(200);
      expect(await initial.json()).toEqual({ data: { eligible: false, enabled: false } });

      const writeHeaders = new Headers(sessionHeaders);
      writeHeaders.set("content-type", "application/json");
      writeHeaders.set("origin", env.BETTER_AUTH_URL);
      const denied = await fixture.request("/api/v1/cqu/quicklogin", {
        method: "PUT",
        headers: writeHeaders,
        body: JSON.stringify({ enabled: true }),
      });
      expect(denied.status).toBe(403);

      const bearer = await fixture.issueToken({
        scopes: ["cqu:ticket:any"],
        clientId: "quicklogin-client",
        userId: "other-user",
      });
      const bearerOnly = await fixture.request("/api/v1/cqu/quicklogin", { headers: bearer });
      expect(bearerOnly.status).toBe(401);
    } finally {
      env.QUICKLOGIN_DEVICE_MODE = "on";
      await fixture.close();
    }
  });
});
