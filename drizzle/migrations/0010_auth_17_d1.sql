-- Better Auth 1.7.7 additive migration. Preserve accounts, sessions, signing keys,
-- school bindings and entitlements. Legacy type/public retained for rollback only.
ALTER TABLE `jwks` ADD COLUMN `alg` text;
ALTER TABLE `jwks` ADD COLUMN `crv` text;
-- Existing keys remain byte-for-byte intact; derive metadata from each JWK.
UPDATE `jwks` SET `crv` = json_extract(`publicKey`, '$.crv'),
  `alg` = COALESCE(json_extract(`publicKey`, '$.alg'), CASE
    WHEN json_extract(`publicKey`, '$.kty') = 'OKP' THEN 'EdDSA'
    WHEN json_extract(`publicKey`, '$.kty') = 'RSA' THEN 'RS256'
    WHEN json_extract(`publicKey`, '$.crv') = 'P-256' THEN 'ES256'
    WHEN json_extract(`publicKey`, '$.crv') = 'P-384' THEN 'ES384'
    WHEN json_extract(`publicKey`, '$.crv') = 'P-521' THEN 'ES512'
  END) WHERE json_valid(`publicKey`);
ALTER TABLE `twoFactor` ADD COLUMN `failedVerificationCount` integer DEFAULT 0;
ALTER TABLE `twoFactor` ADD COLUMN `lockedUntil` text;
ALTER TABLE `oauthClient` ADD COLUMN `clientDiscoveryId` text;
ALTER TABLE `oauthClient` ADD COLUMN `clientCredentialsScopes` text DEFAULT '[]';
ALTER TABLE `oauthClient` ADD COLUMN `applicationType` text;
ALTER TABLE `oauthClient` ADD COLUMN `backchannelLogoutUri` text;
ALTER TABLE `oauthClient` ADD COLUMN `backchannelLogoutSessionRequired` integer;
ALTER TABLE `oauthClient` ADD COLUMN `jwks` text;
ALTER TABLE `oauthClient` ADD COLUMN `jwksUri` text;
ALTER TABLE `oauthClient` ADD COLUMN `dpopBoundAccessTokens` integer DEFAULT 0;
UPDATE `oauthClient` SET `applicationType` = CASE WHEN `type` = 'native' THEN 'native' ELSE 'web' END;
UPDATE `oauthClient` SET `tokenEndpointAuthMethod` = CASE WHEN `public` = 1 THEN 'none' ELSE 'client_secret_basic' END WHERE `tokenEndpointAuthMethod` IS NULL;
UPDATE `oauthClient` SET `requirePKCE` = 1;
ALTER TABLE `oauthRefreshToken` ADD COLUMN `authorizationCodeId` text;
ALTER TABLE `oauthRefreshToken` ADD COLUMN `resources` text;
ALTER TABLE `oauthRefreshToken` ADD COLUMN `requestedUserInfoClaims` text;
ALTER TABLE `oauthRefreshToken` ADD COLUMN `rotatedAt` text;
ALTER TABLE `oauthRefreshToken` ADD COLUMN `rotationReplayResponse` text;
ALTER TABLE `oauthRefreshToken` ADD COLUMN `rotationReplayExpiresAt` text;
ALTER TABLE `oauthRefreshToken` ADD COLUMN `confirmation` text;
ALTER TABLE `oauthAccessToken` ADD COLUMN `authorizationCodeId` text;
ALTER TABLE `oauthAccessToken` ADD COLUMN `resources` text;
ALTER TABLE `oauthAccessToken` ADD COLUMN `requestedUserInfoClaims` text;
ALTER TABLE `oauthAccessToken` ADD COLUMN `revoked` text;
ALTER TABLE `oauthAccessToken` ADD COLUMN `confirmation` text;
ALTER TABLE `oauthConsent` ADD COLUMN `resources` text;
ALTER TABLE `oauthConsent` ADD COLUMN `requestedUserInfoClaims` text;
CREATE INDEX `idx_oauthRefreshToken_authorizationCodeId` ON `oauthRefreshToken` (`authorizationCodeId`);
CREATE INDEX `idx_oauthAccessToken_authorizationCodeId` ON `oauthAccessToken` (`authorizationCodeId`);
CREATE TABLE IF NOT EXISTS `rateLimit` (
  `id` text PRIMARY KEY NOT NULL,
  `key` text NOT NULL UNIQUE,
  `count` integer NOT NULL,
  `lastRequest` integer NOT NULL
);
CREATE TABLE IF NOT EXISTS `oauthResource` (
  `id` text PRIMARY KEY NOT NULL,
  `identifier` text NOT NULL UNIQUE,
  `name` text NOT NULL,
  `accessTokenTtl` integer,
  `refreshTokenTtl` integer,
  `signingAlgorithm` text,
  `signingKeyId` text,
  `allowedScopes` text,
  `customClaims` text,
  `dpopBoundAccessTokensRequired` integer DEFAULT 0,
  `disabled` integer DEFAULT 0,
  `createdAt` text,
  `updatedAt` text,
  `policyVersion` integer DEFAULT 1,
  `metadata` text
);
CREATE TABLE IF NOT EXISTS `oauthClientResource` (
  `id` text PRIMARY KEY NOT NULL,
  `clientId` text NOT NULL REFERENCES `oauthClient` (`clientId`) ON DELETE CASCADE,
  `resourceId` text NOT NULL REFERENCES `oauthResource` (`identifier`) ON DELETE CASCADE,
  `metadata` text,
  `createdAt` text,
  UNIQUE (`clientId`, `resourceId`)
);
CREATE INDEX `idx_oauthClientResource_resourceId` ON `oauthClientResource` (`resourceId`);
CREATE TABLE IF NOT EXISTS `oauthClientAssertion` (
  `id` text PRIMARY KEY NOT NULL,
  `expiresAt` text NOT NULL
);
