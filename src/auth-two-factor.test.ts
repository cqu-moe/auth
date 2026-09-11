import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { getMigrations } from "better-auth/db/migration";
import { base32 } from "@better-auth/utils/base32";
import { createAuth } from "./auth";
import type { Env } from "./types";

const sendEmail = vi.hoisted(() =>
  vi.fn(async () => ({ data: { id: "mail-1" }, error: null }))
);

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: sendEmail };
  },
}));

function authForTest() {
  const database = new DatabaseSync(":memory:");
  database.exec(
    readFileSync(
      new URL("../drizzle/migrations/0004_user_entitlement.sql", import.meta.url),
      "utf8"
    )
  );
  const kvValues = new Map<string, string>();
  const env = {
    DATABASE: database,
    KV: {
      get: async (key: string) => kvValues.get(key) ?? null,
      put: async (key: string, value: string) => {
        kvValues.set(key, value);
      },
      delete: async (key: string) => {
        kvValues.delete(key);
      },
    },
    BETTER_AUTH_URL: "http://localhost:8787",
    BETTER_AUTH_SECRET: "test-secret-that-is-long-enough-for-better-auth",
    RESEND_API_KEY: "re_test_placeholder",
  } as unknown as Env;

  return {
    auth: createAuth(env, new Request("http://localhost:8787/settings")),
    database,
  };
}

function cookieFromHeaders(headers: Headers): string {
  const setCookies = headers.getSetCookie?.() ??
    (headers.get("set-cookie")?.split(/,(?=[^;]+?=)/) ?? []);
  const cookies = new Map<string, string>();
  for (const setCookie of setCookies) {
    const [nameValue] = setCookie.split(";", 1);
    const [name, value] = nameValue.split("=", 2);
    cookies.set(name, `${name}=${value}`);
  }
  return [...cookies.values()]
    .filter((cookie) => !cookie.endsWith("="))
    .join("; ");
}

