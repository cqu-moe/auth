import { env, reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuickloginAccountClient } from "../../src/services/quicklogin/account-client";
import { freshStub, seedSession, spyBrowserFetch } from "./helpers";

afterEach(async () => {
  await reset();
  vi.restoreAllMocks();
});

describe("friends service tickets", () => {
  it("uses the exact CAS service with QuickLogin off while broad tickets remain gated", async () => {
    const stub = freshStub("friends");
    await seedSession(stub);
    const eligibility = await new QuickloginAccountClient(env).getQuickloginTicketEligibility("u1");
    expect(eligibility.masterEnabled).toBe(false);
    const targets: string[] = [];
    spyBrowserFetch({
      "/service-ticket": async (request) => {
        targets.push((await request.json<{ serviceUrl: string }>()).serviceUrl);
        return Response.json({ ok: true, ticket: "ST-local-friends" });
      },
    });

    const response = await stub.fetch("https://do/service-ticket?service=friends&clientId=friends-client&source=route");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ticket: "ST-local-friends" });
    expect(targets).toEqual(["https://friends.cqu.edu.cn/mobile/sso"]);

    const broad = await stub.fetch("https://do/service-ticket?serviceUrl=https%3A%2F%2Ffriends.cqu.edu.cn%2Fmobile%2Fsso&clientId=friends-client&source=route");
    expect(broad.status).toBe(403);
    expect(await broad.json()).toMatchObject({ code: "QUICKLOGIN_NOT_ENABLED" });
    expect(targets).toHaveLength(1);
  });

  it.each([
    { limit: "client", count: 30, clientId: "friends-client" },
    { limit: "user", count: 60, clientId: "another-client" },
  ])("enforces the shared $limit rate limit before minting", async ({ count, clientId }) => {
    const stub = freshStub("friends-rate-limit");
    await seedSession(stub, {
      extra: {
        stMintLog: Array.from({ length: count }, () => ({
          ts: Date.now(), clientId, host: "my.cqu.edu.cn", broad: false,
        })),
      },
    });
    const browser = spyBrowserFetch({});
    const response = await stub.fetch("https://do/service-ticket?service=friends&clientId=friends-client");
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: "RATE_LIMITED" });
    expect(browser).not.toHaveBeenCalled();
  });

  it("withholds a minted ticket when the binding is revoked during the browser request", async () => {
    const stub = freshStub("friends-revoked-in-flight");
    await seedSession(stub);
    const browser = spyBrowserFetch({
      "/service-ticket": async () => {
        await env.DATABASE.prepare("UPDATE cqu_bind_addresses SET status = 'revoked' WHERE user_id = 'u1'").run();
        return Response.json({ ok: true, ticket: "ST-withheld" });
      },
    });
    const response = await stub.fetch("https://do/service-ticket?service=friends&clientId=friends-client");
    expect(browser).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({ code: "SESSION_INACTIVE" });
    expect(body).not.toHaveProperty("ticket");
  });
});
