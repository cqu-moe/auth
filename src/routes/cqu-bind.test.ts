import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { cquBinding } from "./cqu-bind";
import type { Env } from "../types";
import { createSqliteD1 } from "../test-utils/d1";

vi.mock("../auth", () => ({
  createAuth: () => ({
    api: { getSession: async () => ({ user: { id: "current-user" } }) },
  }),
}));

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));

function bindingResponse(
  credentialsStatus: string | null,
  addressStatus: string | null,
  kind: "direct" | "forward" = "direct",
  senderWhitelist = '["sso@cqu.edu.cn"]',
) {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec(`
    CREATE TABLE cqu_credentials (user_id TEXT, status TEXT);
    CREATE TABLE cqu_bind_addresses (
      token TEXT, user_id TEXT, kind TEXT, sender_whitelist TEXT,
      status TEXT, bound_at TEXT, last_code_at TEXT
    );
    INSERT INTO cqu_credentials VALUES ('other-user', 'active');
    INSERT INTO cqu_bind_addresses
      (token, user_id, kind, sender_whitelist, status)
      VALUES ('other-address', 'other-user', 'forward', '["private@other.test"]', 'active');
  `);
  if (credentialsStatus) {
    database.prepare("INSERT INTO cqu_credentials VALUES (?, ?)")
      .run("current-user", credentialsStatus);
  }
  if (addressStatus) {
    database.prepare(
      "INSERT INTO cqu_bind_addresses (token, user_id, kind, sender_whitelist, status) VALUES (?, ?, ?, ?, ?)"
    ).run("test-address", "current-user", kind, senderWhitelist, addressStatus);
  }

  const env = {
    DATABASE: {
      prepare(sql: string) {
        return {
          bind(...params: SQLInputValue[]) {
            return {
              async raw() {
                const statement = database.prepare(sql);
                statement.setReturnArrays(true);
                return statement.all(...params);
              },
            };
          },
        };
      },
    },
    BIND_EMAIL_DOMAIN: "example.test",
    CQU_SESSION: {
      idFromName: (id: string) => id,
      get: () => ({ fetch: async () => Response.json({ status: "idle" }) }),
    },
  } as unknown as Env;
  return cquBinding.request("http://localhost/", {}, env);
}

describe("GET CQU binding status", () => {
  it.each([
    ["legacy active credentials without an address", "active", null, "active"],
    ["active credentials with an unfinished address", "active", "pending", "active"],
    ["revoked credentials with an old active address", "revoked", "active", "revoked"],
    ["pending credentials with an old active address", "pending", "active", "pending"],
    ["current active binding", "active", "active", "active"],
    ["address setup in progress", null, "pending", "pending"],
    ["revoked address", null, "revoked", "revoked"],
    ["no records for this user", null, null, "unbound"],
  ])("reports %s", async (_, credentials, address, expected) => {
    const response = await bindingResponse(credentials, address);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ...(address ? { address: "test-address@example.test" } : {}),
      ...(address ? { kind: "direct" } : {}),
      bindStatus: expected,
      sessionStatus: { status: "idle" },
    });
  });

  it("returns a validated forward recovery address without exposing another user", async () => {
    const response = await bindingResponse(
      null,
      "pending",
      "forward",
      '["owner@example.com","sso@cqu.edu.cn"]',
    );

    expect(await response.json()).toEqual({
      address: "test-address@example.test",
      bindStatus: "pending",
      kind: "forward",
      forwardAddress: "owner@example.com",
      sessionStatus: { status: "idle" },
    });
  });

  it.each([
    "not-json",
    '{}',
    '["owner@example.com",7]',
  ])("omits an invalid forward recovery whitelist: %s", async (senderWhitelist) => {
    const response = await bindingResponse(null, "pending", "forward", senderWhitelist);
    expect(await response.json()).toEqual({
      address: "test-address@example.test",
      bindStatus: "pending",
      kind: "forward",
      sessionStatus: { status: "idle" },
    });
  });
});

