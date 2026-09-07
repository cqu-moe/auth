import { drizzle } from "drizzle-orm/d1";
import { eq, sql } from "drizzle-orm";
import { entitlementConfig, entitlementPreset, userEntitlement } from "../db/schema";
import { CAPABILITIES, PRESETS, SUBSYSTEMS, type Subsystem } from "../capabilities";

type Row = { subsystem: string; capability: string; value: string };
export type Caps = Record<string, Record<string, boolean | number | null>>;
// schedule 离线消费的形状(只 calendar 片;见 issue #7 / AuthService.getCaps)。
export type CalendarCaps = Caps["calendar"];

export function rowsToCaps(rows: Row[], only?: Subsystem): Caps {
  const subs = (only ? [only] : SUBSYSTEMS) as Subsystem[];
  const out: Caps = {};
  for (const sub of subs) {
    out[sub] = {};
    for (const [key, def] of Object.entries(CAPABILITIES[sub])) {
      const row = rows.find((r) => r.subsystem === sub && r.capability === key);
      if (def.type === "flag") out[sub][key] = row?.value === "1";
      else
        // quota:仅接受纯非负整数串(`^\d+$`)且在 JS 安全整数范围内,否则视为未设(null=无限)。
        // 仅 `^\d+$` 不够:任意长数字串(如 30 位)会被 Number() 解析成 Infinity/失精浮点,
        // 下游把超出真实值的数字当配额 → 配额绕过。写侧(validateEntitlementItems)现已拒
        // 存溢出值,故此处 null 兜底只为防御脏行/历史遗留数据。
        out[sub][key] =
          row && /^\d+$/.test(row.value) && Number.isSafeInteger(Number(row.value))
            ? Number(row.value)
            : null;
    }
  }
  return out;
}

/**
 * 把权益行收敛成 RPC getCaps(`AuthService.getCaps`,见 issue #7)的返回形状。
 *  - 零行 → null:等同「用户不存在/无任何权益」。schedule 离线 cron 据此 fail-closed
 *    (硬撤销 = 删光行 → 自然停同步、停公开链接;撤销终态正确)。
 *  - 有行 → 只盖 calendar 片(最小披露:schedule 仅消费 calendar,eval/cqu 绝不外泄)。
 *    形状与 verifySession 返回的 caps.calendar 一致(#6 七字段)。仅有非-calendar 行时,
 *    calendar 片为全 false/null —— 语义是「用户存在但无 calendar 权益」,schedule 同样不开同步。
 * 纯函数(不碰 DB),便于 Node-pool 单测;DB 取行交给 resolveCapsForRpc。
 */
export function rowsToCapsForRpc(rows: Row[]): { calendar: CalendarCaps } | null {
  if (rows.length === 0) return null;
  return { calendar: rowsToCaps(rows, "calendar").calendar };
}

/**
 * 决定一张 access token 该盖哪个 subsystem 的 caps。返回 null = 不盖任何 caps(留空 {}),
 * 这是安全红线:拿不到 client→subsystem 映射时绝不盖全量。
 *  - 无 user(client_credentials/M2M)→ null
 *  - metadata 无 subsystem 或非字符串 → null
 *  - subsystem 不在已知目录(含被改坏的值)→ null
 */
export function subsystemForAccessToken(info: {
  user?: { id: string } | null | undefined;
  metadata?: Record<string, unknown> | null | undefined;
}): Subsystem | null {
  if (!info.user) return null;
  const sub = info.metadata?.subsystem;
  if (typeof sub !== "string") return null;
  if (!(SUBSYSTEMS as string[]).includes(sub)) return null;
  return sub as Subsystem;
}

type Item = { subsystem: string; capability: string; value: string };

/**
 * 校验 admin 提交的 entitlement 写入项(整组替换/预设套用前置)。
 * 全部合法返回 null,否则返回首个非法项的中文错误描述。一项合法当且仅当:
 *  - subsystem 是 CAPABILITIES 的键;
 *  - capability 是 CAPABILITIES[subsystem] 的键;
 *  - value 与能力类型匹配:
 *      flag  → 必须恰为 "1"(授予 flag = 写一行 value="1";撤销 = 删行)。
 *              "0"/"true"/"" 一律拒绝;
 *      quota → 必须匹配 /^\d+$/(非负整数串) 且在 JS 安全整数范围内(Number.isSafeInteger),
 *              或 ""(空串约定无限)。"-1"/"abc"/"1.5"/"Infinity" 及溢出安全整数的超长数字串
 *              (如 20 位)一律拒绝 —— 否则存下后 rowsToCaps 会失精/变 Infinity → 配额绕过。
 * 输入不是数组也拒绝。
 */
