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

describe("account profile auth configuration", () => {
  afterEach(() => sendEmail.mockClear());

  it("keeps the base profile name and user ID available", async () => {
    const { auth, database } = authForTest();
    const { runMigrations } = await getMigrations(auth.options);
    await runMigrations();

    await auth.api.signUpEmail({
      body: {
        email: "profile@example.com",
        password: "password123",
        name: "Test User",
      },
    });

    expect(database.prepare('SELECT id, name FROM "user"').get()).toMatchObject({
      name: "Test User",
    });
    database.close();
  });
});
