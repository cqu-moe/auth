import { sqliteTable, text, integer, primaryKey, index } from "drizzle-orm/sqlite-core";
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
  twoFactorEnabled: integer("twoFactorEnabled", { mode: "boolean" })
    .notNull()
    .default(false),
});

export const twoFactor = sqliteTable(
  "twoFactor",
  {
    id: text("id").primaryKey(),
    secret: text("secret").notNull(),
    backupCodes: text("backupCodes").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    verified: integer("verified", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    index("twoFactor_secret_idx").on(table.secret),
    index("twoFactor_userId_idx").on(table.userId),
  ]
);

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

export const userEntitlement = sqliteTable(
  "user_entitlement",
  {
    userId: text("user_id").notNull(),
    subsystem: text("subsystem").notNull(),
    capability: text("capability").notNull(),
    value: text("value").notNull(), // flag:'1' | quota:数字串 | '' 约定无限
    // SQL 表达式默认值必须 sql`` 包裹(否则 Drizzle 当字符串字面量,污染 DDL 且 INSERT 写入字面串)。
    updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.subsystem, table.capability] }),
  ]
);

// 权益预设:管理台可编辑的命名授权组合(原代码常量 PRESETS 的落库版)。
// items 为 JSON 数组 [{subsystem,capability,value}],值约定同 user_entitlement.value。
export const entitlementPreset = sqliteTable("entitlement_preset", {
  name: text("name").primaryKey(),
  items: text("items").notNull(), // JSON:[{subsystem,capability,value}]
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

// 权益相关全局配置(k/v)。目前唯一键:default_preset = 新注册用户自动套用的预设名;
// 无此行 = 新用户不带任何默认权益(fail-closed,等同零行)。
export const entitlementConfig = sqliteTable("entitlement_config", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const registrationInvitation = sqliteTable("registration_invitation", {
  code: text("code").primaryKey(),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  expiresAt: text("expires_at").notNull(),
  claimedAt: text("claimed_at"),
  claimedByEmail: text("claimed_by_email"),
  claimToken: text("claim_token").unique(),
  usedAt: text("used_at"),
  usedByUserId: text("used_by_user_id"),
  revokedAt: text("revoked_at"),
});
