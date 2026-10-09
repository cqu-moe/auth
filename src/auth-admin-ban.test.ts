import { describe, expect, it, vi } from "vitest";
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
  return { auth: createAuth(env, new Request("http://localhost:8787/")), database };
}

function cookieFromHeaders(headers: Headers): string {
  const setCookies = headers.getSetCookie?.() ?? [];
  return setCookies.map((c) => c.split(";", 1)[0]).filter((c) => !c.endsWith("=")).join("; ");
}

async function signUp(auth: ReturnType<typeof createAuth>, email: string) {
  const signup = await auth.api.signUpEmail({
    body: { email, password: "password123", name: "Test User" },
    returnHeaders: true,
  });
  return new Headers({ cookie: cookieFromHeaders(signup.headers) });
}

async function signIn(auth: ReturnType<typeof createAuth>, email: string) {
  const result = await auth.api.signInEmail({
    body: { email, password: "password123" },
    returnHeaders: true,
  });
  return new Headers({ cookie: cookieFromHeaders(result.headers) });
}

async function post(auth: ReturnType<typeof createAuth>, path: string, headers: Headers, body: Record<string, unknown>) {
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

describe("admin ban role hierarchy", () => {
  it("blocks admin banning superAdmin, allows the reverse and keeps unban open", async () => {
    const { auth, database } = authForTest();
    const { runMigrations } = await getMigrations(auth.options);
    await runMigrations();

    await signUp(auth, "admin@example.com");
    await signUp(auth, "super@example.com");
    await signUp(auth, "user@example.com");
    const setRole = (email: string, role: string) =>
      database.prepare('UPDATE "user" SET role = ? WHERE email = ?').run(role, email);
    setRole("admin@example.com", "admin");
    setRole("super@example.com", "superAdmin");
    const adminHeaders = await signIn(auth, "admin@example.com");
    const superHeaders = await signIn(auth, "super@example.com");
    const userId = (email: string) =>
      (database.prepare('SELECT id FROM "user" WHERE email = ?').get(email) as { id: string }).id;

    const blocked = await post(auth, "/admin/ban-user", adminHeaders, { userId: userId("super@example.com") });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ code: "CANNOT_BAN_ADMINS" });
    expect(database.prepare('SELECT banned FROM "user" WHERE email = ?').get("super@example.com")).toMatchObject({ banned: 0 });

    const allowed = await post(auth, "/admin/ban-user", adminHeaders, { userId: userId("user@example.com") });
    expect(allowed.status).toBe(200);

    const unban = await post(auth, "/admin/unban-user", adminHeaders, { userId: userId("user@example.com") });
    expect(unban.status).toBe(200);

    const escalate = await post(auth, "/admin/ban-user", superHeaders, { userId: userId("admin@example.com") });
    expect(escalate.status).toBe(200);
    expect(database.prepare('SELECT banned FROM "user" WHERE email = ?').get("admin@example.com")).toMatchObject({ banned: 1 });
  });
});
