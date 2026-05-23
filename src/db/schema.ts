import { sqliteTable, text, primaryKey } from "drizzle-orm/sqlite-core";

export const cquCredentials = sqliteTable("cqu_credentials", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().unique(),
  studentId: text("student_id").notNull(),
  encryptedPassword: text("encrypted_password").notNull(),
  iv: text("iv").notNull(),
  boundAt: text("bound_at").notNull().default("(datetime('now'))"),
  lastLoginAt: text("last_login_at"),
  status: text("status").notNull().default("active"),
});

export const oauthClientCquScopes = sqliteTable(
  "oauth_client_cqu_scopes",
  {
    clientId: text("client_id").notNull(),
    scope: text("scope").notNull(),
  },
  (table) => [primaryKey({ columns: [table.clientId, table.scope] })]
);
