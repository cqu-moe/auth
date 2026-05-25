-- Better Auth core tables + admin plugin + cloudflare geolocation plugin
-- Table names are singular (usePlural: false)

CREATE TABLE IF NOT EXISTS `user` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `name` TEXT NOT NULL,
  `email` TEXT NOT NULL UNIQUE,
  `emailVerified` INTEGER NOT NULL DEFAULT 0,
  `image` TEXT,
  `createdAt` TEXT NOT NULL,
  `updatedAt` TEXT NOT NULL,
  `role` TEXT,
  `banned` INTEGER DEFAULT 0,
  `banReason` TEXT,
  `banExpires` TEXT
);

CREATE TABLE IF NOT EXISTS `session` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `expiresAt` TEXT NOT NULL,
  `token` TEXT NOT NULL UNIQUE,
  `createdAt` TEXT NOT NULL,
  `updatedAt` TEXT NOT NULL,
  `ipAddress` TEXT,
  `userAgent` TEXT,
  `userId` TEXT NOT NULL REFERENCES `user`(`id`) ON DELETE CASCADE,
  `impersonatedBy` TEXT,
  `timezone` TEXT,
  `city` TEXT,
  `country` TEXT,
  `region` TEXT,
  `regionCode` TEXT,
  `colo` TEXT,
  `latitude` TEXT,
  `longitude` TEXT
);

CREATE TABLE IF NOT EXISTS `account` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `accountId` TEXT NOT NULL,
  `providerId` TEXT NOT NULL,
  `userId` TEXT NOT NULL REFERENCES `user`(`id`) ON DELETE CASCADE,
  `accessToken` TEXT,
  `refreshToken` TEXT,
  `idToken` TEXT,
  `accessTokenExpiresAt` TEXT,
  `refreshTokenExpiresAt` TEXT,
  `scope` TEXT,
  `password` TEXT,
  `createdAt` TEXT NOT NULL,
  `updatedAt` TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS `verification` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `identifier` TEXT NOT NULL,
  `value` TEXT NOT NULL,
  `expiresAt` TEXT NOT NULL,
  `createdAt` TEXT NOT NULL,
  `updatedAt` TEXT NOT NULL
);

-- Custom app tables
CREATE TABLE IF NOT EXISTS `cqu_credentials` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `user_id` TEXT NOT NULL UNIQUE,
  `student_id` TEXT NOT NULL,
  `encrypted_password` TEXT NOT NULL,
  `iv` TEXT NOT NULL,
  `bound_at` TEXT NOT NULL DEFAULT (datetime('now')),
  `last_login_at` TEXT,
  `status` TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS `oauth_client_cqu_scopes` (
  `client_id` TEXT NOT NULL,
  `scope` TEXT NOT NULL,
  PRIMARY KEY (`client_id`, `scope`)
);

-- Indexes for frequently queried columns
CREATE INDEX IF NOT EXISTS `idx_session_userId` ON `session`(`userId`);
CREATE INDEX IF NOT EXISTS `idx_session_token` ON `session`(`token`);
CREATE INDEX IF NOT EXISTS `idx_account_userId` ON `account`(`userId`);
CREATE INDEX IF NOT EXISTS `idx_verification_identifier` ON `verification`(`identifier`);
