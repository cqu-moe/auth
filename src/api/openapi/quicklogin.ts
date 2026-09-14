import type { HttpOperation } from "../operations";
import { z } from "@hono/zod-openapi";
import { QuickloginPreferenceBody } from "../v1/cqu-quicklogin.schema";
import {
  QuickloginPolicyInitializeBody,
  QuickloginPolicyPreviewBody,
  QuickloginQuotaApplyBody,
  QuickloginQuotaPreviewBody,
} from "../v1/admin/quicklogin.schema";
import {
  QuickloginDeviceExportBody,
  QuickloginDeviceHeartbeatBody,
  QuickloginDeviceRefreshBody,
  QuickloginDeviceRegistrationBody,
  QuickloginDeviceUpdateBody,
} from "../../services/quicklogin/http";

type Schema = Record<string, unknown>;

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const nullableInteger = { type: ["integer", "null"], minimum: 0 };
const data = (schema: Schema): Schema => ({
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: { data: schema },
});
const json = (schema: Schema) => ({
  content: { "application/json": { schema } },
});
const problem = () => ({
  content: { "application/problem+json": { schema: ref("ApiProblem") } },
});
const nativeError = () => ({
  content: { "application/json": { schema: ref("QuickloginNativeError") } },
});
const runtimeSchema = (schema: z.ZodType): Schema => {
  const { $schema: _dialect, ...document } = z.toJSONSchema(schema);
  return document;
};

const ERROR_CODES = [
  "UNAUTHORIZED", "FORBIDDEN", "INVALID_REQUEST", "NO_DEVICE_CAPACITY",
  "DEVICE_LIMIT_REACHED", "DEVICE_REVOKED", "MASTER_DISABLED", "DEVICE_DISABLED",
  "PREPARING", "NEEDS_REAUTH", "TEMPORARY_UNAVAILABLE", "RATE_LIMITED",
  "PROTOCOL_UNSUPPORTED", "STALE_GENERATION", "PREVIEW_CHANGED",
];

