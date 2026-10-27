import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TURNSTILE_ACTIONS,
  TURNSTILE_TOKEN_HEADER,
} from "../../../shared/turnstile";
import { createApp } from "../../app";
import { createHttpFixture } from "../../test-utils/http";

const authHandler = vi.hoisted(() => vi.fn());

vi.mock("../../auth", () => ({
  createAuth: () => ({
    handler: authHandler,
    api: { getSession: async () => null },
  }),
}));

const TEST_SECRET = "test-turnstile-secret";
const OFFICIAL_TEST_SECRETS = [
  "1x0000000000000000000000000000000AA",
  "2x0000000000000000000000000000000AA",
  "3x0000000000000000000000000000000AA",
];
const TOKEN = "verified-turnstile-token";
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

function successPayload(action: string, hostname = "localhost") {
  return {
    success: true,
    action,
    hostname,
    "error-codes": [],
  };
}

function envWithSecret(
  fixture: ReturnType<typeof createHttpFixture>,
  secret = TEST_SECRET
) {
  return { ...fixture.env, TURNSTILE_SECRET: secret };
}

async function seedInvitation(env: ReturnType<typeof createHttpFixture>["env"], code: string) {
  await env.DATABASE.prepare(
    `INSERT INTO registration_invitation
       (code, created_by, created_at, expires_at, preset)
     VALUES (?, ?, ?, ?, NULL)`
  )
    .bind(code, "admin", new Date().toISOString(), new Date(Date.now() + 3600_000).toISOString())
    .run();
}