function otpFromEmail(): string {
  const html = sendEmail.mock.calls.at(-1)?.[0]?.html as string | undefined;
  const otp = html?.match(/letter-spacing:6px">(\d{6})</)?.[1];
  if (!otp) throw new Error("email did not contain an OTP");
  return otp;
}

async function signUp(auth: ReturnType<typeof createAuth>) {
  const signup = await auth.api.signUpEmail({
    body: {
      email: "user@example.com",
      password: "password123",
      name: "Test User",
    },
    returnHeaders: true,
  });
  const cookie = cookieFromHeaders(signup.headers);
  expect(cookie).toBeTruthy();
  return new Headers({ cookie });
}

async function post(
  auth: ReturnType<typeof createAuth>,
  path: string,
  headers: Headers,
  body: Record<string, unknown>,
  clientIp?: string
) {
  return auth.handler(
    new Request(`http://localhost:8787/api/v1/auth${path}`, {
      method: "POST",
      headers: new Headers({
        cookie: headers.get("cookie") ?? "",
        "content-type": "application/json",
        origin: "http://localhost:8787",
        ...(clientIp ? { "cf-connecting-ip": clientIp } : {}),
      }),
      body: JSON.stringify(body),
    })
  );
}

describe("native two-factor authentication", () => {
  afterEach(() => {
    sendEmail.mockClear();
    vi.useRealTimers();
  });

  it("enables Better Auth two-factor and native email verification OTP", () => {
    const { auth, database } = authForTest();
    const plugins = auth.options.plugins ?? [];
    const pluginIds = plugins.map((plugin) => plugin.id);
    const emailOtp = plugins.find((plugin) => plugin.id === "email-otp") as any;
    const twoFactor = plugins.find((plugin) => plugin.id === "two-factor") as any;

    expect(pluginIds).toContain("two-factor");
    expect(pluginIds).toContain("email-otp");
    expect(auth.options.user?.changeEmail).toBeUndefined();
    expect(auth.options.disabledPaths).toEqual([
      "/token",
      "/sign-in/email-otp",
      "/email-otp/request-password-reset",
      "/forget-password/email-otp",
      "/email-otp/reset-password",
      "/verify-email",
    ]);
    expect(plugins.at(-1)?.id).toBe("custom-session");
    expect(emailOtp.options).toMatchObject({
      otpLength: 6,
      expiresIn: 300,
      allowedAttempts: 3,
      storeOTP: "hashed",
      resendStrategy: "rotate",
      disableSignUp: true,
      overrideDefaultEmailVerification: true,
      changeEmail: { enabled: true, verifyCurrentEmail: true },
    });
    expect(twoFactor.options).toMatchObject({
      issuer: "auth.cqu.moe",
      twoFactorCookieMaxAge: 600,
      trustDeviceMaxAge: 2_592_000,
      totpOptions: { digits: 6, period: 30 },
      otpOptions: {
        digits: 6,
        period: 5,
        allowedAttempts: 3,
        storeOTP: "hashed",
      },
      backupCodeOptions: {
        amount: 10,
        length: 10,
        storeBackupCodes: "encrypted",
      },
    });
    expect(auth.options.rateLimit).toMatchObject({
      enabled: true,
      window: 60,
      max: 30,
      storage: "secondary-storage",
      customRules: {
        "/two-factor/send-otp": { window: 60, max: 3 },
        "/two-factor/verify-totp": { window: 60, max: 5 },
        "/two-factor/verify-otp": { window: 60, max: 5 },
        "/two-factor/verify-backup-code": { window: 60, max: 5 },
        "/email-otp/send-verification-otp": { window: 60, max: 3 },
        "/email-otp/check-verification-otp": { window: 60, max: 5 },
        "/email-otp/verify-email": { window: 60, max: 5 },
        "/email-otp/request-email-change": { window: 60, max: 5 },
        "/email-otp/change-email": { window: 60, max: 5 },
      },
    });
    database.close();
  });

  it("keeps unused public email-OTP authentication routes unavailable", async () => {
    const { auth, database } = authForTest();
    const blockedRequests = [
      ["/sign-in/email-otp", { email: "user@example.com", otp: "000000" }],
      ["/email-otp/request-password-reset", { email: "user@example.com" }],
      ["/forget-password/email-otp", { email: "user@example.com" }],
      ["/email-otp/reset-password", { email: "user@example.com", otp: "000000", password: "new-password123" }],
    ] as const;

    for (const [path, body] of blockedRequests) {
      const response = await post(auth, path, new Headers(), body);
      expect(response.status, path).toBe(404);
    }

    expect(sendEmail).not.toHaveBeenCalled();
    database.close();
  });

  it("sends a six-digit OTP instead of a verification link after sign-up", async () => {
    const { auth, database } = authForTest();
    const { runMigrations } = await getMigrations(auth.options);
    await runMigrations();

    await signUp(auth);

    const html = sendEmail.mock.calls.at(-1)?.[0]?.html as string | undefined;
    expect(html).toMatch(/>\d{6}</);
    expect(html).not.toContain("href=");
    expect(html).not.toContain("/api/auth/verify-email");
    database.close();
  });

  it("verifies a sign-up email OTP exactly once and rejects legacy links", async () => {
    const { auth, database } = authForTest();
    const { runMigrations } = await getMigrations(auth.options);
    await runMigrations();
    const headers = await signUp(auth);
    sendEmail.mockClear();

    const sent = await post(auth, "/email-otp/send-verification-otp", headers, {
      email: "user@example.com",
      type: "email-verification",
    });
    expect(sent.status).toBe(200);
    const otp = otpFromEmail();

    const verified = await post(auth, "/email-otp/verify-email", headers, {
      email: "user@example.com",
      otp,
    });
    expect(verified.status).toBe(200);
    expect(await verified.json()).toMatchObject({
      status: true,
      user: { email: "user@example.com", emailVerified: true },
    });

    const reused = await post(auth, "/email-otp/verify-email", headers, {
      email: "user@example.com",
      otp,
    });
    expect(reused.status).toBe(400);

    const legacy = await auth.handler(
      new Request("http://localhost:8787/api/auth/verify-email?token=legacy")
    );
    expect(legacy.status).toBe(404);
    database.close();
  });

  it("keeps only the native double-OTP email-change routes usable", async () => {
    const { auth, database } = authForTest();
    const { runMigrations } = await getMigrations(auth.options);
    await runMigrations();
    const headers = await signUp(auth);
    sendEmail.mockClear();

    const sentCurrent = await post(auth, "/email-otp/send-verification-otp", headers, {
      email: "user@example.com",
      type: "email-verification",
    });
    expect(sentCurrent.status).toBe(200);
    const currentOtp = otpFromEmail();

    const checkedCurrent = await post(auth, "/email-otp/check-verification-otp", headers, {
      email: "user@example.com",
      type: "email-verification",
      otp: currentOtp,
    });
    expect(checkedCurrent.status).toBe(200);

    const sentNew = await post(auth, "/email-otp/request-email-change", headers, {
      newEmail: "new@example.com",
      otp: currentOtp,
    });
    expect(sentNew.status).toBe(200);
    const newEmailOtp = otpFromEmail();

    const changed = await post(auth, "/email-otp/change-email", headers, {
      newEmail: "new@example.com",
      otp: newEmailOtp,
    });
    expect(changed.status).toBe(200);
    database.close();
  });

  it("rejects generic current-email OTP requests for another mailbox", async () => {
    const { auth, database } = authForTest();
    const { runMigrations } = await getMigrations(auth.options);
    await runMigrations();
    const headers = await signUp(auth);
    sendEmail.mockClear();

    const response = await post(auth, "/email-otp/send-verification-otp", headers, {
      email: "other@example.com",
      type: "email-verification",
    });

    expect(response.status).toBe(403);
    expect(sendEmail).not.toHaveBeenCalled();
    database.close();
  });

  it("enrolls a user, completes TOTP login, and consumes an email OTP and backup code", async () => {
    const { auth, database } = authForTest();
    const { runMigrations } = await getMigrations(auth.options);
    await runMigrations();
    const headers = await signUp(auth);

    const enabled = await auth.api.enableTwoFactor({
      headers,
      body: { password: "password123" },
    });
    const secret = new URL(enabled.totpURI).searchParams.get("secret");
    expect(secret).toBeTruthy();
    const rawSecret = new TextDecoder().decode(base32.decode(secret!));

    const { code } = await auth.api.generateTOTP({ body: { secret: rawSecret } });
    await auth.api.verifyTOTP({ headers, body: { code } });
    expect(
      database.prepare('SELECT twoFactorEnabled FROM "user"').get()
    ).toMatchObject({ twoFactorEnabled: 1 });

    await auth.api.signOut({ headers });
    const signIn = await auth.api.signInEmail({
      body: { email: "user@example.com", password: "password123" },
      returnHeaders: true,
    });
    expect(signIn.response.twoFactorRedirect).toBe(true);
    const twoFactorHeaders = new Headers({ cookie: cookieFromHeaders(signIn.headers) });

    const totp = await auth.api.generateTOTP({ body: { secret: rawSecret } });
    const verified = await (auth.api.verifyTOTP as any)({
      headers: twoFactorHeaders,
      body: { code: totp.code },
      returnHeaders: true,
    });
    const sessionHeaders = new Headers({ cookie: cookieFromHeaders(verified.headers) });
    expect(database.prepare('SELECT id FROM "session"').get()).toMatchObject({});

    await auth.api.signOut({ headers: sessionHeaders });
    const otpSignIn = await auth.api.signInEmail({
      body: { email: "user@example.com", password: "password123" },
      returnHeaders: true,
    });
    const otpHeaders = new Headers({ cookie: cookieFromHeaders(otpSignIn.headers) });
    sendEmail.mockClear();
    await auth.api.sendTwoFactorOTP({ headers: otpHeaders });
    await auth.api.verifyTwoFactorOTP({ headers: otpHeaders, body: { code: otpFromEmail() } });

    await auth.api.signOut({ headers: otpHeaders });
    const backupSignIn = await auth.api.signInEmail({
      body: { email: "user@example.com", password: "password123" },
      returnHeaders: true,
    });
    const backupHeaders = new Headers({ cookie: cookieFromHeaders(backupSignIn.headers) });
    const firstUse = await post(auth, "/two-factor/verify-backup-code", backupHeaders, {
      code: enabled.backupCodes[0],
    });
    expect(firstUse.status).toBe(200);
    const retrySignIn = await auth.api.signInEmail({
      body: { email: "user@example.com", password: "password123" },
      returnHeaders: true,
    });
    expect(retrySignIn.response.twoFactorRedirect).toBe(true);
    const retryHeaders = new Headers({ cookie: cookieFromHeaders(retrySignIn.headers) });
    const secondUse = await post(auth, "/two-factor/verify-backup-code", retryHeaders, {
      code: enabled.backupCodes[0],
    });
    expect(secondUse.status).toBe(401);
    database.close();
  });

  it("rate limits every sensitive native two-factor and email-OTP path", async () => {
    const rules = [
      ["/two-factor/send-otp", 3],
      ["/two-factor/verify-totp", 5],
      ["/two-factor/verify-otp", 5],
      ["/two-factor/verify-backup-code", 5],
      ["/email-otp/send-verification-otp", 3],
      ["/email-otp/check-verification-otp", 5],
      ["/email-otp/verify-email", 5],
      ["/email-otp/request-email-change", 5],
      ["/email-otp/change-email", 5],
    ] as const;

    for (const [path, max] of rules) {
      const { auth, database } = authForTest();
      const headers = new Headers();
      const clientIp = "198.51.100.42";

      for (let request = 0; request <= max; request += 1) {
        const response = await post(auth, path, headers, {}, clientIp);
        if (request < max) expect(response.status).not.toBe(429);
        else expect(response.status).toBe(429);
      }

      database.close();
    }
  });

  it("expires current-email OTPs and invalidates them after the attempt budget", async () => {
    const { auth, database } = authForTest();
    const { runMigrations } = await getMigrations(auth.options);
    await runMigrations();
    const headers = await signUp(auth);
    sendEmail.mockClear();

    vi.useFakeTimers();
    const sentAt = new Date("2026-01-01T00:00:00Z");
    vi.setSystemTime(sentAt);
    const sent = await post(auth, "/email-otp/send-verification-otp", headers, {
      email: "user@example.com",
      type: "email-verification",
    });
    expect(sent.status).toBe(200);
    const otp = otpFromEmail();
    vi.setSystemTime(new Date(sentAt.getTime() + 300_001));
    const expired = await post(auth, "/email-otp/check-verification-otp", headers, {
      email: "user@example.com",
      type: "email-verification",
      otp,
    });
    expect(expired.status).toBe(400);

    vi.useRealTimers();
    const resent = await post(auth, "/email-otp/send-verification-otp", headers, {
      email: "user@example.com",
      type: "email-verification",
    });
    expect(resent.status).toBe(200);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const wrong = await post(auth, "/email-otp/check-verification-otp", headers, {
        email: "user@example.com",
        type: "email-verification",
        otp: "000000",
      });
      expect(wrong.status).toBe(400);
    }
    const exhausted = await post(auth, "/email-otp/check-verification-otp", headers, {
      email: "user@example.com",
      type: "email-verification",
      otp: "000000",
    });
    expect(exhausted.status).toBe(403);
    database.close();
  });
});
