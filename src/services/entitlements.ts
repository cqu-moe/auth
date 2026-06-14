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
