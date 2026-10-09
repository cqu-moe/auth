import { applyD1Migrations, env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createAuth } from "../../src/auth";
import { createApp } from "../../src/app";
import { createOAuthFixture, OTHER_CLIENT_ID } from "./quicklogin-oauth-fixture";

beforeAll(async () => applyD1Migrations(env.DATABASE, env.TEST_MIGRATIONS));
afterEach(() => vi.restoreAllMocks());

// HTTP is the agreed seam: real signing, JWKS verification and D1 state;
// only school ticket issuance is replaced, so the test cannot contact CAS.
describe("existing bearer tokens observe current account and client state", () => {
  it("stops school-ticket access immediately for bans and disabled/deleted identities", async () => {
    const fixture = await createOAuthFixture(env);
    const userId = fixture.websiteSession.userId;
    const auth = createAuth(env, new Request(`${env.BETTER_AUTH_URL}/api/v1/auth/jwks`));
    const ctx = await auth.$context;
    const signed = await auth.api.signJWT({ body: {
      payload: { sid: (await ctx.adapter.findOne<{ id: string }>({ model: "session", where: [{ field: "userId", value: userId }] }))!.id, sub: userId, azp: OTHER_CLIENT_ID, scope: "cqu:ticket:jwxt" },
      overrideOptions: { jwt: {
        issuer: `${env.BETTER_AUTH_URL}/api/auth`,
        audience: `${env.BETTER_AUTH_URL}/api/auth`, expirationTime: "15m",
      } },
    } });
    await env.DATABASE.prepare("INSERT INTO oauth_client_cqu_scopes (client_id, scope) VALUES (?, ?)")
      .bind(OTHER_CLIENT_ID, "cqu:ticket:jwxt").run();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      if (request.url !== `${env.BETTER_AUTH_URL}/api/v1/auth/jwks`) throw new Error("unexpected outbound request");
      return auth.handler(request);
    });
    const mint = vi.fn(async () => Response.json({ ticket: "ST-test" }));
    const app = createApp();
    const request = () => app.request("/api/v1/cqu/service-tickets", {
      method: "POST", headers: { authorization: `Bearer ${signed.token}`, "content-type": "application/json" },
      body: JSON.stringify({ service: "jwxt" }),
    }, { ...env, CQU_SESSION: {
      idFromName: (id: string) => id, get: () => ({ fetch: mint }),
    } as unknown as DurableObjectNamespace });
    expect((await request()).status).toBe(201);
    await ctx.adapter.update({ model: "user", where: [{ field: "id", value: userId }], update: { banned: true } });
    expect((await request()).status).toBe(401);
    expect(mint).toHaveBeenCalledTimes(1);
    await ctx.adapter.update({ model: "user", where: [{ field: "id", value: userId }], update: { banExpires: new Date(Date.now() - 60_000) } });
    expect((await request()).status).toBe(201);
    await ctx.adapter.update({ model: "oauthClient", where: [{ field: "clientId", value: OTHER_CLIENT_ID }], update: { disabled: true } });
    expect((await request()).status).toBe(401);
    expect(mint).toHaveBeenCalledTimes(2);
    await ctx.adapter.update({ model: "oauthClient", where: [{ field: "clientId", value: OTHER_CLIENT_ID }], update: { disabled: false } });
    expect((await request()).status).toBe(201);
    await ctx.adapter.delete({ model: "user", where: [{ field: "id", value: userId }] });
    expect((await request()).status).toBe(401);
    expect(mint).toHaveBeenCalledTimes(3);
  });
});
