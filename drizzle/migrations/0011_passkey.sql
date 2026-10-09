-- Native @better-auth/passkey schema. Private key material stays on authenticators.
CREATE TABLE `passkey` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text,
  `publicKey` text NOT NULL,
  `userId` text NOT NULL REFERENCES `user` (`id`) ON DELETE CASCADE,
  `credentialID` text NOT NULL,
  `counter` integer NOT NULL,
  `deviceType` text NOT NULL,
  `backedUp` integer NOT NULL,
  `transports` text,
  `createdAt` text,
  `aaguid` text
);
CREATE INDEX `passkey_userId_idx` ON `passkey` (`userId`);
CREATE UNIQUE INDEX `passkey_credentialID_idx` ON `passkey` (`credentialID`);
