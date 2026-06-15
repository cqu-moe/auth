-- 分级权益(entitlements):per-user × subsystem × capability 的细粒度授权(事实源)。
-- App 自有表,走 drizzle-orm/d1 查询(非 Better Auth Kysely adapter)。

CREATE TABLE IF NOT EXISTS `user_entitlement` (
  `user_id` TEXT NOT NULL,
  `subsystem` TEXT NOT NULL,
  `capability` TEXT NOT NULL,
  `value` TEXT NOT NULL,
  `updated_at` TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (`user_id`, `subsystem`, `capability`)
);

CREATE INDEX IF NOT EXISTS `idx_user_entitlement_user_id` ON `user_entitlement`(`user_id`);
