import { applyD1Migrations, createExecutionContext, env } from "cloudflare:test";
import { beforeAll, expect, it, vi } from "vitest";
import { AuthService } from "../../src/rpc";
import { createAuth } from "../../src/auth";
import { hashOAuthClientSecret } from "../../src/utils/oauth-secret";

beforeAll(async () => applyD1Migrations(env.DATABASE, env.TEST_MIGRATIONS));

async function fixture(options?: { rpcMethods?: string[]; external?: boolean }) {
  const id = crypto.randomUUID();
  const adapter = (await createAuth(env, new Request(env.BETTER_AUTH_URL)).$context).adapter;
  const now = new Date();
  const user = await adapter.create<{ id: string }>({
    model: "user",
    data: {
      name: "External search user",
      email: `${id}@example.com`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
      role: "user",
    },
  });
  await adapter.create({
    model: "oauthClient",
    data: {
      clientId: id,
      clientSecret: await hashOAuthClientSecret("rpc-test-secret"),
      redirectUris: ["https://schedule.example/callback"],
      tokenEndpointAuthMethod: "client_secret_basic",
      metadata: {
        subsystem: "calendar",
        rpcMethods: options?.rpcMethods ?? ["cquExternalSearch"],
      },
    },
  });
  if (options?.external !== false) {
    await env.DATABASE.prepare(
      "INSERT INTO user_entitlement (user_id, subsystem, capability, value) VALUES (?, 'calendar', 'external', '1')"
    ).bind(user.id).run();
  }
  await env.DATABASE.prepare(
    "INSERT INTO cqu_credentials (id, user_id, student_id, encrypted_password, iv) VALUES (?, ?, ?, ?, ?)"
  ).bind(id, user.id, "student", "encrypted", "iv").run();

  const fetch = vi.fn(async (_request: Request) => Response.json({
    ok: true,
    contractVersion: 1,
    sourceType: "admin_class",
    session: { id: "session-current", name: "2026秋" },
    items: [
      { id: "class-1", name: "电气工程2026-01班", extra: "2026级 / 30人 / 电气工程学院" },
    ],
    truncated: true,
    browserState: { cookie: "SECRET", localStorage: "SECRET" },
  }));
  const namespace = {
    idFromName: (name: string) => name,
    get: () => ({ fetch }),
  } as unknown as DurableObjectNamespace;
  const rpc = new AuthService(createExecutionContext(), { ...env, CQU_SESSION: namespace });
  return {
    rpc,
    fetch,
    args: { clientId: id, clientSecret: "rpc-test-secret", userId: user.id },
    userId: user.id,
    adapter,
  };
}

it("dispatches a fixed admin-class recipe and returns only the typed search contract", async () => {
  const f = await fixture();
  const deadlineAt = Date.now() + 60_000;
  const result = await f.rpc.cquExternalSearch({
    ...f.args,
    sourceType: "admin_class",
    deadlineAt,
    departmentId: "",
    departmentName: "电气工程学院",
    grade: "2026",
    keyword: "电气",
  });

  expect(result).toEqual({
    contractVersion: 1,
    sourceType: "admin_class",
    session: { id: "session-current", name: "2026秋" },
    items: [
      { id: "class-1", name: "电气工程2026-01班", extra: "2026级 / 30人 / 电气工程学院" },
    ],
    truncated: true,
  });
  expect(f.fetch).toHaveBeenCalledTimes(1);
  const request = f.fetch.mock.calls[0][0];
  expect(new URL(request.url).pathname).toBe("/external-search");
  expect(request.method).toBe("POST");
  expect(new URL(request.url).searchParams.get("deadlineAt")).toBe(String(deadlineAt));
  await expect(request.clone().json()).resolves.toEqual({
    action: "admin_class_search",
    departmentId: "",
    departmentName: "电气工程学院",
    grade: "2026",
    keyword: "电气",
  });
  expect(JSON.stringify(result)).not.toContain("SECRET");

  f.fetch.mockImplementationOnce(async () => Response.json({
    ok: true,
    contractVersion: 1,
    sourceType: "admin_class",
    session: { id: "session-current", name: "2026秋" },
    items: Array.from({ length: 201 }, (_, index) => ({
      id: `class-${index}`,
      name: `班级${index}`,
      extra: "",
    })),
    truncated: false,
  }));
  const overflowing = await f.rpc.cquExternalSearch({
    ...f.args,
    sourceType: "admin_class",
  });
  if (!("items" in overflowing)) throw new Error("expected admin-class result");
  expect(overflowing.items).toHaveLength(200);
  expect(overflowing.truncated).toBe(true);
});

it("rejects unsupported sources and malformed filters before browser dispatch", async () => {
  const f = await fixture();
  await expect(f.rpc.cquExternalSearch({
    ...f.args,
    sourceType: "student",
    keyword: "20260001",
  } as unknown as Parameters<typeof f.rpc.cquExternalSearch>[0]))
    .resolves.toEqual({ error: "INVALID_REQUEST" });
  await expect(f.rpc.cquExternalSearch({ ...f.args, sourceType: "admin_class", grade: "all", keyword: "x".repeat(101) }))
    .resolves.toEqual({ error: "INVALID_REQUEST" });
  await expect(f.rpc.cquExternalSearch({ ...f.args, sourceType: "admin_class", grade: "twelve" }))
    .resolves.toEqual({ error: "INVALID_REQUEST" });
  expect(f.fetch).not.toHaveBeenCalled();
});

it("rejects runtime filter values that do not match the typed contract", async () => {
  const f = await fixture();
  const invalidArgs = [
    { departmentId: 123 },
    { departmentName: { name: "电气工程学院" } },
    { grade: ["2026"] },
    { keyword: null },
  ];
  for (const filter of invalidArgs) {
    await expect(f.rpc.cquExternalSearch({
      ...f.args,
      sourceType: "admin_class",
      ...filter,
    } as unknown as Parameters<typeof f.rpc.cquExternalSearch>[0]))
      .resolves.toEqual({ error: "INVALID_REQUEST" });
  }
  expect(f.fetch).not.toHaveBeenCalled();
});

it("requires method approval, external entitlement and an active school binding", async () => {
  const unapproved = await fixture({ rpcMethods: ["getCaps"] });
  await expect(unapproved.rpc.cquExternalSearch({
    ...unapproved.args,
    sourceType: "department",
  })).resolves.toEqual({ error: "FORBIDDEN" });
  expect(unapproved.fetch).not.toHaveBeenCalled();

  const unentitled = await fixture({ external: false });
  await expect(unentitled.rpc.cquExternalSearch({
    ...unentitled.args,
    sourceType: "admin_class",
    keyword: "电气",
  })).resolves.toEqual({ error: "FORBIDDEN" });
  expect(unentitled.fetch).not.toHaveBeenCalled();

  const bound = await fixture();
  await env.DATABASE.prepare("UPDATE cqu_credentials SET status = ? WHERE user_id = ?")
    .bind("deleting", bound.userId).run();
  await expect(bound.rpc.cquExternalSearch({
    ...bound.args,
    sourceType: "admin_class",
    keyword: "电气",
  })).resolves.toEqual({ error: "NO_CQU_BINDING" });
  expect(bound.fetch).not.toHaveBeenCalled();
});