export const QUICKLOGIN_SCHEMAS: Record<string, Schema> = {
  QuickloginNativeError: {
    type: "object",
    additionalProperties: false,
    required: ["error"],
    properties: {
      error: {
        type: "object",
        additionalProperties: false,
        required: ["code", "message"],
        properties: {
          code: { type: "string", enum: ERROR_CODES },
          message: { type: "string" },
          retryAfterMs: { type: "integer", minimum: 0 },
        },
      },
    },
  },
  PublicDevice: {
    type: "object",
    additionalProperties: false,
    required: [
      "deviceId", "deviceName", "browserFamily", "browserVersion", "enabled",
      "enabledAt", "lastSeenAt", "lastIp", "revokedAt", "generation",
      "disabledReason", "appliedVersion", "online",
    ],
    properties: {
      deviceId: { type: "string", minLength: 1 },
      deviceName: { type: "string", minLength: 1, maxLength: 80 },
      browserFamily: { type: "string", const: "chrome" },
      browserVersion: { type: "string", minLength: 1, maxLength: 40 },
      enabled: { type: "boolean" },
      enabledAt: nullableInteger,
      lastSeenAt: nullableInteger,
      lastIp: { type: ["string", "null"] },
      revokedAt: nullableInteger,
      generation: { type: "integer", minimum: 0 },
      disabledReason: {
        type: ["string", "null"],
        enum: ["user", "quota_reduced", null],
      },
      appliedVersion: nullableInteger,
      online: { type: "boolean" },
    },
  },
  DeviceStatus: {
    type: "object",
    additionalProperties: false,
    required: [
      "protocolVersion", "deviceId", "generation", "masterEnabled", "enabled",
      "deviceLimit", "used", "disabledReason", "state", "sessionVersion",
      "appliedVersion", "loginAt", "lastKeepAliveAt", "lastSeenAt",
    ],
    properties: {
      protocolVersion: { type: "integer", const: 2 },
      deviceId: { type: "string", minLength: 1 },
      generation: { type: "integer", minimum: 0 },
      masterEnabled: { type: "boolean" },
      enabled: { type: "boolean" },
      deviceLimit: { type: "integer", minimum: 0 },
      used: { type: "integer", minimum: 0 },
      disabledReason: {
        type: ["string", "null"],
        enum: ["user", "quota_reduced", null],
      },
      state: {
        type: "string",
        enum: [
          "disabled", "paused", "preparing", "ready", "refreshing",
          "needs_reauth", "temporary_unavailable", "revoked",
        ],
      },
      sessionVersion: { type: "integer", minimum: 0 },
      appliedVersion: nullableInteger,
      loginAt: nullableInteger,
      lastKeepAliveAt: nullableInteger,
      lastSeenAt: nullableInteger,
    },
  },
  DeviceListData: {
    type: "object",
    additionalProperties: false,
    required: ["masterEnabled", "deviceLimit", "used", "revision", "devices"],
    properties: {
      masterEnabled: { type: "boolean" },
      deviceLimit: { type: "integer", minimum: 0 },
      used: { type: "integer", minimum: 0 },
      revision: { type: "integer", minimum: 0 },
      devices: { type: "array", items: ref("PublicDevice") },
    },
  },
  QuickloginDeviceUnavailablePreference: {
    type: "object",
    additionalProperties: false,
    required: ["eligible"],
    properties: { eligible: { type: "boolean", const: false } },
  },
  QuickloginDevicePreference: {
    type: "object",
    additionalProperties: false,
    required: ["eligible", "masterEnabled", "deviceLimit", "used"],
    properties: {
      eligible: { type: "boolean", const: true },
      masterEnabled: { type: "boolean" },
      deviceLimit: { type: "integer", minimum: 0 },
      used: { type: "integer", minimum: 0 },
    },
  },
  QuickloginLegacyPreference: {
    type: "object", additionalProperties: false,
    required: ["eligible", "enabled"],
    properties: { eligible: { type: "boolean" }, enabled: { type: "boolean" } },
  },
  QuickloginPreference: {
    oneOf: [
      ref("QuickloginDeviceUnavailablePreference"),
      ref("QuickloginDevicePreference"),
      ref("QuickloginLegacyPreference"),
    ],
  },
  QuickloginLegacyPreferenceUpdateResult: {
    type: "object", additionalProperties: false,
    required: ["enabled"],
    properties: { enabled: { type: "boolean" } },
  },
  QuickloginPreferenceUpdateResult: {
    oneOf: [
      ref("QuickloginDevicePreference"),
      ref("QuickloginLegacyPreferenceUpdateResult"),
    ],
  },
  QuickloginQuotaDevice: {
    type: "object",
    additionalProperties: false,
    required: ["deviceId", "deviceName", "browserVersion", "lastSeenAt"],
    properties: {
      deviceId: { type: "string", minLength: 1 },
      deviceName: { type: "string", minLength: 1, maxLength: 80 },
      browserVersion: { type: "string", minLength: 1, maxLength: 40 },
      lastSeenAt: nullableInteger,
    },
  },
  QuickloginQuotaPreview: {
    type: "object",
    additionalProperties: false,
    required: [
      "token", "expiresAt", "revision", "oldLimit", "newLimit", "kept",
      "disabled", "keptDevices", "disabledDevices",
    ],
    properties: {
      token: { type: "string", minLength: 1 },
      expiresAt: { type: "integer", minimum: 0 },
      revision: { type: "integer", minimum: 0 },
      oldLimit: { type: "integer", minimum: 0 },
      newLimit: { type: "integer", minimum: 0 },
      kept: { type: "array", items: { type: "string", minLength: 1 } },
      disabled: { type: "array", items: { type: "string", minLength: 1 } },
      keptDevices: { type: "array", items: ref("QuickloginQuotaDevice") },
      disabledDevices: { type: "array", items: ref("QuickloginQuotaDevice") },
    },
  },
  QuickloginQuotaProblem: {
    type: "object",
    additionalProperties: false,
    required: ["type", "title", "status", "detail", "code"],
    properties: {
      type: { type: "string", const: "about:blank" },
      title: { type: "string" },
      status: { type: "integer" },
      detail: { type: "string" },
      code: { type: "string" },
      preview: ref("QuickloginQuotaPreview"),
    },
  },
  QuickloginPolicyInitialization: {
    type: "object",
    additionalProperties: false,
    required: ["userId", "deviceLimit", "masterEnabled"],
    properties: {
      userId: { type: "string", minLength: 1 },
      deviceLimit: { type: "integer", minimum: 0 },
      masterEnabled: { type: "boolean" },
    },
  },
  QuickloginMigrationPreview: {
    type: "object",
    additionalProperties: false,
    required: [
      "migrationId", "previewHash", "relevantUsers", "missingMapping",
      "conflicts", "initializations",
    ],
    properties: {
      migrationId: { type: "string", minLength: 1 },
      previewHash: { type: "string", minLength: 1 },
      relevantUsers: { type: "integer", minimum: 0 },
      missingMapping: { type: "array", items: { type: "string", minLength: 1 } },
      conflicts: { type: "array", items: { type: "string", minLength: 1 } },
      initializations: {
        type: "array", items: ref("QuickloginPolicyInitialization"),
      },
    },
  },
  QuickloginCookie: {
    type: "object",
    additionalProperties: false,
    required: [
      "name", "value", "domain", "path", "secure", "httpOnly", "sameSite", "expires",
    ],
    properties: {
      name: { type: "string", minLength: 1 },
      value: { type: "string" },
      domain: { type: "string", enum: ["sso.cqu.edu.cn", ".sso.cqu.edu.cn"] },
      path: { type: "string", minLength: 1 },
      secure: { type: "boolean" },
      httpOnly: { type: "boolean" },
      sameSite: { type: "string", enum: ["Strict", "Lax", "None"] },
      expires: { type: "number" },
    },
  },
  QuickloginCookieEnvelope: {
    type: "object",
    additionalProperties: false,
    required: [
      "protocolVersion", "deviceId", "generation", "sessionVersion", "createdAt", "cookies",
    ],
    properties: {
      protocolVersion: { type: "integer", const: 2 },
      deviceId: { type: "string", minLength: 1 },
      generation: { type: "integer", minimum: 0 },
      sessionVersion: { type: "integer", minimum: 0 },
      createdAt: { type: "integer", minimum: 0 },
      cookies: { type: "array", items: ref("QuickloginCookie") },
    },
  },
  QuickloginPreferenceUpdate: runtimeSchema(QuickloginPreferenceBody),
  QuickloginDeviceRegistration: runtimeSchema(QuickloginDeviceRegistrationBody),
  QuickloginDeviceUpdate: runtimeSchema(QuickloginDeviceUpdateBody),
  QuickloginDeviceHeartbeat: runtimeSchema(QuickloginDeviceHeartbeatBody),
  QuickloginDeviceRefresh: runtimeSchema(QuickloginDeviceRefreshBody),
  QuickloginDeviceExport: runtimeSchema(QuickloginDeviceExportBody),
  QuickloginPolicyPreviewRequest: runtimeSchema(QuickloginPolicyPreviewBody),
  QuickloginPolicyInitializeRequest: runtimeSchema(QuickloginPolicyInitializeBody),
  QuickloginQuotaPreviewRequest: runtimeSchema(QuickloginQuotaPreviewBody),
  QuickloginQuotaApplyRequest: runtimeSchema(QuickloginQuotaApplyBody),
};

