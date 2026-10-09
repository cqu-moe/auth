import { beforeEach, describe, expect, it, vi } from "vitest";
import { cqu } from "../routes/cqu";
import { createHttpFixture } from "../test-utils/http";

const verifyAuthAccessTokenRequest = vi.hoisted(() => vi.fn());

vi.mock("../services/auth-access-token", () => ({ verifyAuthAccessTokenRequest }));

describe("request authentication", () => {
  beforeEach(() => verifyAuthAccessTokenRequest.mockReset());

  it("verifies one bearer exactly once before scope and ticket handling", async () => {
    const fixture = createHttpFixture();
    fixture.seedBearerIdentity("user-a", "client-a");
    try {
      verifyAuthAccessTokenRequest.mockResolvedValue({
        sub: "user-a", sid: "session-user-a",
        azp: "client-a",
        scope: "cqu:ticket:jwxt",
      });
      await fixture.env.DATABASE.prepare(
        "INSERT INTO oauth_client_cqu_scopes (client_id, scope) VALUES (?, ?)"
      ).bind("client-a", "cqu:ticket:jwxt").run();
      fixture.doFetch.mockResolvedValue(Response.json({ ticket: "ST-local" }));

      const response = await cqu.request("/service-ticket?service=jwxt", {
        headers: { authorization: "Bearer local-token" },
      }, fixture.env);

      expect(response.status).toBe(200);
      expect(verifyAuthAccessTokenRequest).toHaveBeenCalledTimes(1);
      expect(fixture.doFetch).toHaveBeenCalledTimes(1);
    } finally {
      await fixture.close();
    }
  });

  it("rejects a verified payload without a client identity before database or DO access", async () => {
    const fixture = createHttpFixture();
    try {
      verifyAuthAccessTokenRequest.mockResolvedValue({
        sub: "user-a", sid: "session-user-a",
        scope: "cqu:ticket:jwxt",
      });

      const response = await cqu.request("/service-ticket?service=jwxt", {
        headers: { authorization: "Bearer local-token" },
      }, fixture.env);

      expect(response.status).toBe(401);
      expect(fixture.doFetch).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  });
});
