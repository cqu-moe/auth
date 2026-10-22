import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app";
import { createHttpFixture } from "../../test-utils/http";

const verifyAuthAccessTokenRequest = vi.hoisted(() => vi.fn());
vi.mock("../../services/auth-access-token", () => ({ verifyAuthAccessTokenRequest }));

describe("service ticket API v1", () => {
  beforeEach(() => verifyAuthAccessTokenRequest.mockReset());

  it.each(["jwxt", "friends"])("issues %s through one bearer verification and one DO call", async (service) => {
    const fixture = createHttpFixture();
    fixture.seedBearerIdentity("ticket-user", "ticket-client");
    try {
      verifyAuthAccessTokenRequest.mockResolvedValue({
        sub: "ticket-user", sid: "session-ticket-user",
        azp: "ticket-client",
        scope: `cqu:ticket:${service}`,
      });
      await fixture.env.DATABASE.prepare(
        "INSERT INTO oauth_client_cqu_scopes (client_id, scope) VALUES (?, ?)"
      ).bind("ticket-client", `cqu:ticket:${service}`).run();
      fixture.doFetch.mockResolvedValue(Response.json({ ticket: "ST-local" }));

      const response = await createApp().request("/api/v1/cqu/service-tickets", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer local" },
        body: JSON.stringify({ service }),
      }, fixture.env);

      expect(response.status).toBe(201);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ data: { ticket: "ST-local" } });
      expect(verifyAuthAccessTokenRequest).toHaveBeenCalledTimes(1);
      expect(fixture.doFetch).toHaveBeenCalledTimes(1);
    } finally {
      await fixture.close();
    }
  });

  it.each([
    { name: "missing token scope", scope: "", granted: ["cqu:ticket:friends"], target: { service: "friends" } },
    { name: "missing client grant", scope: "cqu:ticket:friends", granted: [], target: { service: "friends" } },
    { name: "another service's client grant", scope: "cqu:ticket:friends", granted: ["cqu:ticket:jwxt"], target: { service: "friends" } },
    { name: "friends token used for jwxt", scope: "cqu:ticket:friends", granted: ["cqu:ticket:jwxt"], target: { service: "jwxt" } },
    { name: "friends token used for a URL", scope: "cqu:ticket:friends", granted: ["cqu:ticket:any"], target: { serviceUrl: "https://friends.cqu.edu.cn/mobile/sso" } },
    { name: "friends grant used for a URL", scope: "cqu:ticket:any", granted: ["cqu:ticket:friends"], target: { serviceUrl: "https://friends.cqu.edu.cn/mobile/sso" } },
  ])("rejects $name before minting", async ({ scope, granted, target }) => {
    const fixture = createHttpFixture();
    fixture.seedBearerIdentity("ticket-user", "ticket-client");
    try {
      verifyAuthAccessTokenRequest.mockResolvedValue({
        sub: "ticket-user", sid: "session-ticket-user", azp: "ticket-client", scope,
      });
      for (const grant of granted) {
        await fixture.env.DATABASE.prepare(
          "INSERT INTO oauth_client_cqu_scopes (client_id, scope) VALUES (?, ?)"
        ).bind("ticket-client", grant).run();
      }
      const response = await createApp().request("/api/v1/cqu/service-tickets", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer local" },
        body: JSON.stringify(target),
      }, fixture.env);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "FORBIDDEN" });
      expect(fixture.doFetch).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  });

  it("rejects GET before routing and ambiguous targets after authentication but before DO work", async () => {
    const fixture = createHttpFixture();
    fixture.seedBearerIdentity("ticket-user", "ticket-client");
    try {
      const app = createApp();
      const get = await app.request("/api/v1/cqu/service-tickets", {}, fixture.env);
      expect(get.status).toBe(405);
      expect(get.headers.get("allow")).toBe("POST, OPTIONS");

      verifyAuthAccessTokenRequest.mockResolvedValue({
        sub: "ticket-user", sid: "session-ticket-user",
        azp: "ticket-client",
        scope: "cqu:ticket:friends",
      });

      const ambiguous = await app.request("/api/v1/cqu/service-tickets", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer local" },
        body: JSON.stringify({ service: "friends", serviceUrl: "https://friends.cqu.edu.cn/mobile/sso" }),
      }, fixture.env);
      expect(ambiguous.status).toBe(400);
      expect(await ambiguous.json()).toMatchObject({ code: "INVALID_TARGET" });
      expect(verifyAuthAccessTokenRequest).toHaveBeenCalledTimes(1);
      expect(fixture.doFetch).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  });
});
