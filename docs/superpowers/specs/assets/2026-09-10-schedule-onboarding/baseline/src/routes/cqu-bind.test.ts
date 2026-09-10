import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { cquBinding } from "./cqu-bind";
import type { Env } from "../types";

vi.mock("../auth", () => ({
  createAuth: () => ({
    api: { getSession: async () => ({ user: { id: "current-user" } }) },
  }),
}));

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));

function bindingResponse(credentialsStatus: string | null, addressStatus: string | null) {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec(`
    CREATE TABLE cqu_credentials (user_id TEXT, status TEXT);
    CREATE TABLE cqu_bind_addresses (
      token TEXT, user_id TEXT, kind TEXT, sender_whitelist TEXT,
      status TEXT, bound_at TEXT, last_code_at TEXT
    );
    INSERT INTO cqu_credentials VALUES ('other-user', 'active');
  `);
  if (credentialsStatus) {
    database.prepare("INSERT INTO cqu_credentials VALUES (?, ?)")
      .run("current-user", credentialsStatus);
  }
  if (addressStatus) {
    database.prepare("INSERT INTO cqu_bind_addresses (token, user_id, status) VALUES (?, ?, ?)")
      .run("test-address", "current-user", addressStatus);
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
      bindStatus: expected,
      sessionStatus: { status: "idle" },
    });
  });
});
