import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { createAuth } from "../../src/auth";
import { createApiFixture } from "./api-fixture";

describe("Better Auth v1 migration", () => {
  it("uses one session across canonical and legacy get-session endpoints", async () => {
    const fixture = await createApiFixture();
    try {
      const headers = await fixture.signIn("user");
      const canonical = await fixture.request("/api/v1/auth/get-session", { headers });
      const legacy = await fixture.request("/api/auth/get-session", { headers });
      expect(canonical.status).toBe(200);
      expect(legacy.status).toBe(200);
      const canonicalBody = await canonical.json() as { user: { id: string }; caps: unknown };
      const legacyBody = await legacy.json() as { user: { id: string }; caps: unknown };
      expect(legacyBody.user.id).toBe(canonicalBody.user.id);
      expect(canonicalBody).toHaveProperty("caps");
      expect(canonicalBody).not.toHaveProperty("caps.cqu");
    } finally {
      await fixture.close();
    }
  });

  it("keeps stable issuer discovery while advertising canonical endpoints", async () => {
    const fixture = await createApiFixture();
    try {
      for (const path of [
        "/.well-known/oauth-authorization-server",
        "/api/auth/.well-known/openid-configuration",
        "/.well-known/oauth-authorization-server/api/auth",
      ]) {
        const response = await fixture.request(path);
        expect(response.status, path).toBe(200);
        expect(await response.json(), path).toMatchObject({
          issuer: "http://localhost:8787/api/auth",
          authorization_endpoint: "http://localhost:8787/api/v1/auth/oauth2/authorize",
          token_endpoint: "http://localhost:8787/api/v1/auth/oauth2/token",
          jwks_uri: "http://localhost:8787/api/v1/auth/jwks",
        });
      }
    } finally {
      await fixture.close();
    }
  });

  it("signs and verifies local bearer tokens against the stable identity", async () => {
    const fixture = await createApiFixture();
    try {
      const headers = await fixture.issueToken({
        scopes: ["cqu:ticket:jwxt"],
        clientId: "migration-client",
        userId: "migration-user",
      });
      const token = headers.get("authorization")!.slice("Bearer ".length);
      const auth = createAuth(env, new Request("http://localhost:8787/api/v1/auth/jwks"));
      const verified = await auth.api.verifyJWT({
        body: { token, issuer: "http://localhost:8787/api/auth" },
      });
      expect(verified.payload).toMatchObject({
        sub: "migration-user",
        aud: "http://localhost:8787/api/auth",
        iss: "http://localhost:8787/api/auth",
        azp: "migration-client",
        scope: "cqu:ticket:jwxt",
      });
      const rejected = await auth.api.verifyJWT({
        body: { token, issuer: "https://wrong.example/api/auth" },
      });
      expect(rejected.payload).toBeNull();
    } finally {
      await fixture.close();
    }
  });

  it("shares the OTP rate-limit bucket between canonical and legacy paths", async () => {
    const fixture = await createApiFixture();
    try {
      const headers = await fixture.signIn("user");
      const session = await fixture.request("/api/v1/auth/get-session", { headers })
        .then((response) => response.json() as Promise<{ user: { email: string } }>);
      headers.set("content-type", "application/json");
      headers.set("origin", "http://localhost:8787");
      headers.set("cf-connecting-ip", "198.51.100.10");
      const body = JSON.stringify({
        email: session.user.email,
        type: "email-verification",
      });
      const paths = [
        "/api/v1/auth/email-otp/send-verification-otp",
        "/api/auth/email-otp/send-verification-otp",
        "/api/v1/auth/email-otp/send-verification-otp",
        "/api/auth/email-otp/send-verification-otp",
      ];
      const statuses = [];
      for (const path of paths) {
        statuses.push((await fixture.request(path, { method: "POST", headers, body })).status);
      }
      expect(statuses).toEqual([200, 200, 200, 429]);
    } finally {
      await fixture.close();
    }
  });
});
