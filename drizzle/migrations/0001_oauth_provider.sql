-- OAuth 2.1 Provider tables (jwt + @better-auth/oauth-provider plugins)

CREATE TABLE IF NOT EXISTS `jwks` (
  `id` text PRIMARY KEY NOT NULL,
  `publicKey` text NOT NULL,
  `privateKey` text NOT NULL,
  `createdAt` text NOT NULL,
  `expiresAt` text
);

CREATE TABLE IF NOT EXISTS `oauthClient` (
  `id` text PRIMARY KEY NOT NULL,
  `clientId` text NOT NULL UNIQUE,
  `clientSecret` text,
  `disabled` integer DEFAULT 0,
  `skipConsent` integer,
  `enableEndSession` integer,
  `subjectType` text,
  `scopes` text,
  `userId` text REFERENCES `user`(`id`),
  `createdAt` text,
  `updatedAt` text,
  `name` text,
  `uri` text,
  `icon` text,
  `contacts` text,
  `tos` text,
  `policy` text,
  `softwareId` text,
  `softwareVersion` text,
  `softwareStatement` text,
  `redirectUris` text NOT NULL,
  `postLogoutRedirectUris` text,
  `tokenEndpointAuthMethod` text,
  `grantTypes` text,
  `responseTypes` text,
  `public` integer,
  `type` text,
  `requirePKCE` integer,
  `referenceId` text,
  `metadata` text
);

CREATE INDEX IF NOT EXISTS `idx_oauthClient_userId` ON `oauthClient`(`userId`);

CREATE TABLE IF NOT EXISTS `oauthRefreshToken` (
  `id` text PRIMARY KEY NOT NULL,
  `token` text NOT NULL UNIQUE,
  `clientId` text NOT NULL REFERENCES `oauthClient`(`clientId`),
  `sessionId` text REFERENCES `session`(`id`) ON DELETE SET NULL,
  `userId` text NOT NULL REFERENCES `user`(`id`),
  `referenceId` text,
  `expiresAt` text,
  `createdAt` text,
  `revoked` text,
  `authTime` text,
  `scopes` text NOT NULL
);

CREATE INDEX IF NOT EXISTS `idx_oauthRefreshToken_clientId` ON `oauthRefreshToken`(`clientId`);
CREATE INDEX IF NOT EXISTS `idx_oauthRefreshToken_sessionId` ON `oauthRefreshToken`(`sessionId`);
CREATE INDEX IF NOT EXISTS `idx_oauthRefreshToken_userId` ON `oauthRefreshToken`(`userId`);

CREATE TABLE IF NOT EXISTS `oauthAccessToken` (
  `id` text PRIMARY KEY NOT NULL,
  `token` text UNIQUE,
  `clientId` text NOT NULL REFERENCES `oauthClient`(`clientId`),
  `sessionId` text REFERENCES `session`(`id`) ON DELETE SET NULL,
  `userId` text REFERENCES `user`(`id`),
  `referenceId` text,
  `refreshId` text REFERENCES `oauthRefreshToken`(`id`),
  `expiresAt` text,
  `createdAt` text,
  `scopes` text NOT NULL
);

CREATE INDEX IF NOT EXISTS `idx_oauthAccessToken_clientId` ON `oauthAccessToken`(`clientId`);
CREATE INDEX IF NOT EXISTS `idx_oauthAccessToken_sessionId` ON `oauthAccessToken`(`sessionId`);
CREATE INDEX IF NOT EXISTS `idx_oauthAccessToken_userId` ON `oauthAccessToken`(`userId`);
CREATE INDEX IF NOT EXISTS `idx_oauthAccessToken_refreshId` ON `oauthAccessToken`(`refreshId`);

CREATE TABLE IF NOT EXISTS `oauthConsent` (
  `id` text PRIMARY KEY NOT NULL,
  `clientId` text NOT NULL REFERENCES `oauthClient`(`clientId`),
  `userId` text REFERENCES `user`(`id`),
  `referenceId` text,
  `scopes` text NOT NULL,
  `createdAt` text,
  `updatedAt` text
);

CREATE INDEX IF NOT EXISTS `idx_oauthConsent_clientId` ON `oauthConsent`(`clientId`);
CREATE INDEX IF NOT EXISTS `idx_oauthConsent_userId` ON `oauthConsent`(`userId`);
