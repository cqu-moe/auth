import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { createApiFixture } from "./api-fixture";

describe("CQU quicklogin preference API v1", () => {
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
