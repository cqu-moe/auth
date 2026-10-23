import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "./auth";
import { createTestAuth, TEST_AUTH_ORIGIN } from "./test-utils/auth";

describe("Auth email sender configuration", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    { name: "unset default", configured: undefined, expected: "CQU Auth <noreply@auth.cqu.moe>" },
    { name: "empty fallback", configured: "", expected: "CQU Auth <noreply@auth.cqu.moe>" },
    { name: "whitespace fallback", configured: " \t\n ", expected: "CQU Auth <noreply@auth.cqu.moe>" },
    { name: "trusted override", configured: "受信任部署 <noreply@auth.cqu.moe>", expected: "受信任部署 <noreply@auth.cqu.moe>" },
    { name: "trimmed sender", configured: " 受信任部署 <noreply@auth.cqu.moe> \n", expected: "受信任部署 <noreply@auth.cqu.moe>" },
  ])("uses $name for verification OTP and password reset email", async ({ configured, expected }) => {
    const messages: { from: string; to: string; subject: string; authorization: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit) => {
      if (input !== "https://api.resend.com/emails" || init.method !== "POST") {
        throw new Error("Unexpected outbound request during Auth email test");
      }
      const { from, to, subject } = JSON.parse(init.body as string);
      messages.push({ from, to, subject, authorization: new Headers(init.headers).get("authorization")! });
      return Response.json({ id: "test-email" });
    }));

    const fixture = createTestAuth();
    const auth = createAuth({
      ...fixture.env,
      AUTH_EMAIL_FROM: configured,
    }, new Request(TEST_AUTH_ORIGIN));
    const post = (path: string, body: Record<string, string>) => auth.handler(
      new Request(`${TEST_AUTH_ORIGIN}/api/v1/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: TEST_AUTH_ORIGIN },
        body: JSON.stringify(body),
      }),
    );
    try {
      const signup = await post("/sign-up/email", {
        email: "sender-test@example.com", password: "password123", name: "Sender Test",
      });
      expect(signup.status).toBe(200);
      const reset = await post("/request-password-reset", { email: "sender-test@example.com" });
      expect(reset.status).toBe(200);
      expect(messages).toEqual([
        {
          from: expected,
          to: "sender-test@example.com",
          subject: "验证你的邮箱 - CQU Auth",
          authorization: "Bearer re_test_placeholder",
        },
        {
          from: expected,
          to: "sender-test@example.com",
          subject: "重置密码 - CQU Auth",
          authorization: "Bearer re_test_placeholder",
        },
      ]);
    } finally {
      fixture.close();
    }
  });

  it("reports password reset delivery failure when Resend returns an error", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit) => {
      if (input !== "https://api.resend.com/emails" || init.method !== "POST") {
        throw new Error("Unexpected outbound request during Auth email test");
      }
      const body = JSON.parse(init.body as string);
      if (body.subject.includes("重置密码")) {
        return Response.json({
          name: "validation_error",
          statusCode: 422,
          message: "invalid sender",
        }, { status: 422 });
      }
      return Response.json({ data: { id: "test-email" }, error: null });
    }));

    const fixture = createTestAuth();
    const auth = createAuth(fixture.env, new Request(TEST_AUTH_ORIGIN));
    try {
      const signup = await auth.handler(new Request(`${TEST_AUTH_ORIGIN}/api/v1/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: TEST_AUTH_ORIGIN },
        body: JSON.stringify({
          email: "resend-failure@example.com",
          password: "password123",
          name: "Resend Failure",
        }),
      }));
      expect(signup.status).toBe(200);

      const reset = await auth.handler(new Request(`${TEST_AUTH_ORIGIN}/api/v1/auth/request-password-reset`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: TEST_AUTH_ORIGIN },
        body: JSON.stringify({ email: "resend-failure@example.com" }),
      }));
      expect(reset.status).toBe(200);
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(consoleError.mock.calls[0]?.[1]).toBeInstanceOf(Error);
      expect(consoleError.mock.calls[0]?.[1]).toHaveProperty(
        "message",
        "Resend email delivery failed: invalid sender",
      );
    } finally {
      consoleError.mockRestore();
      fixture.close();
    }
  });
});
