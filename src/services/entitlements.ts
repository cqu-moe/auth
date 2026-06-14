import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { userEntitlement } from "../db/schema";
import { CAPABILITIES, PRESETS, SUBSYSTEMS, type Subsystem } from "../capabilities";

type Row = { subsystem: string; capability: string; value: string };
export type Caps = Record<string, Record<string, boolean | number | null>>;

export function rowsToCaps(rows: Row[], only?: Subsystem): Caps {
  const subs = (only ? [only] : SUBSYSTEMS) as Subsystem[];
  const out: Caps = {};
  for (const sub of subs) {
    out[sub] = {};
    for (const [key, def] of Object.entries(CAPABILITIES[sub])) {
      const row = rows.find((r) => r.subsystem === sub && r.capability === key);
      if (def.type === "flag") out[sub][key] = row?.value === "1";
      else
        // quota:仅接受纯非负整数串(`^\d+$`),否则视为未设(null=无限)——防恶意/脏行
        out[sub][key] = row && /^\d+$/.test(row.value) ? Number(row.value) : null;
    }
  }
  return out;
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
 *      quota → 必须匹配 /^\d+$/(非负整数串) 或 ""(空串约定无限)。
 *              "-1"/"abc"/"1.5"/"Infinity" 一律拒绝。
 * 输入不是数组也拒绝。
 */
export function validateEntitlementItems(items: Item[]): string | null {
  if (!Array.isArray(items)) return "items 必须是数组";
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
      // quota:非负整数串 或 ""(无限)
      if (value !== "" && !/^\d+$/.test(value)) {
        return `能力 ${subsystem}.${capability} 是配额,值必须是非负整数或留空(无限),收到：${value}`;
      }
    }
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
