import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { vi } from "vitest";
import { createSqliteD1 } from "./d1";
import type { Env } from "../types";

export function createHttpFixture() {
  const database = new DatabaseSync(":memory:");
  const migrations = new NodeURL("../../drizzle/migrations/", import.meta.url);
  for (const name of readdirSync(fileURLToPath(migrations)).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(fileURLToPath(new NodeURL(name, migrations)), "utf8"));
  }

  const kvValues = new Map<string, string>();
  const assetsFetch = vi.fn(async () =>
    new Response("<!doctype html><title>test asset</title>", {
      headers: { "content-type": "text/html; charset=utf-8" },
    })
  );
  const doFetch = vi.fn(async () => {
    throw new Error("unstubbed Durable Object request");
  });
  const namespace = {
    idFromName: (name: string) => name,
    get: () => ({ fetch: doFetch }),
  } as unknown as DurableObjectNamespace;

  const env = {
    DATABASE: createSqliteD1(database),
    KV: {
      get: async (key: string) => kvValues.get(key) ?? null,
      put: async (key: string, value: string) => {
        kvValues.set(key, value);
      },
      delete: async (key: string) => {
        kvValues.delete(key);
      },
    },
    RESEND_API_KEY: "re_test_placeholder",
    CQU_SESSION: namespace,
    CQU_LOGIN: namespace,
    ASSETS: { fetch: assetsFetch },
    ENCRYPTION_KEY: "MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=",
    BETTER_AUTH_URL: "http://localhost:8787",
    BETTER_AUTH_SECRET: "test-secret-that-is-long-enough-for-better-auth",
    BIND_EMAIL_DOMAIN: "cquotp.com",
  } as unknown as Env;

  return {
    env,
    seedBearerIdentity(userId: string, clientId: string) {
      database.prepare("INSERT INTO user (id, name, email, createdAt, updatedAt) VALUES (?, ?, ?, datetime('now'), datetime('now'))")
        .run(userId, userId, `${userId}@example.com`);
      database.prepare("INSERT INTO oauthClient (id, clientId, redirectUris) VALUES (?, ?, '[]')")
        .run(clientId, clientId);
    },
    assetsFetch,
    doFetch,
    close: async () => database.close(),
  };
}
