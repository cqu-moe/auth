-- 邀请码携带权益预设:注册使用该邀请码时,把对应预设写成新用户的 entitlement。
-- NULL = 不指定,回落到 entitlement_config.default_preset(与无码注册一致)。

ALTER TABLE `registration_invitation` ADD COLUMN `preset` TEXT;
