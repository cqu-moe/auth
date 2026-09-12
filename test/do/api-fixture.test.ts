import { describe, expect, it } from "vitest";
import { createApiFixture } from "./api-fixture";

describe("API integration fixture", () => {
  it("creates an isolated local session and signs a locally verifiable bearer", async () => {
    const fixture = await createApiFixture();
    try {
      const sessionHeaders = await fixture.signIn("user");
      const sessionResponse = await fixture.request("/api/v1/auth/get-session", {
        headers: sessionHeaders,
      });
      expect(sessionResponse.status).toBe(200);
      const session = await sessionResponse.json() as { user: { id: string } };
      expect(session.user.id).toBeTruthy();

      const bearer = await fixture.issueToken({
        scopes: ["cqu:ticket:jwxt"],
        clientId: "fixture-client",
        userId: session.user.id,
      });
      expect(bearer.get("authorization")).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
    } finally {
      await fixture.close();
    }
  });
});
