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

function linkFromEmail(html: string): string {
  const href = html.match(/href="([^"]+)"/)?.[1];
  if (!href) throw new Error("email did not contain a confirmation link");
  return href;
}

describe("account profile auth configuration", () => {
  afterEach(() => sendEmail.mockClear());

  it("requires the current mailbox confirmation before verifying a new email", () => {
    const { auth, database } = authForTest();
    const changeEmail = auth.options.user?.changeEmail;

    expect(changeEmail?.enabled).toBe(true);
    expect(changeEmail?.updateEmailWithoutVerification).not.toBe(true);
    expect(changeEmail?.sendChangeEmailConfirmation).toBeTypeOf("function");
    database.close();
  });

  it("keeps the old email until both mailbox links have been opened", async () => {
    const { auth, database } = authForTest();
    const { runMigrations } = await getMigrations(auth.options);
    await runMigrations();

    const signup = await auth.api.signUpEmail({
      body: {
        email: "old@example.com",
        password: "password123",
        name: "Test User",
      },
      returnHeaders: true,
    });

    const signupCookie = signup.headers.get("set-cookie")?.split(";", 1)[0];
    expect(signupCookie).toBeTruthy();
    const initialVerificationLink = linkFromEmail(sendEmail.mock.calls[0]![0].html);
    const initialVerification = await auth.handler(
      new Request(initialVerificationLink, {
        headers: new Headers({ cookie: signupCookie! }),
        redirect: "manual",
      })
    );
    expect(initialVerification.status).toBe(302);

    const verifiedCookie =
      initialVerification.headers.get("set-cookie")?.split(";", 1)[0] ??
      signupCookie!;
    const headers = new Headers({ cookie: verifiedCookie });
    const originalUserId = (
      database.prepare('SELECT id FROM "user"').get() as { id: string }
    ).id;
    sendEmail.mockClear();

    await auth.api.changeEmail({
      body: {
        newEmail: "new@example.com",
        callbackURL: "/settings?email-change=confirmed",
      },
      headers,
    });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0]?.[0]).toMatchObject({
      to: "old@example.com",
      subject: "确认更换登录邮箱 - auth.cqu.moe",
    });
    expect(
      database.prepare('SELECT id, email FROM "user"').get()
    ).toEqual({ id: originalUserId, email: "old@example.com" });

    const oldMailboxLink = linkFromEmail(sendEmail.mock.calls[0]![0].html);
    const oldConfirmation = await auth.handler(
      new Request(oldMailboxLink, { headers, redirect: "manual" })
    );
    expect(oldConfirmation.status).toBe(302);
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(sendEmail.mock.calls[1]?.[0]).toMatchObject({
      to: "new@example.com",
      subject: "验证你的邮箱 - auth.cqu.moe",
    });
    expect(
      database.prepare('SELECT id, email FROM "user"').get()
    ).toEqual({ id: originalUserId, email: "old@example.com" });

    const newMailboxLink = linkFromEmail(sendEmail.mock.calls[1]![0].html);
    const newConfirmation = await auth.handler(
      new Request(newMailboxLink, { headers, redirect: "manual" })
    );
    expect(newConfirmation.status).toBe(302);
    expect(
      database.prepare('SELECT id, email FROM "user"').get()
    ).toEqual({ id: originalUserId, email: "new@example.com" });

    database.close();
  });

  it("does not let an unverified account bypass the old-mailbox step", async () => {
    const { auth, database } = authForTest();
    const { runMigrations } = await getMigrations(auth.options);
    await runMigrations();

    const signup = await auth.api.signUpEmail({
      body: {
        email: "unverified@example.com",
        password: "password123",
        name: "Unverified User",
      },
      returnHeaders: true,
    });
    const cookie = signup.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toBeTruthy();
    sendEmail.mockClear();

    const response = await auth.handler(
      new Request("http://localhost:8787/api/auth/change-email", {
        method: "POST",
        headers: {
          cookie: cookie!,
          "content-type": "application/json",
          origin: "http://localhost:8787",
        },
        body: JSON.stringify({ newEmail: "new@example.com" }),
      })
    );

    expect(response.status).toBe(403);
    expect(sendEmail).not.toHaveBeenCalled();
    database.close();
  });
});
