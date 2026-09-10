CREATE TABLE IF NOT EXISTS `quicklogin_account_projection` (
  `user_id` TEXT PRIMARY KEY NOT NULL,
  `revision` INTEGER NOT NULL,
  `device_limit` INTEGER NOT NULL,
  `master_enabled` INTEGER NOT NULL,
  `updated_at` INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS `quicklogin_device_projection` (
  `device_id` TEXT PRIMARY KEY NOT NULL,
  `user_id` TEXT NOT NULL,
  `revision` INTEGER NOT NULL,
  `payload_json` TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS `idx_quicklogin_device_projection_user_id`
  ON `quicklogin_device_projection` (`user_id`);
