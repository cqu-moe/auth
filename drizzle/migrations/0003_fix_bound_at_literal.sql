-- 订正 bound_at 字面串脏数据（低风险，不重建表）
--
-- 背景：schema 里 boundAt 曾用 .default("(datetime('now'))")（JS 字符串），
-- Drizzle 把它当字符串字面量，INSERT 时作为绑定参数写入，导致存量行的
-- bound_at 实际存了字面文本 "(datetime('now'))" 而非时间戳。
-- 已在 schema 与 insert 路径修复（sql`` 表达式默认值 + 显式 boundAt）。
-- 这里一次性把残留的字面串行改写为当前时间戳。
--
-- 仅 UPDATE 受污染行（WHERE 精确匹配字面串），正常时间戳行不受影响。
-- 不做 table-recreate / ALTER COLUMN DEFAULT（SQLite 不支持且对 prod 有风险）。

UPDATE `cqu_credentials`
SET `bound_at` = datetime('now')
WHERE `bound_at` = '(datetime(''now''))';

UPDATE `cqu_bind_addresses`
SET `bound_at` = datetime('now')
WHERE `bound_at` = '(datetime(''now''))';
