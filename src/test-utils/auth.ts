import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { createAuth } from "../auth";
import type { Env } from "../types";

export const TEST_AUTH_ORIGIN = "http://localhost:8787";
export const TEST_AUTH_SECRET = "test-secret-that-is-long-enough-for-better-auth";

export function createTestAuth(options: { origin?: string } = {}) {
  const origin = options.origin ?? TEST_AUTH_ORIGIN;
  const database = new DatabaseSync(":memory:");
  database.exec(
    readFileSync(
      fileURLToPath(new NodeURL("../../drizzle/migrations/0004_user_entitlement.sql", import.meta.url)),
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
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: TEST_AUTH_SECRET,
    RESEND_API_KEY: "re_test_placeholder",
  } as unknown as Env;

  return {
    auth: createAuth(env, new Request(`${origin}/settings`)),
    database,
    env,
    kvValues,
    close: () => database.close(),
  };
}

export function cookieFromHeaders(headers: Headers): string {
  const setCookies = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ??
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
