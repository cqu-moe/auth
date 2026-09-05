ALTER TABLE `user`
  ADD COLUMN `twoFactorEnabled` INTEGER NOT NULL DEFAULT 0;

CREATE TABLE `twoFactor` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `secret` TEXT NOT NULL,
  `backupCodes` TEXT NOT NULL,
  `userId` TEXT NOT NULL,
  `verified` INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE INDEX `twoFactor_secret_idx` ON `twoFactor` (`secret`);
CREATE INDEX `twoFactor_userId_idx` ON `twoFactor` (`userId`);
