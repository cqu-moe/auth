import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { twoFactor, user } from "./schema";

describe("Better Auth two-factor schema", () => {
  it("defines the user flag and the twoFactor table", () => {
    expect(getTableColumns(user).twoFactorEnabled).toBeDefined();
    expect(Object.keys(getTableColumns(twoFactor))).toEqual([
      "id",
      "secret",
      "backupCodes",
      "userId",
      "verified",
    ]);
  });

  it("migrates existing users as not enrolled", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE user (id TEXT PRIMARY KEY NOT NULL);
      INSERT INTO user (id) VALUES ('existing-user');
    `);
    database.exec(
      readFileSync(
        new URL("../../drizzle/migrations/0006_two_factor.sql", import.meta.url),
        "utf8"
      )
    );

    expect(
      database.prepare("SELECT twoFactorEnabled FROM user WHERE id = ?")
        .get("existing-user")
    ).toEqual({ twoFactorEnabled: 0 });
    expect(
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'twoFactor'")
        .get()
    ).toEqual({ name: "twoFactor" });
    database.close();
  });
});
