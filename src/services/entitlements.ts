import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { userEntitlement } from "../db/schema";
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
