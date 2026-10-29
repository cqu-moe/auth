import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { createAuth } from "../../../auth";
import { userEntitlement } from "../../../db/schema";
import { requireAdmin, requireRecentAdmin } from "../../../middleware/authentication";
import {
  QuickloginAccountClient,
  QuickloginAccountClientError,
} from "../../../services/quicklogin/account-client";
import {
  assertMigrationApplicable,
  previewQuickloginMigration,
  QuickloginMigrationError,
} from "../../../services/quicklogin/migration";
import {
  QuickloginQuotaAdminError,
  routeQuickloginEntitlementWrite,
} from "../../../services/quicklogin/quota-admin";
import type {
  PublicDevice,
  QuotaPreview,
} from "../../../services/quicklogin/contracts";
import type { HonoEnv } from "../../../types";
import { problem } from "../../problem";
import {
  QuickloginPolicyInitializeBody,
  QuickloginPolicyPreviewBody,
  QuickloginQuotaApplyBody,
  QuickloginQuotaPreviewBody,
} from "./quicklogin.schema";

type ApiContext = Parameters<typeof problem>[0];

async function hasEntitlementPermission(c: ApiContext, action: "assign" | "revoke") {
  const auth = createAuth(c.env, c.req.raw);
  const result = await auth.api.userHasPermission({
    headers: c.req.raw.headers,
    body: { permissions: { entitlement: [action] } },
  });
  return result.success;
}

async function parseJson(c: ApiContext): Promise<
  | { ok: true; value: unknown }
  | { ok: false; response: Response }
> {
  if (!/^application\/json(?:\s*;|$)/i.test(c.req.header("content-type") ?? "")) {
    return {
      ok: false,
      response: problem(c, "UNSUPPORTED_MEDIA_TYPE", "仅支持 JSON 请求体", 415),
    };
  }
  try {
    return { ok: true, value: await c.req.json() };
  } catch {
    return {
      ok: false,
      response: problem(c, "INVALID_BODY", "请求体不是合法 JSON", 400),
    };
  }
}

async function initializationPreview(
  c: ApiContext,
  userId: string,
  migrationId: string,
  deviceLimit: number
) {
  const rows = await drizzle(c.env.DATABASE)
    .select()
    .from(userEntitlement)
    .where(and(
      eq(userEntitlement.userId, userId),
      eq(userEntitlement.subsystem, "cqu")
    ))
    .all();
  const oldAccess = rows.some((row) =>
    row.capability === "quicklogin_access" && row.value === "1"
  );
  const oldMaster = rows.some((row) =>
    row.capability === "quicklogin" && row.value === "1"
  );
  if (!oldAccess && !oldMaster) {
    throw new QuickloginMigrationError("MISSING_MAPPING");
  }
  return previewQuickloginMigration(
    [{ userId, oldAccess, oldMaster }],
    {
      schemaVersion: 1,
      migrationId,
      users: [{ userId, deviceLimit }],
    }
  );
}

function previewDevice(device: PublicDevice) {
  return {
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    browserVersion: device.browserVersion,
    lastSeenAt: device.lastSeenAt,
  };
}

async function previewView(
  accounts: QuickloginAccountClient,
  userId: string,
  preview: QuotaPreview
) {
  const list = await accounts.listDevices(userId, Date.now());
  const devices = new Map(list.devices.map((device) => [device.deviceId, device]));
  return {
    ...preview,
    keptDevices: preview.kept.flatMap((id) => {
      const device = devices.get(id);
      return device ? [previewDevice(device)] : [];
    }),
    disabledDevices: preview.disabled.flatMap((id) => {
      const device = devices.get(id);
      return device ? [previewDevice(device)] : [];
    }),
  };
}

async function accountError(c: ApiContext, error: unknown, userId: string) {
  if (error instanceof QuickloginMigrationError) {
    return problem(c, error.code, error.message, 409);
  }
  if (error instanceof QuickloginQuotaAdminError) {
    if (error.code === "FORBIDDEN") {
      return problem(c, error.code, "需要权益写权限", 403);
    }
    if (error.code === "QUICKLOGIN_PREVIEW_REQUIRED") {
      return problem(c, error.code, "QuickLogin 额度必须使用专用预览接口修改", 409);
    }
    return problem(c, error.code, "设备额度无效", 422);
  }
  if (error instanceof QuickloginAccountClientError) {
    if (error.code === "PREVIEW_CHANGED") {
      if (!error.preview) {
        return problem(c, "TEMPORARY_UNAVAILABLE", "服务暂时不可用", 503);
      }
      try {
        return problem(c, error.code, "设备状态已变化", 409, {
          preview: await previewView(
            new QuickloginAccountClient(c.env),
            userId,
            error.preview
          ),
        });
      } catch {
        return problem(c, "TEMPORARY_UNAVAILABLE", "服务暂时不可用", 503);
      }
    }
    if (error.code === "INVALID_REQUEST") {
      return problem(c, error.code, "预览令牌或设备额度无效", 422);
    }
    if (error.code === "DEVICE_LIMIT_REACHED") {
      return problem(c, error.code, error.message, 409);
    }
    if (error.code === "TEMPORARY_UNAVAILABLE") {
      return problem(c, error.code, "服务暂时不可用", 503);
    }
    return problem(c, error.code, error.message, 403);
  }
  return problem(c, "INTERNAL_ERROR", "服务器内部错误", 500);
}