export function validateEntitlementItems(items: Item[]): string | null {
  if (!Array.isArray(items)) return "items 必须是数组";
  // 去重防护:整组替换是 delete-all + insert。若有重复的 (subsystem, capability) 对,
  // delete 已清空、insert 会撞复合主键失败 → 用户 entitlement 被静默清空。提前拒绝。
  const seen = new Set<string>();
  for (const item of items) {
    const { subsystem, capability, value } = item ?? {};
    const subDefs = (CAPABILITIES as Record<string, Record<string, { type: string }>>)[
      subsystem
    ];
    if (!subDefs) return `未知子系统：${subsystem}`;
    const def = subDefs[capability];
    if (!def) return `未知能力：${subsystem}.${capability}`;
    if (def.type === "flag") {
      if (value !== "1") {
        return `能力 ${subsystem}.${capability} 是开关,值必须为 "1"(撤销请删除该行),收到：${value}`;
      }
    } else {
      // quota:非负整数串(且在 JS 安全整数范围内) 或 ""(无限)。
      // 仅 /^\d+$/ 会放过任意长数字串,存下后 rowsToCaps 解析成 Infinity/失精 → 配额绕过。
      // 这里在写侧就拒掉溢出值,从源头杜绝。
      if (
        value !== "" &&
        (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
      ) {
        return `能力 ${subsystem}.${capability} 是配额,值必须是非负整数或留空(无限),收到：${value}`;
      }
    }
    // 复合主键就是 (subsystem, capability)。两键均已校验为目录里的合法标识符,
    // 用 NUL(\u0000)作分隔避免不同拼接产生同一字符串的歧义碰撞。
    const key = `${subsystem}\u0000${capability}`;
    if (seen.has(key)) return `重复的能力项：${subsystem}.${capability}`;
    seen.add(key);
  }
  return null;
}

/**
 * 把命名预设展开成 entitlement 写入项。name 不是 PRESETS 的键 → null。
 * 值翻译:数字 → String(n);null → ""(quota 无限约定)。
 */
export function presetToItems(name: string): Item[] | null {
  const preset = PRESETS[name];
  if (!preset) return null;
  const items: Item[] = [];
  for (const [subsystem, caps] of Object.entries(preset)) {
    for (const [capability, raw] of Object.entries(caps)) {
      items.push({
        subsystem,
        capability,
        value: raw === null ? "" : String(raw),
      });
    }
  }
  return items;
}

export async function resolveCaps(
  db: D1Database,
  userId: string,
  only?: Subsystem
): Promise<Caps> {
  const rows = await drizzle(db)
    .select()
    .from(userEntitlement)
    .where(eq(userEntitlement.userId, userId))
    .all();
  return rowsToCaps(rows, only);
}

/**
 * RPC getCaps 的 DB 包装:直查 user_entitlement(无 cookie/session),交 rowsToCapsForRpc
 * 收敛成 { calendar } | null。供 AuthService.getCaps(离线 schedule 同步)调用。
 */
export async function resolveCapsForRpc(
  db: D1Database,
  userId: string
): Promise<{ calendar: CalendarCaps } | null> {
  const rows = await drizzle(db)
    .select()
    .from(userEntitlement)
    .where(eq(userEntitlement.userId, userId))
    .all();
  return rowsToCapsForRpc(rows);
}

// ── DB 预设与默认权益 ────────────────────────────────────────────────────────
// 事实源已落库(migration 0007):entitlement_preset 存预设,entitlement_config 存
// default_preset(新注册用户自动套用的预设名)。capabilities.ts 的 PRESETS 常量仅作
// 历史快照/种子来源保留。预设项与 user_entitlement 走同一套校验与写入约定。

export interface PresetRecord {
  name: string;
  items: Item[];
  updatedAt?: string;
}

const DEFAULT_PRESET_KEY = "default_preset";
// 注册政策开关:"1" = 必须有邀请码才能注册(缺省值,保持历史行为);
// "0" = 无邀请码也可注册(按 default_preset 给权益)。
const INVITATION_REQUIRED_KEY = "invitation_required";

// 解析 DB 里的 items JSON。形状不对(非数组/字段缺失)返回 null,交给调用方
// 按「未知预设」处理 —— 坏数据绝不进入写入路径。
export function parsePresetItems(json: string): Item[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  for (const raw of parsed) {
    if (
      !raw ||
      typeof raw !== "object" ||
      typeof (raw as Item).subsystem !== "string" ||
      typeof (raw as Item).capability !== "string" ||
      typeof (raw as Item).value !== "string"
    ) {
      return null;
    }
  }
  return parsed as Item[];
}

export async function listPresets(db: D1Database): Promise<PresetRecord[]> {
  const rows = await drizzle(db).select().from(entitlementPreset).all();
  const out: PresetRecord[] = [];
  for (const row of rows) {
    const items = parsePresetItems(row.items);
    if (items) out.push({ name: row.name, items, updatedAt: row.updatedAt });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

// 按名取预设项。不存在或 items 损坏 → null。
export async function getPresetItems(
  db: D1Database,
  name: string
): Promise<Item[] | null> {
  const row = await drizzle(db)
    .select()
    .from(entitlementPreset)
    .where(eq(entitlementPreset.name, name))
    .get();
  if (!row) return null;
  return parsePresetItems(row.items);
}

// upsert 预设。name 为空串拒绝;items 必须先过 validateEntitlementItems。
export async function upsertPreset(
  db: D1Database,
  name: string,
  items: Item[]
): Promise<void> {
  const d = drizzle(db);
  await d
    .insert(entitlementPreset)
    .values({ name, items: JSON.stringify(items) })
    .onConflictDoUpdate({
      target: entitlementPreset.name,
      // 与列默认值同样的 sqlite 日期格式(YYYY-MM-DD HH:MM:SS),避免混入 ISO 串。
      set: { items: JSON.stringify(items), updatedAt: sql`(datetime('now'))` },
    });
}

export async function deletePreset(db: D1Database, name: string): Promise<void> {
  await drizzle(db)
    .delete(entitlementPreset)
    .where(eq(entitlementPreset.name, name));
}

// 读取默认预设名;未配置返回 null。
export async function getDefaultPresetName(db: D1Database): Promise<string | null> {
  const row = await drizzle(db)
    .select()
    .from(entitlementConfig)
    .where(eq(entitlementConfig.key, DEFAULT_PRESET_KEY))
    .get();
  return row?.value ?? null;
}

// 设置/清除默认预设(null = 清除)。预设名存在性由调用方保证。
export async function setDefaultPresetName(
  db: D1Database,
  name: string | null
): Promise<void> {
  const d = drizzle(db);
  if (name === null) {
    await d
      .delete(entitlementConfig)
      .where(eq(entitlementConfig.key, DEFAULT_PRESET_KEY));
    return;
  }
  await d
    .insert(entitlementConfig)
    .values({ key: DEFAULT_PRESET_KEY, value: name })
    .onConflictDoUpdate({
      target: entitlementConfig.key,
      set: { value: name, updatedAt: sql`(datetime('now'))` },
    });
}

// 注册后钩子:把默认预设写成新用户的 entitlement 行。
// 未配置默认预设、预设被删、或预设无项 → 安全 no-op(新用户零行 = fail-closed)。
// 出错抛给调用方;注册流程侧负责 catch + 记日志,不让注册失败。
export async function applyDefaultEntitlements(
  db: D1Database,
  userId: string
): Promise<number> {
  const name = await getDefaultPresetName(db);
  if (!name) return 0;
  return applyPresetEntitlements(db, userId, name);
}

// 把指定预设写成用户的 entitlement 行(注册场景:用户尚无行,纯 insert)。
// 预设不存在或无项 → 安全 no-op。返回写入行数。
export async function applyPresetEntitlements(
  db: D1Database,
  userId: string,
  name: string
): Promise<number> {
  const items = await getPresetItems(db, name);
  if (!items || items.length === 0) return 0;
  await drizzle(db)
    .insert(userEntitlement)
    .values(items.map((it) => ({ userId, ...it })));
  return items.length;
}

// 注册是否强制邀请码。缺省 true:与引入开关前的行为一致(邀请码制)。
export async function isInvitationRequired(db: D1Database): Promise<boolean> {
  const row = await drizzle(db)
    .select()
    .from(entitlementConfig)
    .where(eq(entitlementConfig.key, INVITATION_REQUIRED_KEY))
    .get();
  return row?.value !== "0";
}

export async function setInvitationRequired(
  db: D1Database,
  required: boolean
): Promise<void> {
  await drizzle(db)
    .insert(entitlementConfig)
    .values({ key: INVITATION_REQUIRED_KEY, value: required ? "1" : "0" })
    .onConflictDoUpdate({
      target: entitlementConfig.key,
      set: { value: required ? "1" : "0", updatedAt: sql`(datetime('now'))` },
    });
}
