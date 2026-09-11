import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app";
import { createHttpFixture } from "../../test-utils/http";

const verifyAccessToken = vi.hoisted(() => vi.fn());
vi.mock("better-auth/oauth2", () => ({ verifyAccessToken }));

describe("service ticket API v1", () => {
  beforeEach(() => verifyAccessToken.mockReset());

  it("issues through one bearer verification and one DO call", async () => {
    const fixture = createHttpFixture();
    try {
      verifyAccessToken.mockResolvedValue({
        sub: "ticket-user",
        azp: "ticket-client",
        scope: "cqu:ticket:jwxt",
      });
      await fixture.env.DATABASE.prepare(
        "INSERT INTO oauth_client_cqu_scopes (client_id, scope) VALUES (?, ?)"
      ).bind("ticket-client", "cqu:ticket:jwxt").run();
      fixture.doFetch.mockResolvedValue(Response.json({ ticket: "ST-local" }));

      const response = await createApp().request("/api/v1/cqu/service-tickets", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer local" },
        body: JSON.stringify({ service: "jwxt" }),
      }, fixture.env);

      expect(response.status).toBe(201);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ data: { ticket: "ST-local" } });
      expect(verifyAccessToken).toHaveBeenCalledTimes(1);
      expect(fixture.doFetch).toHaveBeenCalledTimes(1);
    } finally {
      await fixture.close();
    }
  });

  it("rejects GET and ambiguous targets before auth or DO work", async () => {
    const fixture = createHttpFixture();
    try {
      const app = createApp();
      const get = await app.request("/api/v1/cqu/service-tickets", {}, fixture.env);
      expect(get.status).toBe(405);
      expect(get.headers.get("allow")).toBe("POST, OPTIONS");

      const ambiguous = await app.request("/api/v1/cqu/service-tickets", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer local" },
        body: JSON.stringify({ service: "jwxt", serviceUrl: "https://my.cqu.edu.cn/" }),
      }, fixture.env);
      expect(ambiguous.status).toBe(400);
      expect(await ambiguous.json()).toMatchObject({ code: "INVALID_TARGET" });
      expect(verifyAccessToken).not.toHaveBeenCalled();
      expect(fixture.doFetch).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  });
});
