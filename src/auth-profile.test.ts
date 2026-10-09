import { provePassword } from "./test-utils/auth-strength";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { getMigrations } from "better-auth/db/migration";
import { createAuth } from "./auth";
import type { Env } from "./types";

const sendEmail = vi.hoisted(() => vi.fn(async () => ({ data: { id: "mail-1" }, error: null })));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: sendEmail };
  },
}));

function authForTest() {
  const database = new DatabaseSync(":memory:");
  const env = {
    DATABASE: database,
    BETTER_AUTH_URL: "http://localhost:8787",
    BETTER_AUTH_SECRET: "test-secret-that-is-long-enough-for-better-auth",
    RESEND_API_KEY: "re_test_placeholder",
  } as unknown as Env;

  return { auth: createAuth(env, new Request("http://localhost:8787/settings")), database };
}

function cookieFromHeaders(headers: Headers): string {
  const setCookies = headers.getSetCookie?.() ?? (headers.get("set-cookie")?.split(/,(?=[^;]+?=)/) ?? []);
  return setCookies
    .map((setCookie) => setCookie.split(";", 1)[0])
    .filter((cookie) => !cookie.endsWith("="))
    .join("; ");
}

function otpFromEmail(html: string): string {
  const otp = html.match(/>(\d{6})</)?.[1];
  if (!otp) throw new Error("email did not contain a six-digit OTP");
  return otp;
}

async function signUp(auth: ReturnType<typeof createAuth>, email: string) {
  const signup = await auth.api.signUpEmail({
    body: { email, password: "password123", name: "Test User" },
    returnHeaders: true,
  });
  const headers = new Headers({ cookie: cookieFromHeaders(signup.headers) });
  await provePassword(auth, headers, "password123", "email");
  return headers;
}

async function nativePost(
  auth: ReturnType<typeof createAuth>,
  path: string,
  headers: Headers,
  body: Record<string, unknown>
) {
  return auth.handler(new Request(`http://localhost:8787/api/v1/auth${path}`, {
    method: "POST",
    headers: new Headers({
      cookie: headers.get("cookie") ?? "",
      "content-type": "application/json",
      origin: "http://localhost:8787",
    }),
    body: JSON.stringify(body),
  }));
}

describe("account profile auth configuration", () => {
  afterEach(() => sendEmail.mockClear());

  it("changes an email only after native OTP checks for both mailboxes", async () => {
    const { auth, database } = authForTest();
    const { runMigrations } = await getMigrations(auth.options);
    await runMigrations();
    const headers = await signUp(auth, "old@example.com");
    const readUser = () => database.prepare('SELECT id, email FROM "user" WHERE email = ?').get("old@example.com");
    const originalUser = readUser() as { id: string; email: string };
    sendEmail.mockClear();

    await auth.api.sendVerificationOTP({
      headers,
      body: { email: "old@example.com", type: "email-verification" },
    });
    const currentOtp = otpFromEmail(sendEmail.mock.calls.at(-1)![0].html);
    await auth.api.checkVerificationOTP({
      headers,
      body: { email: "old@example.com", type: "email-verification", otp: currentOtp },
    });
    await auth.api.requestEmailChangeEmailOTP({
      headers,
      body: { newEmail: "new@example.com", otp: currentOtp },
    });
    const newOtp = otpFromEmail(sendEmail.mock.calls.at(-1)![0].html);
    expect(readUser()).toEqual({ id: originalUser.id, email: "old@example.com" });

    await auth.api.changeEmailEmailOTP({
      headers,
      body: { newEmail: "new@example.com", otp: newOtp },
    });
    expect(database.prepare('SELECT id, email FROM "user" WHERE email = ?').get("new@example.com")).toEqual({
      id: originalUser.id,
      email: "new@example.com",
    });
    database.close();
  });

  it("keeps the user and email unchanged for invalid, reused, foreign, and wrong-purpose OTPs", async () => {
    const { auth, database } = authForTest();
    const { runMigrations } = await getMigrations(auth.options);
    await runMigrations();
    const headers = await signUp(auth, "old@example.com");
    const readUser = () => database.prepare('SELECT id, email FROM "user" WHERE email = ?').get("old@example.com");
    const originalUser = readUser() as { id: string; email: string };
    const unchanged = () => expect(readUser()).toEqual({ id: originalUser.id, email: "old@example.com" });
    sendEmail.mockClear();

    const wrongCurrent = await nativePost(auth, "/email-otp/check-verification-otp", headers, {
      email: "old@example.com", type: "email-verification", otp: "000000",
    });
    expect(wrongCurrent.status).toBe(400);
    unchanged();

    const sentCurrent = await nativePost(auth, "/email-otp/send-verification-otp", headers, {
      email: "old@example.com", type: "email-verification",
    });
    expect(sentCurrent.status).toBe(200);
    const currentOtp = otpFromEmail(sendEmail.mock.calls.at(-1)![0].html);

    const anotherMailbox = await nativePost(auth, "/email-otp/send-verification-otp", headers, {
      email: "attacker@example.com", type: "email-verification",
    });
    expect(anotherMailbox.status).toBe(403);
    unchanged();

    const wrongCurrentAfterSend = await nativePost(auth, "/email-otp/request-email-change", headers, {
      newEmail: "new@example.com", otp: "000000",
    });
    expect(wrongCurrentAfterSend.status).toBe(400);
    unchanged();

    const otherHeaders = await signUp(auth, "other@example.com");
    const foreignCurrentOtp = await nativePost(auth, "/email-otp/request-email-change", otherHeaders, {
      newEmail: "other-new@example.com", otp: currentOtp,
    });
    expect(foreignCurrentOtp.status).toBe(400);
    unchanged();

    const sentNew = await nativePost(auth, "/email-otp/request-email-change", headers, {
      newEmail: "new@example.com", otp: currentOtp,
    });
    expect(sentNew.status).toBe(200);
    const newOtp = otpFromEmail(sendEmail.mock.calls.at(-1)![0].html);

    const wrongNew = await nativePost(auth, "/email-otp/change-email", headers, {
      newEmail: "new@example.com", otp: "000000",
    });
    expect(wrongNew.status).toBe(400);
    unchanged();

    const wrongPurpose = await nativePost(auth, "/email-otp/check-verification-otp", headers, {
      email: "old@example.com", type: "email-verification", otp: newOtp,
    });
    expect(wrongPurpose.status).toBe(400);
    unchanged();

    const changed = await nativePost(auth, "/email-otp/change-email", headers, {
      newEmail: "new@example.com", otp: newOtp,
    });
    expect(changed.status).toBe(200);
    const reused = await nativePost(auth, "/email-otp/change-email", headers, {
      newEmail: "new@example.com", otp: newOtp,
    });
    expect(reused.status).toBe(400);
    expect(database.prepare('SELECT id, email FROM "user" WHERE email = ?').get("new@example.com")).toEqual({
      id: originalUser.id,
      email: "new@example.com",
    });
    database.close();
  });
});