function createBindingFixture() {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec(`
    CREATE TABLE cqu_credentials (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      student_id TEXT NOT NULL,
      encrypted_password TEXT NOT NULL,
      iv TEXT NOT NULL,
      bound_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_login_at TEXT,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE cqu_bind_addresses (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL DEFAULT 'direct',
      sender_whitelist TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      bound_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_code_at TEXT
    );
  `);

  let releaseInit: ((body: { success: boolean; error?: string; code?: string }) => void) | undefined;
  let startedResolve: (() => void) | undefined;
  let failNextBatch = false;
  const started = new Promise<void>((resolve) => { startedResolve = resolve; });
  const d1 = createSqliteD1(database);
  const env = {
    DATABASE: {
      ...d1,
      async batch(statements: D1PreparedStatement[]) {
        if (failNextBatch) {
          failNextBatch = false;
          throw new Error("forced activation batch failure");
        }
        return d1.batch(statements);
      },
    },
    BIND_EMAIL_DOMAIN: "example.test",
    ENCRYPTION_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
    CQU_SESSION: {
      idFromName: (id: string) => id,
      get: () => ({
        fetch: async (request: Request) => {
          if (new URL(request.url).pathname === "/init") {
            startedResolve?.();
            return await new Promise<Response>((resolve) => {
              releaseInit = (body) => resolve(Response.json(body));
            });
          }
          return Response.json({ status: "idle" });
        },
      }),
    },
  } as unknown as Env;

  return {
    async insertAddress(userId: string, status: "pending" | "active" = "pending") {
      database.prepare(
        "INSERT INTO cqu_bind_addresses (token, user_id, sender_whitelist, status) VALUES (?, ?, ?, ?)"
      ).run("test-address", userId, '["sso@cqu.edu.cn"]', status);
    },
    async insertCredential(userId: string, status: "pending" | "active" | "revoked") {
      database.prepare(
        "INSERT INTO cqu_credentials (id, user_id, student_id, encrypted_password, iv, status) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(`${userId}-credential`, userId, "20260000", "ciphertext", "iv", status);
    },
    deferInit() {
      return {
        started,
        resolve(body: { success: boolean; error?: string; code?: string }) {
          releaseInit?.(body);
        },
      };
    },
    putCredentials(body: { studentId: string; password: string }) {
      return cquBinding.request("http://localhost/credentials", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }, env);
    },
    async getBinding() {
      return await (await cquBinding.request("http://localhost/", {}, env)).json() as {
        bindStatus: string;
      };
    },
    credentialStatus(userId = "current-user") {
      return (database.prepare("SELECT status FROM cqu_credentials WHERE user_id = ?").get(userId) as {
        status: string;
      } | undefined)?.status;
    },
    credentialRecord(userId = "current-user") {
      return database.prepare(
        "SELECT student_id, encrypted_password, iv, status FROM cqu_credentials WHERE user_id = ?"
      ).get(userId) as {
        student_id: string;
        encrypted_password: string;
        iv: string;
        status: string;
      } | undefined;
    },
    failActivationBatch() {
      failNextBatch = true;
    },
    close() {
      const index = databases.indexOf(database);
      if (index >= 0) databases.splice(index, 1);
      database.close();
    },
  };
}

describe("PUT CQU binding credentials", () => {
  it("does not persist a new credential before init succeeds", async () => {
    const fixture = createBindingFixture();
    await fixture.insertAddress("current-user", "pending");
    const init = fixture.deferInit();
    const request = fixture.putCredentials({ studentId: "20260001", password: "test-only" });
    await init.started;
    expect((await fixture.getBinding()).bindStatus).toBe("pending");
    init.resolve({ success: true });
    expect((await request).status).toBe(200);
    expect((await fixture.getBinding()).bindStatus).toBe("active");
    fixture.close();
  });

  it("does not insert a credential when init fails", async () => {
    const fixture = createBindingFixture();
    await fixture.insertAddress("current-user");
    await fixture.insertCredential("other-user", "active");
    const init = fixture.deferInit();
    const request = fixture.putCredentials({ studentId: "20260001", password: "test-only" });
    await init.started;
    init.resolve({ success: false, error: "invalid password" });

    expect((await request).status).toBe(400);
    expect(fixture.credentialStatus()).toBeUndefined();
    expect(fixture.credentialStatus("other-user")).toBe("active");
    fixture.close();
  });

  it("keeps an existing credential when its init retry fails", async () => {
    const fixture = createBindingFixture();
    await fixture.insertAddress("current-user");
    await fixture.insertCredential("current-user", "active");
    const init = fixture.deferInit();
    const request = fixture.putCredentials({ studentId: "20260001", password: "test-only" });
    await init.started;
    init.resolve({ success: false, error: "temporary failure" });

    expect((await request).status).toBe(400);
    expect(fixture.credentialRecord()).toEqual({
      student_id: "20260000",
      encrypted_password: "ciphertext",
      iv: "iv",
      status: "active",
    });
    fixture.close();
  });

  it("returns a distinct conflict when another CQU login is still in flight", async () => {
    const fixture = createBindingFixture();
    await fixture.insertAddress("current-user");
    await fixture.insertCredential("current-user", "active");
    const init = fixture.deferInit();
    const request = fixture.putCredentials({ studentId: "20260001", password: "test-only" });
    await init.started;
    init.resolve({
      success: false,
      code: "CQU_LOGIN_IN_FLIGHT",
      error: "CQU 登录正在进行中（请勿重复提交）",
    });

    const response = await request;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      detail: {
        error: {
          code: "CQU_LOGIN_IN_FLIGHT",
          message: "CQU 登录正在进行中（请勿重复提交）",
        },
      },
    });
    expect(fixture.credentialStatus()).toBe("active");
    fixture.close();
  });

  it("returns BIND_ACTIVATE_FAILED when the activation batch cannot commit", async () => {
    const fixture = createBindingFixture();
    await fixture.insertAddress("current-user");
    const init = fixture.deferInit();
    const request = fixture.putCredentials({ studentId: "20260001", password: "test-only" });
    await init.started;
    fixture.failActivationBatch();
    init.resolve({ success: true });

    const response = await request;
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      detail: { error: { code: "BIND_ACTIVATE_FAILED" } },
    });
    expect((await fixture.getBinding()).bindStatus).toBe("pending");
    fixture.close();
  });
});