describe("Turnstile protection at the auth route boundary", () => {
  let fixture: ReturnType<typeof createHttpFixture>;
  let siteverify: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fixture = createHttpFixture();
    siteverify = vi.fn();
    vi.stubGlobal("fetch", siteverify);
    authHandler.mockImplementation(async () =>
      Response.json({ user: { id: "handler-user" } })
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    await fixture.close();
  });

  it("fails closed when the runtime secret is absent", async () => {
    const response = await createApp().request("/api/v1/auth/sign-in/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [TURNSTILE_TOKEN_HEADER]: TOKEN,
      },
      body: "{}",
    }, fixture.env);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "TURNSTILE_UNAVAILABLE",
      message: "安全验证服务暂不可用，请稍后重试",
    });
    expect(siteverify).not.toHaveBeenCalled();
    expect(authHandler).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined, "TURNSTILE_REQUIRED"],
    ["blank", "   ", "TURNSTILE_REQUIRED"],
    ["over 2048 characters", "x".repeat(2049), "TURNSTILE_FAILED"],
  ] as const)(
    "rejects a %s token before siteverify",
    async (_name, token, code) => {
      const response = await createApp().request("/api/v1/auth/sign-in/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token === undefined ? {} : { [TURNSTILE_TOKEN_HEADER]: token }),
        },
        body: "{}",
      }, envWithSecret(fixture));

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code });
      expect(siteverify).not.toHaveBeenCalled();
      expect(authHandler).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["an invalid token", { success: false, "error-codes": ["invalid-input-response"] }],
    ["a reused or expired token", { success: false, "error-codes": ["timeout-or-duplicate"] }],
    ["the wrong action", successPayload("password-reset")],
    ["the wrong hostname", successPayload("password-login", " attacker.test")],
  ])("rejects %s without reaching Better Auth", async (_name, payload) => {
    siteverify.mockResolvedValue(Response.json(payload));
    const response = await createApp().request("/api/v1/auth/sign-in/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [TURNSTILE_TOKEN_HEADER]: TOKEN,
      },
      body: "{}",
    }, envWithSecret(fixture));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "TURNSTILE_FAILED" });
    expect(siteverify).toHaveBeenCalledTimes(1);
    expect(authHandler).not.toHaveBeenCalled();
  });

  it.each([
    ["network failure", vi.fn(async () => {
      throw new Error("network unavailable");
    })],
    ["an upstream server error", vi.fn(async () => new Response("error", { status: 500 }))],
    ["invalid JSON", vi.fn(async () => new Response("not json", { status: 200 }))],
    ["JSON null", vi.fn(async () => Response.json(null))],
    ["a JSON array", vi.fn(async () => Response.json([]))],
    ["a JSON primitive", vi.fn(async () => Response.json("invalid"))],
  ])("maps %s to an unavailable response", async (_name, fetchMock) => {
    vi.stubGlobal("fetch", fetchMock);
    const response = await createApp().request("/api/v1/auth/sign-in/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [TURNSTILE_TOKEN_HEADER]: TOKEN,
      },
      body: "{}",
    }, envWithSecret(fixture));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "TURNSTILE_UNAVAILABLE" });
    expect(authHandler).not.toHaveBeenCalled();
  });

  it.each(["sequential", "concurrent", "another email endpoint"])(
    "rejects %s redemption even when Siteverify accepts a reused token",
    async mode => {
      const email = mode === "another email endpoint";
      const firstPath = email ? "/send-verification-email" : "/sign-in/email";
      const secondPath = email ? "/email-otp/send-verification-otp" : firstPath;
      siteverify.mockImplementation(async () => Response.json(
        successPayload(email ? "email-verification" : "password-login")
      ));
      authHandler.mockImplementation(async () => Response.json(
        { code: "INVALID_EMAIL_OR_PASSWORD" }, { status: 401 }
      ));
      const submit = (path: string, token = TOKEN) => createApp().request(
        `/api/v1/auth${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", [TURNSTILE_TOKEN_HEADER]: token },
          body: "{}",
        }, envWithSecret(fixture)
      );

      const first = submit(firstPath);
      if (mode !== "concurrent") await first;
      const responses = await Promise.all([first, submit(secondPath)]);
      expect(responses.map(response => response.status).sort()).toEqual([401, 403]);
      expect(await responses.find(response => response.status === 403)!.json())
        .toMatchObject({ code: "TURNSTILE_FAILED" });
      expect(authHandler).toHaveBeenCalledTimes(1);

      expect((await submit(firstPath, "fresh-token")).status).toBe(401);
      expect(authHandler).toHaveBeenCalledTimes(2);
    }
  );

  it("fails closed if the redemption store is unavailable", async () => {
    siteverify.mockImplementation(async () => Response.json(successPayload("password-login")));
    await fixture.env.DATABASE.exec("DROP TABLE turnstile_redemption");
    const response = await createApp().request("/api/v1/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", [TURNSTILE_TOKEN_HEADER]: TOKEN },
      body: "{}",
    }, envWithSecret(fixture));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "TURNSTILE_UNAVAILABLE" });
    expect(authHandler).not.toHaveBeenCalled();
  });

  it("bounds expiry cleanup and retains only a token hash for the full validity window", async () => {
    siteverify.mockImplementation(async () => Response.json(successPayload("password-login")));
    const database = fixture.env.DATABASE;
    await database.batch(Array.from({ length: 101 }, (_, index) => database.prepare(
      "INSERT INTO turnstile_redemption (token_hash, expires_at) VALUES (?, ?)"
    ).bind(`expired-${index}`, Date.now() - 60_000)));
    const submit = () => createApp().request("/api/v1/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", [TURNSTILE_TOKEN_HEADER]: TOKEN },
      body: "{}",
    }, envWithSecret(fixture));
    const before = Date.now();
    expect((await submit()).status).toBe(200);
    const rows = await database.prepare("SELECT * FROM turnstile_redemption")
      .all<{ token_hash: string; expires_at: number }>();
    expect(rows.results).toHaveLength(2);
    const live = rows.results.find(row => row.expires_at > before)!;
    expect(live).toEqual({ token_hash: expect.stringMatching(/^[a-f0-9]{64}$/), expires_at: expect.any(Number) });
    expect(live.expires_at).toBeGreaterThanOrEqual(before + 300_000);
    expect((await submit()).status).toBe(403);
    expect(authHandler).toHaveBeenCalledTimes(1);
    expect(await database.prepare("SELECT * FROM turnstile_redemption").all())
      .toMatchObject({ results: [live] });
  });

  it.each(OFFICIAL_TEST_SECRETS)(
    "refuses official test secret %s in production",
    async secret => {
      const response = await createApp().request("/api/v1/auth/sign-in/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [TURNSTILE_TOKEN_HEADER]: TOKEN,
        },
        body: "{}",
      }, {
        ...envWithSecret(fixture, secret),
        ENVIRONMENT: "production",
      });

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "TURNSTILE_UNAVAILABLE" });
      expect(siteverify).not.toHaveBeenCalled();
      expect(authHandler).not.toHaveBeenCalled();
    }
  );

  it("refuses a production loopback hostname before siteverify", async () => {
    const response = await createApp().request("/api/v1/auth/sign-in/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [TURNSTILE_TOKEN_HEADER]: TOKEN,
      },
      body: "{}",
    }, {
      ...envWithSecret(fixture),
      ENVIRONMENT: "production",
      BETTER_AUTH_URL: "https://localhost",
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "TURNSTILE_UNAVAILABLE" });
    expect(siteverify).not.toHaveBeenCalled();
    expect(authHandler).not.toHaveBeenCalled();
  });

  it("protects the six exact POST operations and forwards valid verifications", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const actionForPath = new Map(Object.entries(TURNSTILE_ACTIONS));
    siteverify.mockImplementation(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        secret: string;
        response: string;
      };
      const action = actionForPath.get(body.response.replace("token-", ""));
      return Response.json({
        success: true,
        action,
        hostname: "localhost",
        "error-codes": [],
      });
    });

    const app = createApp();
    try {
      await seedInvitation(fixture.env, "ABCDEFGH");
      for (const path of Object.keys(TURNSTILE_ACTIONS)) {
        authHandler.mockClear();
        siteverify.mockClear();
        timeoutSpy.mockClear();
        const token = `token-${path}`;
        const response = await app.request(`/api/v1/auth${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [TURNSTILE_TOKEN_HEADER]: token,
          },
          body: JSON.stringify(path === "/sign-up/email"
            ? { email: "new-user@example.test", password: "valid-password", code: "ABCDEFGH" }
            : {}),
        }, envWithSecret(fixture));

        expect(response.status, path).toBe(200);
        expect(await response.json(), path).toMatchObject({
          user: { id: "handler-user" },
        });
        expect(authHandler, path).toHaveBeenCalledTimes(1);
        expect(siteverify, path).toHaveBeenCalledTimes(1);

        const [url, init] = siteverify.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(SITEVERIFY_URL);
        expect(init.method).toBe("POST");
        expect(JSON.parse(String(init.body))).toEqual({
          secret: TEST_SECRET,
          response: token,
        });
        expect(init.signal).toBeInstanceOf(AbortSignal);
        expect(timeoutSpy, path).toHaveBeenCalledWith(10_000);
      }
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("does not consume a registration invitation when verification fails", async () => {
    await seedInvitation(fixture.env, "ABCDEFGH");
    siteverify.mockResolvedValue(Response.json({
      success: false,
      "error-codes": ["invalid-input-response"],
    }));
    const response = await createApp().request("/api/v1/auth/sign-up/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [TURNSTILE_TOKEN_HEADER]: TOKEN,
      },
      body: JSON.stringify({
        email: "new-user@example.test",
        password: "valid-password",
        code: "ABCDEFGH",
      }),
    }, envWithSecret(fixture));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "TURNSTILE_FAILED" });
    expect(authHandler).not.toHaveBeenCalled();
    const invitation = await fixture.env.DATABASE.prepare(
      `SELECT claimed_at, claim_token, used_at, used_by_user_id
         FROM registration_invitation WHERE code = ?`
    ).bind("ABCDEFGH").first<{
      claimed_at: string | null;
      claim_token: string | null;
      used_at: string | null;
      used_by_user_id: string | null;
    }>();
    expect(invitation).toMatchObject({
      claimed_at: null,
      claim_token: null,
      used_at: null,
      used_by_user_id: null,
    });
  });

  it.each([
    ["/passkey/verify-authentication", "passkey"],
    ["/oauth2/token", "machine OAuth"],
  ])("keeps %s requests exempt", async (path, description) => {
    const response = await createApp().request(`/api/v1/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }, envWithSecret(fixture));

    expect(response.status, description).toBe(200);
    expect(siteverify, description).not.toHaveBeenCalled();
    expect(authHandler, description).toHaveBeenCalledTimes(1);
  });
});
