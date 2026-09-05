-- 注册邀请：短明文 code，单次使用，默认由应用层写入 7 天有效期。
-- claim_* 是注册期间的短租约，防止同一邀请码被并发消费。

CREATE TABLE IF NOT EXISTS `registration_invitation` (
  `code` TEXT PRIMARY KEY COLLATE NOCASE,
  `created_by` TEXT NOT NULL,
  `created_at` TEXT NOT NULL DEFAULT (datetime('now')),
  `expires_at` TEXT NOT NULL,
  `claimed_at` TEXT,
  `claimed_by_email` TEXT,
  `claim_token` TEXT UNIQUE,
  `used_at` TEXT,
  `used_by_user_id` TEXT,
  `revoked_at` TEXT,
  CHECK (length(`code`) = 8)
);

CREATE INDEX IF NOT EXISTS `idx_registration_invitation_created_at`
  ON `registration_invitation`(`created_at` DESC);

CREATE INDEX IF NOT EXISTS `idx_registration_invitation_used_by_user_id`
  ON `registration_invitation`(`used_by_user_id`);
