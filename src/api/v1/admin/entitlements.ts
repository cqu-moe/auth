import { Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { createAuth } from "../../../auth";
import { userEntitlement } from "../../../db/schema";
import { requireAdmin } from "../../../middleware/authentication";
import {
  deletePreset,
  getDefaultPresetName,
  getPresetItems,
  listPresets,
  setDefaultPresetName,
  upsertPreset,
  validateEntitlementItems,
} from "../../../services/entitlements";
import type { HonoEnv } from "../../../types";
import {
  assertGenericEntitlementWriteAllowed,
  isQuickloginPolicyItem,
  QuickloginQuotaAdminError,
} from "../../../services/quicklogin/quota-admin";
import { problem } from "../../problem";

type Item = { subsystem: string; capability: string; value: string };

async function entitlementPermission(c: Parameters<typeof problem>[0], action: "assign" | "revoke") {
  const auth = createAuth(c.env, c.req.raw);
  const result = await auth.api.userHasPermission({
    headers: c.req.raw.headers,
    body: { permissions: { entitlement: [action] } },
  });
  return result.success;
}

async function jsonObject(c: Parameters<typeof problem>[0]): Promise<Record<string, unknown> | null> {
  try {
    const value = await c.req.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function rejectQuickloginPolicyWrite(
  c: Parameters<typeof problem>[0],
  items: Item[]
): Response | null {
  try {
    assertGenericEntitlementWriteAllowed(items);
    return null;
  } catch (error) {
    if (error instanceof QuickloginQuotaAdminError) {
      return problem(
        c,
        error.code,
        "QuickLogin policy 必须使用专用预览接口修改",
        409
      );
    }
    throw error;
  }
}

export function createAdminEntitlementsApi() {
  const api = new Hono<HonoEnv>();
  api.use("/*", requireAdmin);

  api.get("/users/:id/entitlements", async (c) => {
    const rows = await drizzle(c.env.DATABASE).select().from(userEntitlement)
      .where(eq(userEntitlement.userId, c.req.param("id"))).all();
    return c.json({ data: rows });
  });

  api.put("/users/:id/entitlements", async (c) => {
    if (!(await entitlementPermission(c, "assign"))) return problem(c, "FORBIDDEN", "需要权益写权限", 403);
    const body = await jsonObject(c);
    if (!Array.isArray(body?.items)) return problem(c, "INVALID_ENTITLEMENTS", "items 必须是数组", 400);
    const items = body.items as Item[];
    const invalid = validateEntitlementItems(items);
    if (invalid) return problem(c, "INVALID_ENTITLEMENTS", invalid, 400);
    const policyError = rejectQuickloginPolicyWrite(c, items);
    if (policyError) return policyError;
    const db = drizzle(c.env.DATABASE);
    const userId = c.req.param("id");
    const del = db.delete(userEntitlement).where(and(
      eq(userEntitlement.userId, userId),
      sql`NOT (${userEntitlement.subsystem} = 'cqu' AND ${userEntitlement.capability} IN ('quicklogin', 'quicklogin_device_limit'))`
    ));
    if (items.length) {
      const ins = db.insert(userEntitlement).values(items.map((item) => ({ userId, ...item })));
      await db.batch([del, ins]);
    } else await del;
    return c.json({ data: { items } });
  });

  api.patch("/users/:id/entitlements", async (c) => {
    if (!(await entitlementPermission(c, "assign"))) return problem(c, "FORBIDDEN", "需要权益写权限", 403);
    const body = await jsonObject(c);
    if (!body || typeof body.preset !== "string" || !body.preset) {
      return problem(c, "INVALID_BODY", "preset 必须是非空字符串", 400);
    }
    const items = await getPresetItems(c.env.DATABASE, body.preset);
    if (!items) return problem(c, "UNKNOWN_PRESET", "未知预设", 400);
    const invalid = validateEntitlementItems(items);
    if (invalid) return problem(c, "INVALID_PRESET", `预设数据已失效：${invalid}`, 409);
    const policyError = rejectQuickloginPolicyWrite(c, items);
    if (policyError) return policyError;
    if (!items.length) return c.json({ data: { applied: 0 } });
    const db = drizzle(c.env.DATABASE);
    const userId = c.req.param("id");
    const deletes = items.map((item) => db.delete(userEntitlement).where(and(
      eq(userEntitlement.userId, userId),
      eq(userEntitlement.subsystem, item.subsystem),
      eq(userEntitlement.capability, item.capability)
    )));
    const insert = db.insert(userEntitlement).values(items.map((item) => ({ userId, ...item })));
    await db.batch([deletes[0], ...deletes.slice(1), insert]);
    return c.json({ data: { applied: items.length } });
  });

  api.delete("/users/:id/entitlements/:subsystem/:capability", async (c) => {
    if (!(await entitlementPermission(c, "revoke"))) return problem(c, "FORBIDDEN", "需要权益撤销权限", 403);
    if (isQuickloginPolicyItem({
      subsystem: c.req.param("subsystem"),
      capability: c.req.param("capability"),
    })) {
      return problem(
        c,
        "QUICKLOGIN_PREVIEW_REQUIRED",
        "QuickLogin policy 必须使用专用预览接口修改",
        409
      );
    }
    await drizzle(c.env.DATABASE).delete(userEntitlement).where(and(
      eq(userEntitlement.userId, c.req.param("id")),
      eq(userEntitlement.subsystem, c.req.param("subsystem")),
      eq(userEntitlement.capability, c.req.param("capability"))
    ));
    return c.body(null, 204);
  });

  api.get("/entitlement-presets", async (c) => c.json({ data: await listPresets(c.env.DATABASE) }));
  api.put("/entitlement-presets/:name", async (c) => {
    if (!(await entitlementPermission(c, "assign"))) return problem(c, "FORBIDDEN", "需要权益写权限", 403);
    const name = c.req.param("name").trim();
    if (!name || name.length > 50) return problem(c, "INVALID_NAME", "预设名需要 1-50 个字符", 400);
    const body = await jsonObject(c);
    if (!Array.isArray(body?.items)) return problem(c, "INVALID_ENTITLEMENTS", "items 必须是数组", 400);
    const items = body.items as Item[];
    const invalid = validateEntitlementItems(items);
    if (invalid) return problem(c, "INVALID_ENTITLEMENTS", invalid, 400);
    const policyError = rejectQuickloginPolicyWrite(c, items);
    if (policyError) return policyError;
    await upsertPreset(c.env.DATABASE, name, items);
    return c.json({ data: { name, items } });
  });

  api.delete("/entitlement-presets/:name", async (c) => {
    if (!(await entitlementPermission(c, "assign"))) return problem(c, "FORBIDDEN", "需要权益写权限", 403);
    const name = c.req.param("name");
    await deletePreset(c.env.DATABASE, name);
    if ((await getDefaultPresetName(c.env.DATABASE)) === name) await setDefaultPresetName(c.env.DATABASE, null);
    return c.body(null, 204);
  });

  api.get("/entitlement-default", async (c) =>
    c.json({ data: { preset: await getDefaultPresetName(c.env.DATABASE) } })
  );
  api.put("/entitlement-default", async (c) => {
    if (!(await entitlementPermission(c, "assign"))) return problem(c, "FORBIDDEN", "需要权益写权限", 403);
    const body = await jsonObject(c);
    if (!body || !("preset" in body) || (body.preset !== null && typeof body.preset !== "string")) {
      return problem(c, "INVALID_BODY", "必须显式提供 preset", 400);
    }
    const preset = body.preset as string | null;
    if (preset !== null) {
      const items = await getPresetItems(c.env.DATABASE, preset);
      if (!items) return problem(c, "UNKNOWN_PRESET", "未知预设", 400);
      const policyError = rejectQuickloginPolicyWrite(c, items);
      if (policyError) return policyError;
    }
    await setDefaultPresetName(c.env.DATABASE, preset);
    return c.json({ data: { preset } });
  });

  return api;
}