export function createAdminQuickloginApi() {
  const api = new Hono<HonoEnv>();
  api.use("/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    return next();
  });
  api.use("/*", requireAdmin);

  api.post("/users/:id/quicklogin-policy/preview", async (c) => {
    if (!(await hasEntitlementPermission(c, "assign"))) {
      return problem(c, "FORBIDDEN", "需要权益写权限", 403);
    }
    const body = await parseJson(c);
    if (!body.ok) return body.response;
    const parsed = QuickloginPolicyPreviewBody.safeParse(body.value);
    if (!parsed.success) return problem(c, "INVALID_BODY", "请求体无效", 400);
    try {
      return c.json({
        data: await initializationPreview(
          c,
          c.req.param("id"),
          parsed.data.migrationId,
          parsed.data.deviceLimit
        ),
      });
    } catch (error) {
      return accountError(c, error, c.req.param("id"));
    }
  });

  api.put("/users/:id/quicklogin-policy/initialize", requireRecentAdmin, async (c) => {
    if (!(await hasEntitlementPermission(c, "assign"))) {
      return problem(c, "FORBIDDEN", "需要权益写权限", 403);
    }
    const body = await parseJson(c);
    if (!body.ok) return body.response;
    const parsed = QuickloginPolicyInitializeBody.safeParse(body.value);
    if (!parsed.success) return problem(c, "INVALID_BODY", "请求体无效", 400);
    try {
      const userId = c.req.param("id");
      const preview = await initializationPreview(
        c,
        userId,
        parsed.data.migrationId,
        parsed.data.deviceLimit
      );
      assertMigrationApplicable(preview, parsed.data.previewHash);
      const accounts = new QuickloginAccountClient(c.env);
      await accounts.initializeQuickloginPolicy(userId, {
        migrationId: parsed.data.migrationId,
        deviceLimit: parsed.data.deviceLimit,
        masterEnabled: preview.initializations[0]?.masterEnabled ?? false,
      });
      return c.json({ data: await accounts.listDevices(userId, Date.now()) });
    } catch (error) {
      return accountError(c, error, c.req.param("id"));
    }
  });

  api.post("/users/:id/quicklogin-quota/preview", async (c) => {
    if (!(await hasEntitlementPermission(c, "assign"))) {
      return problem(c, "FORBIDDEN", "需要权益写权限", 403);
    }
    const body = await parseJson(c);
    if (!body.ok) return body.response;
    const parsed = QuickloginQuotaPreviewBody.safeParse(body.value);
    if (!parsed.success) return problem(c, "INVALID_BODY", "请求体无效", 400);
    try {
      const userId = c.req.param("id");
      const accounts = new QuickloginAccountClient(c.env);
      const result = await routeQuickloginEntitlementWrite({
        userId,
        actorId: c.get("user").id,
        items: [{
          subsystem: "cqu",
          capability: "quicklogin_device_limit",
          value: String(parsed.data.deviceLimit),
        }],
        now: Date.now(),
        coordinator: accounts,
      });
      if (result.kind !== "preview") {
        return problem(c, "INTERNAL_ERROR", "服务器内部错误", 500);
      }
      return c.json({ data: await previewView(accounts, userId, result.preview) });
    } catch (error) {
      return accountError(c, error, c.req.param("id"));
    }
  });

  api.put("/users/:id/quicklogin-quota", requireRecentAdmin, async (c) => {
    if (!(await hasEntitlementPermission(c, "assign"))) {
      return problem(c, "FORBIDDEN", "需要权益写权限", 403);
    }
    const body = await parseJson(c);
    if (!body.ok) return body.response;
    const parsed = QuickloginQuotaApplyBody.safeParse(body.value);
    if (!parsed.success) return problem(c, "INVALID_BODY", "请求体无效", 400);
    try {
      const result = await routeQuickloginEntitlementWrite({
        userId: c.req.param("id"),
        actorId: c.get("user").id,
        items: [{
          subsystem: "cqu",
          capability: "quicklogin_device_limit",
          value: String(parsed.data.newLimit),
        }],
        previewToken: parsed.data.token,
        now: Date.now(),
        coordinator: new QuickloginAccountClient(c.env),
      });
      if (result.kind !== "applied") {
        return problem(c, "INTERNAL_ERROR", "服务器内部错误", 500);
      }
      return c.json({ data: result.list });
    } catch (error) {
      return accountError(c, error, c.req.param("id"));
    }
  });

  return api;
}