function responses(
  successStatus: number,
  successSchema: Schema | null,
  errorStatuses: number[],
  errorKind: "native" | "problem"
) {
  const output: Record<string, unknown> = {
    [successStatus]: {
      description: "Successful response",
      ...(successSchema ? json(successSchema) : {}),
    },
  };
  for (const status of errorStatuses) {
    const response: Record<string, unknown> = {
      description: "Error response",
      ...(errorKind === "native" ? nativeError() : problem()),
    };
    if (status === 429 && errorKind === "native") {
      response.headers = {
        "Retry-After": { schema: { type: "string", const: "60" } },
      };
    }
    output[status] = response;
  }
  return output;
}

function requestBody(name: string) {
  return { required: true, ...json(ref(name)) };
}

export function quickloginOperationContract(
  operation: HttpOperation
): Record<string, unknown> | undefined {
  const { method, path } = operation;
  const isDevice = /^\/api\/(?:v1\/)?cqu\/quicklogin\/devices(?:\/|$)/.test(path);
  if (isDevice) {
    const suffix = path.replace(/^\/api\/(?:v1\/)?cqu\/quicklogin\/devices/, "");
    if (method === "OPTIONS") {
      return {
        security: [],
        "x-runtime-origin": "configured-extension-origin",
        responses: responses(204, null, [403], "native"),
      };
    }
    const extension = {
      security: [{ bearerAuth: [] }],
      "x-runtime-origin": "configured-extension-origin",
    };
    if (suffix === "" && method === "POST") return {
      ...extension,
      requestBody: requestBody("QuickloginDeviceRegistration"),
      responses: responses(200, ref("DeviceStatus"), [400, 401, 403, 409, 415, 422, 503], "native"),
    };
    if (suffix === "" && method === "GET") return {
      security: [{ cookieAuth: [] }],
      "x-runtime-origin": "same-origin-website",
      responses: responses(200, ref("DeviceListData"), [401, 403, 503], "native"),
    };
    if (suffix === "/:id" && method === "PUT") return {
      ...extension,
      requestBody: requestBody("QuickloginDeviceUpdate"),
      responses: responses(200, ref("DeviceStatus"), [400, 401, 403, 409, 415, 422, 503], "native"),
    };
    if (suffix === "/:id" && method === "DELETE") return {
      security: [{ cookieAuth: [] }],
      "x-runtime-origin": "same-origin-website",
      responses: responses(204, null, [401, 403, 503], "native"),
    };
    if (suffix === "/:id/status" && method === "POST") return {
      ...extension,
      requestBody: requestBody("QuickloginDeviceHeartbeat"),
      responses: responses(200, ref("DeviceStatus"), [400, 401, 403, 409, 415, 422, 426, 429, 503], "native"),
    };
    if (suffix === "/:id/refresh" && method === "POST") return {
      ...extension,
      requestBody: requestBody("QuickloginDeviceRefresh"),
      responses: responses(202, ref("DeviceStatus"), [400, 401, 403, 409, 415, 422, 426, 429, 503], "native"),
    };
    if (suffix === "/:id/export" && method === "POST") return {
      ...extension,
      requestBody: requestBody("QuickloginDeviceExport"),
      responses: responses(200, ref("QuickloginCookieEnvelope"), [400, 401, 403, 409, 415, 422, 426, 429, 503], "native"),
    };
  }

  if (path === "/api/v1/cqu/quicklogin" && (method === "GET" || method === "PUT")) {
    return {
      security: [{ cookieAuth: [] }],
      "x-runtime-origin": method === "PUT" ? "same-origin-website" : undefined,
      ...(method === "PUT" ? { requestBody: requestBody("QuickloginPreferenceUpdate") } : {}),
      responses: responses(200, data(ref(
        method === "PUT" ? "QuickloginPreferenceUpdateResult" : "QuickloginPreference"
      )),
        method === "PUT" ? [400, 401, 403, 415, 500, 503] : [401, 500, 503],
        "problem"),
    };
  }

  const admin = path.match(/^\/api\/v1\/admin\/users\/:id\/(quicklogin-[^/]+)(?:\/(preview|initialize))?$/);
  if (!admin) return undefined;
  const key = `${admin[1]}${admin[2] ? `/${admin[2]}` : ""}`;
  const contract = {
    "quicklogin-policy/preview": ["QuickloginPolicyPreviewRequest", "QuickloginMigrationPreview"],
    "quicklogin-policy/initialize": ["QuickloginPolicyInitializeRequest", "DeviceListData"],
    "quicklogin-quota/preview": ["QuickloginQuotaPreviewRequest", "QuickloginQuotaPreview"],
    "quicklogin-quota": ["QuickloginQuotaApplyRequest", "DeviceListData"],
  }[key];
  if (!contract) return undefined;
  const responseMap = responses(
    200,
    data(ref(contract[1])),
    [400, 401, 403, 409, 415, 422, 500, 503],
    "problem"
  );
  if (key === "quicklogin-quota") {
    responseMap[409] = {
      description: "Conflict or changed quota preview",
      content: {
        "application/problem+json": {
          schema: ref("QuickloginQuotaProblem"),
        },
      },
    };
  }
  return {
    security: [{ cookieAuth: [] }],
    "x-required-permissions": ["entitlement:assign"],
    requestBody: requestBody(contract[0]),
    responses: responseMap,
  };
}
