import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "./auth";
import { createTestAuth, TEST_AUTH_ORIGIN } from "./test-utils/auth";

describe("Auth email sender configuration", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    { name: "unset default", configured: undefined, expected: "auth.cqu.moe <noreply@cqu.moe>" },
    { name: "empty fallback", configured: "", expected: "auth.cqu.moe <noreply@cqu.moe>" },
    { name: "whitespace fallback", configured: " \t\n ", expected: "auth.cqu.moe <noreply@cqu.moe>" },
    { name: "isolated sender", configured: "重大通知 <notifications@feed.cqu.moe>", expected: "重大通知 <notifications@feed.cqu.moe>" },
    { name: "trimmed sender", configured: " 重大通知 <notifications@feed.cqu.moe> \n", expected: "重大通知 <notifications@feed.cqu.moe>" },
  ])("uses $name for verification OTP and password reset email", async ({ configured, expected }) => {
    const messages: { from: string; to: string; subject: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit) => {
      if (input !== "https://api.resend.com/emails" || init.method !== "POST") {
        throw new Error("Unexpected outbound request during Auth email test");
      }
      const { from, to, subject } = JSON.parse(init.body as string);
      messages.push({ from, to, subject });
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
          subject: "验证你的邮箱 - auth.cqu.moe",
        },
        {
          from: expected,
          to: "sender-test@example.com",
          subject: "重置密码 - auth.cqu.moe",
        },
      ]);
    } finally {
      fixture.close();
    }
  });
});
