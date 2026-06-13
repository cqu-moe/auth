import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// Better Auth core tables

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("emailVerified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  createdAt: text("createdAt").notNull(),
  updatedAt: text("updatedAt").notNull(),
  role: text("role"),
  banned: integer("banned", { mode: "boolean" }).default(false),
  banReason: text("banReason"),
  banExpires: text("banExpires"),
});

export const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: text("expiresAt").notNull(),
  token: text("token").notNull().unique(),
  createdAt: text("createdAt").notNull(),
  updatedAt: text("updatedAt").notNull(),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  userId: text("userId").notNull().references(() => user.id, { onDelete: "cascade" }),
  impersonatedBy: text("impersonatedBy"),
  timezone: text("timezone"),
  city: text("city"),
  country: text("country"),
  region: text("region"),
  regionCode: text("regionCode"),
  colo: text("colo"),
  latitude: text("latitude"),
  longitude: text("longitude"),
});

export const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  userId: text("userId").notNull().references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  idToken: text("idToken"),
  accessTokenExpiresAt: text("accessTokenExpiresAt"),
  refreshTokenExpiresAt: text("refreshTokenExpiresAt"),
  scope: text("scope"),
  password: text("password"),
  createdAt: text("createdAt").notNull(),
  updatedAt: text("updatedAt").notNull(),
});

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: text("expiresAt").notNull(),
  createdAt: text("createdAt").notNull(),
  updatedAt: text("updatedAt").notNull(),
});

// App-specific tables

export const cquCredentials = sqliteTable("cqu_credentials", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().unique(),
  studentId: text("student_id").notNull(),
  encryptedPassword: text("encrypted_password").notNull(),
  iv: text("iv").notNull(),
  // SQL 表达式默认值：必须用 sql`` 包裹，否则 Drizzle 把它当字符串字面量，
  // 既污染 DDL 默认值，又会在 INSERT 时作为绑定参数写入字面串 "(datetime('now'))"。
  boundAt: text("bound_at").notNull().default(sql`(datetime('now'))`),
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

export const cquBindAddresses = sqliteTable("cqu_bind_addresses", {
  token: text("token").primaryKey(),                    // 专属地址本地部分（随机不可枚举）
  userId: text("user_id").notNull().unique(),
  kind: text("kind").notNull().default("direct"),       // direct | forward
  senderWhitelist: text("sender_whitelist").notNull(),  // JSON 字符串数组
  status: text("status").notNull().default("pending"),  // pending | active | revoked
  // SQL 表达式默认值：必须用 sql`` 包裹，否则 Drizzle 把它当字符串字面量，
  // 既污染 DDL 默认值，又会在 INSERT 时作为绑定参数写入字面串 "(datetime('now'))"。
  boundAt: text("bound_at").notNull().default(sql`(datetime('now'))`),
  lastCodeAt: text("last_code_at"),
});
