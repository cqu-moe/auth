import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { userEntitlement } from "../db/schema";
import { CAPABILITIES, SUBSYSTEMS, type Subsystem } from "../capabilities";

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
