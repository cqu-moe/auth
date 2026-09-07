-- 权益预设与默认权益配置:把 src/capabilities.ts 里的代码常量 PRESETS 落库,
-- 让 superAdmin 能在管理台直接增删改预设,并指定新注册用户自动套用的默认预设。
-- items 为 JSON 数组 [{subsystem,capability,value}],值约定同 user_entitlement.value
-- (flag:'1';quota:数字串;'' 约定无限)。写入前一律过 validateEntitlementItems。

CREATE TABLE IF NOT EXISTS `entitlement_preset` (
  `name` TEXT PRIMARY KEY,
  `items` TEXT NOT NULL,
  `updated_at` TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS `entitlement_config` (
  `key` TEXT PRIMARY KEY,
  `value` TEXT NOT NULL,
  `updated_at` TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 初始数据 = 代码常量 PRESETS(src/capabilities.ts)的快照;此后以库为准,代码常量仅作历史参考。
INSERT OR IGNORE INTO `entitlement_preset` (`name`, `items`) VALUES
  ('学生', '[{"subsystem":"calendar","capability":"sync","value":"1"},{"subsystem":"calendar","capability":"external","value":"1"},{"subsystem":"calendar","capability":"sub_limit","value":"50"},{"subsystem":"calendar","capability":"sync_interval","value":"360"},{"subsystem":"calendar","capability":"manual_refresh","value":"5"},{"subsystem":"eval","capability":"submit","value":"1"}]'),
  ('助教', '[{"subsystem":"calendar","capability":"sync","value":"1"},{"subsystem":"calendar","capability":"external","value":"1"},{"subsystem":"calendar","capability":"share","value":"1"},{"subsystem":"calendar","capability":"sub_limit","value":""},{"subsystem":"calendar","capability":"share_limit","value":""},{"subsystem":"calendar","capability":"sync_interval","value":"60"},{"subsystem":"calendar","capability":"manual_refresh","value":""},{"subsystem":"eval","capability":"submit","value":"1"},{"subsystem":"eval","capability":"batch","value":"1"}]');
