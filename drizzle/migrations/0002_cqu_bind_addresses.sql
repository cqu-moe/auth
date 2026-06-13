-- CQU 2FA 邮件取码无人值守会话重绑：专属收件地址 → userId 映射 + 发件人白名单

CREATE TABLE IF NOT EXISTS `cqu_bind_addresses` (
  `token` TEXT PRIMARY KEY NOT NULL,
  `user_id` TEXT NOT NULL UNIQUE,
  `kind` TEXT NOT NULL DEFAULT 'direct',
  `sender_whitelist` TEXT NOT NULL,
  `status` TEXT NOT NULL DEFAULT 'pending',
  `bound_at` TEXT NOT NULL DEFAULT (datetime('now')),
  `last_code_at` TEXT
);
