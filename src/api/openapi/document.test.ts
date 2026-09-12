import { describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { listHttpOperations } from "../operations";
import { buildOpenApiDocument } from "./document";
import { createHttpFixture } from "../../test-utils/http";
import { buildCloudflareSchema } from "./cloudflare";
import {
  parseDeviceMetadata,
  parseEnabled,
  parseExportRequest,
  parseHeartbeat,
  parseRefreshRequest,
  QuickloginHttpError,
} from "../../services/quicklogin/http";

function schemaAccepts(
  schema: Record<string, any>,
  value: unknown,
  components: Record<string, any>
): boolean {
  if (schema.$ref) {
    const name = schema.$ref.replace("#/components/schemas/", "");
    return schemaAccepts(components[name], value, components);
  }
  if (schema.nullable && value === null) return true;
  if (schema.const !== undefined && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.oneOf) {
    return schema.oneOf.filter((entry: Record<string, any>) =>
      schemaAccepts(entry, value, components)
    ).length === 1;
  }
  if (schema.anyOf) {
    return schema.anyOf.some((entry: Record<string, any>) =>
      schemaAccepts(entry, value, components)
    );
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (value === null) return types.includes("null");
  const type = Array.isArray(value) ? "array" : typeof value === "object"
    ? "object" : Number.isInteger(value) ? "integer" : typeof value;
  if (schema.type && !types.includes(type) && !(type === "integer" && types.includes("number"))) {
    return false;
  }
  if (typeof value === "string") {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) return false;
    if (schema.maxLength !== undefined && length > schema.maxLength) return false;
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) return false;
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    return false;
  }
  if (typeof value === "number" && schema.maximum !== undefined && value > schema.maximum) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.every((entry) => schemaAccepts(schema.items ?? {}, entry, components));
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if ((schema.required ?? []).some((key: string) => !(key in object))) return false;
    if (schema.additionalProperties === false &&
        Object.keys(object).some((key) => !(key in (schema.properties ?? {})))) return false;
    return Object.entries(schema.properties ?? {}).every(([key, property]) =>
      !(key in object) || schemaAccepts(property as Record<string, any>, object[key], components)
    );
  }
  return true;
}

describe("complete API document", () => {
  it("matches the runtime method/path set without phantom get-session POST", () => {
    const operations = listHttpOperations(createApp());
    const document = buildOpenApiDocument(operations);
    const documented = Object.entries(document.paths).flatMap(([path, item]) =>
      Object.keys(item).map((method) => `${method.toUpperCase()} ${path}`)
    ).sort();
    const runtime = operations.map(({ method, path }) =>
      `${method} ${path.replace(/:([A-Za-z0-9_]+)/g, "{$1}")}`
    ).sort();
    expect(documented).toEqual(runtime);
    expect(documented).not.toContain("POST /api/v1/auth/get-session");
    const ids = Object.values(document.paths).flatMap((item) =>
      Object.values(item).map((operation) => (operation as { operationId: string }).operationId)
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.keys(document.components.schemas)).toEqual(expect.arrayContaining([
      "ApiProblem", "PageInfo", "CquSessionStatus", "BindingSnapshot", "EntitlementItem",
      "EntitlementPreset", "RegistrationInvitation", "OAuthClientView",
    ]));
  });

  it("documents exact custom statuses, bodies, headers, and every success response schema", () => {
    const document = buildOpenApiDocument(listHttpOperations(createApp())) as Record<string, any>;
    const paths = document.paths as Record<string, Record<string, any>>;
    const custom = Object.entries(paths).flatMap(([path, item]) =>
      Object.entries(item).flatMap(([method, operation]) =>
        path.startsWith("/api/v1/auth/") ? [] : [{ path, method, operation }]
      )
    );
    const emptySuccesses = custom.flatMap(({ path, method, operation }) =>
      Object.entries((operation as any).responses ?? {}).flatMap(([status, response]: [string, any]) =>
        /^1\d\d$|^2\d\d$/.test(status) && status !== "204" && status !== "101" && !response.content
          ? [`${method.toUpperCase()} ${path} ${status}`]
          : []
      )
    );
    expect(emptySuccesses).toEqual([]);

    const tickets = paths["/api/v1/cqu/service-tickets"].post;
    expect(Object.keys(tickets.responses)).toContain("201");
    expect(tickets.responses["201"].content["application/json"].schema)
      .toMatchObject({ properties: { data: { properties: { ticket: { type: "string" } } } } });
    expect(tickets.responses["201"].headers["Cache-Control"].schema.const).toBe("no-store");
    expect(tickets.responses["400"].headers["Cache-Control"].schema.const).toBe("no-store");
    expect(paths["/api/v1/admin/oauth-clients"].post.requestBody.content["application/json"].schema)
      .toBeTruthy();
    expect(paths["/api/v1/admin/oauth-clients/{id}"].patch.requestBody.content["application/json"].schema)
      .toMatchObject({ type: "object", minProperties: 1, additionalProperties: false });
    expect(paths["/api/v1/admin/oauth-clients/{id}"].delete.responses).toHaveProperty("204");
    expect(paths["/api/v1/cqu/binding/events"].get.responses).toHaveProperty("101");
    for (const path of [
      "/.well-known/oauth-authorization-server",
      "/.well-known/openid-configuration",
      "/api/auth/.well-known/openid-configuration",
      "/api/auth/.well-known/oauth-authorization-server",
      "/.well-known/oauth-authorization-server/api/auth",
    ]) {
      expect(paths[path].get.responses["200"].content["application/json"].schema)
        .toMatchObject({ type: "object" });
    }
  });

  it("documents device JSON transport errors only on QuickLogin write operations", () => {
    const document = buildOpenApiDocument(listHttpOperations(createApp())) as Record<string, any>;
    const paths = document.paths as Record<string, Record<string, any>>;
    for (const base of ["/api/v1/cqu/quicklogin/devices"]) {
      for (const [suffix, method] of [
        ["", "post"], ["/{id}", "put"], ["/{id}/status", "post"],
        ["/{id}/refresh", "post"], ["/{id}/export", "post"],
      ] as const) {
        expect(paths[`${base}${suffix}`][method].responses, `${method} ${base}${suffix}`)
          .toMatchObject({
            "400": { content: { "application/json": { schema: { $ref: "#/components/schemas/QuickloginNativeError" } } } },
            "415": { content: { "application/json": { schema: { $ref: "#/components/schemas/QuickloginNativeError" } } } },
          });
      }
      for (const [suffix, method] of [
        ["", "get"], ["/{id}", "delete"], ["", "options"],
        ["/{id}", "options"], ["/{id}/status", "options"],
        ["/{id}/refresh", "options"], ["/{id}/export", "options"],
      ] as const) {
        expect(paths[`${base}${suffix}`][method].responses, `${method} ${base}${suffix}`)
          .not.toHaveProperty("400");
        expect(paths[`${base}${suffix}`][method].responses, `${method} ${base}${suffix}`)
          .not.toHaveProperty("415");
      }
    }
    for (const path of [
      "/api/v1/health", "/api/v1/openapi.json",
      "/.well-known/oauth-authorization-server", "/.well-known/openid-configuration",
      "/api/auth/.well-known/openid-configuration",
      "/api/auth/.well-known/oauth-authorization-server",
      "/.well-known/oauth-authorization-server/api/auth",
    ]) expect(paths[path].get.responses, path).not.toHaveProperty("400");
  });

  it("serves the document object without a data envelope", async () => {
    const fixture = createHttpFixture();
    try {
      const response = await createApp().request("/api/v1/openapi.json", {}, fixture.env);
      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(body.openapi).toBe("3.1.1");
      expect(body).toHaveProperty("paths");
      expect(body).not.toHaveProperty("data");
      const paths = body.paths as Record<string, any>;
      expect(Object.keys(paths["/api/v1/auth/get-session"])).toEqual(["get"]);
      expect(paths["/api/v1/auth/get-session"].get.responses["200"].content["application/json"].schema.properties)
        .toHaveProperty("caps");
      expect(paths["/api/v1/auth/sign-up/email"].post.requestBody.content["application/json"].schema.properties.code)
        .toMatchObject({ type: "string", pattern: "^[A-Z0-9]{8}$" });
      expect(paths["/api/v1/auth/error"].get.responses).toHaveProperty("302");
      expect(JSON.stringify(body)).not.toContain('"nullable"');
      expect(Object.keys(paths["/api/v1/auth/oauth2/token"].post.requestBody.content))
        .toEqual(["application/x-www-form-urlencoded"]);
      expect(Object.keys(paths["/api/v1/auth/oauth2/introspect"].post.requestBody.content))
        .toEqual(["application/x-www-form-urlencoded"]);
      expect(Object.keys(paths["/api/v1/auth/oauth2/revoke"].post.requestBody.content))
        .toEqual(["application/x-www-form-urlencoded"]);
      const cloudflare = buildCloudflareSchema(body);
      expect(cloudflare.paths["/api/v1/auth/oauth2/token"].post)
        .not.toHaveProperty("requestBody");
      expect(cloudflare.paths["/api/v1/cqu/quicklogin/devices"].post.requestBody
        .content["application/json"].schema)
        .toEqual({ $ref: "#/components/schemas/QuickloginDeviceRegistration" });

      const documented = Object.entries(paths).flatMap(([path, item]) =>
        Object.keys(item as Record<string, unknown>)
          .map((method) => `${method.toUpperCase()} ${path}`)
      ).sort();
      const runtime = listHttpOperations(createApp()).map(({ method, path }) =>
        `${method} ${path.replace(/:([A-Za-z0-9_]+)/g, "{$1}")}`
      ).sort();
      expect(documented).toEqual(runtime);
    } finally {
      await fixture.close();
    }
  });

  it("documents QuickLogin native and enveloped contracts without internal state", () => {
    const document = buildOpenApiDocument(listHttpOperations(createApp()));
    const paths = document.paths as Record<string, Record<string, any>>;
    const schemas = document.components.schemas as Record<string, any>;

    expect(Object.keys(schemas)).toEqual(expect.arrayContaining([
      "QuickloginNativeError", "PublicDevice", "DeviceStatus", "DeviceListData",
      "QuickloginPreference", "QuickloginQuotaPreview", "QuickloginMigrationPreview",
      "QuickloginCookieEnvelope",
    ]));
    expect(Object.keys(schemas)).not.toEqual(expect.arrayContaining([
      "GrantRecord", "AccountState", "StoredDeviceSession",
    ]));
    expect(schemas.PublicDevice).toMatchObject({
      additionalProperties: false,
      required: expect.arrayContaining([
        "deviceId", "deviceName", "enabledAt", "lastSeenAt", "lastIp", "revokedAt",
        "disabledReason", "appliedVersion", "online",
      ]),
    });
    expect(schemas.QuickloginPreference.oneOf).toHaveLength(3);
    expect(schemas.QuickloginLegacyPreference.required).toEqual(["eligible", "enabled"]);
    expect(schemas.QuickloginQuotaPreview.properties.keptDevices.items)
      .toEqual({ $ref: "#/components/schemas/QuickloginQuotaDevice" });
    expect(schemas.QuickloginMigrationPreview.properties.initializations.items)
      .toEqual({ $ref: "#/components/schemas/QuickloginPolicyInitialization" });

    const register = paths["/api/v1/cqu/quicklogin/devices"].post;
    expect(register.security).toEqual([{ bearerAuth: [] }]);
    expect(register["x-runtime-origin"]).toBe("configured-extension-origin");
    expect(register.requestBody.content["application/json"].schema)
      .toEqual({ $ref: "#/components/schemas/QuickloginDeviceRegistration" });
    expect(register.responses["200"].content["application/json"].schema)
      .toEqual({ $ref: "#/components/schemas/DeviceStatus" });
    expect(register.responses["422"].content["application/json"].schema)
      .toEqual({ $ref: "#/components/schemas/QuickloginNativeError" });
    expect(register.responses["422"].content).not.toHaveProperty("application/problem+json");

    const websiteList = paths["/api/v1/cqu/quicklogin/devices"].get;
    expect(websiteList.security).toEqual([{ cookieAuth: [] }]);
    expect(websiteList.responses["200"].content["application/json"].schema)
      .toEqual({ $ref: "#/components/schemas/DeviceListData" });
    const websiteDelete = paths["/api/v1/cqu/quicklogin/devices/{id}"].delete;
    expect(websiteDelete.security).toEqual([{ cookieAuth: [] }]);
    expect(websiteDelete.responses).toHaveProperty("204");
    expect(websiteDelete.responses["204"]).not.toHaveProperty("content");

    for (const [path, method] of [
      ["/api/v1/cqu/quicklogin/devices/{id}", "put"],
      ["/api/v1/cqu/quicklogin/devices/{id}/status", "post"],
      ["/api/v1/cqu/quicklogin/devices/{id}/refresh", "post"],
      ["/api/v1/cqu/quicklogin/devices/{id}/export", "post"],
    ] as const) {
      expect(paths[path][method].security).toEqual([{ bearerAuth: [] }]);
      expect(paths[path][method]["x-runtime-origin"]).toBe("configured-extension-origin");
    }
    expect(paths["/api/v1/cqu/quicklogin/devices/{id}/refresh"].post.responses)
      .toHaveProperty("202");
    expect(paths["/api/v1/cqu/quicklogin/devices/{id}/refresh"].post.responses["429"].headers)
      .toEqual({ "Retry-After": { schema: { type: "string", const: "60" } } });
    expect(paths["/api/v1/cqu/quicklogin/devices/{id}/export"].post.responses["200"]
      .content["application/json"].schema)
      .toEqual({ $ref: "#/components/schemas/QuickloginCookieEnvelope" });

    const root = paths["/api/v1/cqu/quicklogin"].get;
    expect(root.security).toEqual([{ cookieAuth: [] }]);
    expect(root.responses["200"].content["application/json"].schema.properties.data)
      .toEqual({ $ref: "#/components/schemas/QuickloginPreference" });
    expect(root.responses["401"].content["application/problem+json"].schema)
      .toEqual({ $ref: "#/components/schemas/ApiProblem" });
    expect(paths["/api/v1/cqu/quicklogin"].put.responses["200"]
      .content["application/json"].schema.properties.data)
      .toEqual({ $ref: "#/components/schemas/QuickloginPreferenceUpdateResult" });

    for (const path of [
      "/api/v1/admin/users/{id}/quicklogin-policy/preview",
      "/api/v1/admin/users/{id}/quicklogin-policy/initialize",
      "/api/v1/admin/users/{id}/quicklogin-quota/preview",
      "/api/v1/admin/users/{id}/quicklogin-quota",
    ]) {
      const operation = Object.values(paths[path])[0] as any;
      expect(operation.security).toEqual([{ cookieAuth: [] }]);
      expect(operation["x-required-permissions"]).toEqual(["entitlement:assign"]);
      expect(operation.parameters).toContainEqual({
        name: "id", in: "path", required: true,
        schema: { type: "string", minLength: 1 },
      });
      expect(operation.responses["400"].content["application/problem+json"].schema)
        .toEqual({ $ref: "#/components/schemas/ApiProblem" });
    }
    expect(paths["/api/v1/admin/users/{id}/quicklogin-quota"].put.responses["409"]
      .content["application/problem+json"].schema)
      .toEqual({ $ref: "#/components/schemas/QuickloginQuotaProblem" });

    expect(paths).not.toHaveProperty("/api/cqu/quicklogin/devices");
  });

  it("keeps QuickLogin JSON sample acceptance equivalent in 3.1 and Cloudflare 3.0", () => {
    const openapi = buildOpenApiDocument(listHttpOperations(createApp())) as Record<string, any>;
    const cloudflare = buildCloudflareSchema(openapi) as Record<string, any>;
    const validDevice = {
      deviceId: "device-a", deviceName: "macOS Chrome", browserFamily: "chrome",
      browserVersion: "140.0.0.0", enabled: true, enabledAt: 1_800_000_000_000,
      lastSeenAt: null, lastIp: null, revokedAt: null, generation: 2,
      disabledReason: null, appliedVersion: null, online: false,
    };
    const invalidDevice = { ...validDevice, ownerUserId: "internal-user" };
    const validHeartbeat = {
      protocolVersion: 1, appliedVersion: null, generation: 2,
      browserVersion: "140.0.0.0",
    };
    const invalidHeartbeat = { ...validHeartbeat, protocolVersion: 2 };
    for (const [name, valid, invalid] of [
      ["PublicDevice", validDevice, invalidDevice],
      ["QuickloginDeviceHeartbeat", validHeartbeat, invalidHeartbeat],
    ] as const) {
      expect(schemaAccepts(openapi.components.schemas[name], valid, openapi.components.schemas))
        .toBe(true);
      expect(schemaAccepts(openapi.components.schemas[name], invalid, openapi.components.schemas))
        .toBe(false);
      expect(schemaAccepts(cloudflare.components.schemas[name], valid, cloudflare.components.schemas))
        .toBe(true);
      expect(schemaAccepts(cloudflare.components.schemas[name], invalid, cloudflare.components.schemas))
        .toBe(false);
    }
  });

  it("keeps device request schemas equivalent to the real runtime parsers", () => {
    const openapi = buildOpenApiDocument(listHttpOperations(createApp())) as Record<string, any>;
    const cloudflare = buildCloudflareSchema(openapi) as Record<string, any>;
    type Parser = (value: unknown) => unknown;
    const result = (parser: Parser, value: unknown) => {
      try { return { ok: true, value: parser(value) }; }
      catch (error) {
        return error instanceof QuickloginHttpError
          ? { ok: false, code: error.code, status: error.status }
          : { ok: false, code: "unexpected", status: 0 };
      }
    };
    const cases: Array<{
      name: string;
      schema: string;
      parser: Parser;
      input: unknown;
      ok: boolean;
      cloudflareOk?: boolean;
      code?: string;
      status?: number;
      output?: unknown;
    }> = [
      {
        name: "registration rejects ordinary padding",
        schema: "QuickloginDeviceRegistration",
        parser: parseDeviceMetadata,
        input: { deviceName: " macOS Chrome ", browserFamily: "chrome", browserVersion: " 140.0 " },
        ok: false, cloudflareOk: true, code: "INVALID_REQUEST", status: 400,
      },
      {
        name: "registration preserves BMP Chinese and internal ordinary spaces",
        schema: "QuickloginDeviceRegistration",
        parser: parseDeviceMetadata,
        input: { deviceName: "重庆 大学 Chrome", browserFamily: "chrome", browserVersion: "版本 140" },
        ok: true,
        output: { deviceName: "重庆 大学 Chrome", browserFamily: "chrome", browserVersion: "版本 140" },
      },
      {
        name: "registration rejects whitespace-only names",
        schema: "QuickloginDeviceRegistration",
        parser: parseDeviceMetadata,
        input: { deviceName: "   ", browserFamily: "chrome", browserVersion: "140" },
        ok: false, cloudflareOk: true, code: "INVALID_REQUEST", status: 400,
      },
      {
        name: "registration rejects control characters",
        schema: "QuickloginDeviceRegistration",
        parser: parseDeviceMetadata,
        input: { deviceName: "Chrome\u0000", browserFamily: "chrome", browserVersion: "140" },
        ok: false, cloudflareOk: true, code: "INVALID_REQUEST", status: 400,
      },
      {
        name: "registration rejects a name beyond 80 characters",
        schema: "QuickloginDeviceRegistration",
        parser: parseDeviceMetadata,
        input: { deviceName: "x".repeat(81), browserFamily: "chrome", browserVersion: "140" },
        ok: false, code: "INVALID_REQUEST", status: 400,
      },
      {
        name: "registration rejects padding after an 80-character name",
        schema: "QuickloginDeviceRegistration",
        parser: parseDeviceMetadata,
        input: { deviceName: `${"x".repeat(80)} `, browserFamily: "chrome", browserVersion: "140" },
        ok: false, code: "INVALID_REQUEST", status: 400,
      },
      {
        name: "registration rejects trailing Unicode whitespace",
        schema: "QuickloginDeviceRegistration",
        parser: parseDeviceMetadata,
        input: { deviceName: "Chrome\u3000", browserFamily: "chrome", browserVersion: "140" },
        ok: false, cloudflareOk: true, code: "INVALID_REQUEST", status: 400,
      },
      {
        name: "registration rejects non-BMP emoji",
        schema: "QuickloginDeviceRegistration",
        parser: parseDeviceMetadata,
        input: { deviceName: "Chrome 🚀", browserFamily: "chrome", browserVersion: "140" },
        ok: false, cloudflareOk: true, code: "INVALID_REQUEST", status: 400,
      },
      {
        name: "registration rejects an internal zero-width space",
        schema: "QuickloginDeviceRegistration",
        parser: parseDeviceMetadata,
        input: { deviceName: "Chrome\u200BDevice", browserFamily: "chrome", browserVersion: "140" },
        ok: false, cloudflareOk: true, code: "INVALID_REQUEST", status: 400,
      },
      {
        name: "device update is strict",
        schema: "QuickloginDeviceUpdate",
        parser: parseEnabled,
        input: { enabled: true, extra: false },
        ok: false, code: "INVALID_REQUEST", status: 400,
      },
      {
        name: "heartbeat accepts maximum safe integers and canonical version",
        schema: "QuickloginDeviceHeartbeat",
        parser: parseHeartbeat,
        input: {
          protocolVersion: 1, appliedVersion: Number.MAX_SAFE_INTEGER,
          generation: Number.MAX_SAFE_INTEGER, browserVersion: "版本 140.0",
        },
        ok: true,
        output: {
          protocolVersion: 1, appliedVersion: Number.MAX_SAFE_INTEGER,
          generation: Number.MAX_SAFE_INTEGER, browserVersion: "版本 140.0",
        },
      },
      {
        name: "heartbeat rejects unsafe generation",
        schema: "QuickloginDeviceHeartbeat",
        parser: parseHeartbeat,
        input: { protocolVersion: 1, appliedVersion: null, generation: 2 ** 53, browserVersion: "140" },
        ok: false, code: "INVALID_REQUEST", status: 400,
      },
      {
        name: "heartbeat rejects whitespace-only version",
        schema: "QuickloginDeviceHeartbeat",
        parser: parseHeartbeat,
        input: { protocolVersion: 1, appliedVersion: null, generation: 1, browserVersion: "   " },
        ok: false, cloudflareOk: true, code: "INVALID_REQUEST", status: 400,
      },
      {
        name: "heartbeat rejects a version beyond 40 characters",
        schema: "QuickloginDeviceHeartbeat",
        parser: parseHeartbeat,
        input: {
          protocolVersion: 1, appliedVersion: null, generation: 1,
          browserVersion: "1".repeat(41),
        },
        ok: false, code: "INVALID_REQUEST", status: 400,
      },
      {
        name: "heartbeat rejects leading Unicode whitespace",
        schema: "QuickloginDeviceHeartbeat",
        parser: parseHeartbeat,
        input: {
          protocolVersion: 1, appliedVersion: null, generation: 1,
          browserVersion: "\u3000140",
        },
        ok: false, cloudflareOk: true, code: "INVALID_REQUEST", status: 400,
      },
      {
        name: "heartbeat rejects non-BMP emoji",
        schema: "QuickloginDeviceHeartbeat",
        parser: parseHeartbeat,
        input: {
          protocolVersion: 1, appliedVersion: null, generation: 1,
          browserVersion: "Chrome🚀",
        },
        ok: false, cloudflareOk: true, code: "INVALID_REQUEST", status: 400,
      },
      {
        name: "heartbeat rejects an internal byte-order mark",
        schema: "QuickloginDeviceHeartbeat",
        parser: parseHeartbeat,
        input: {
          protocolVersion: 1, appliedVersion: null, generation: 1,
          browserVersion: "Chrome\uFEFF140",
        },
        ok: false, cloudflareOk: true, code: "INVALID_REQUEST", status: 400,
      },
      {
        name: "heartbeat rejects unsupported protocol separately",
        schema: "QuickloginDeviceHeartbeat",
        parser: parseHeartbeat,
        input: { protocolVersion: 2, appliedVersion: null, generation: 1, browserVersion: "140" },
        ok: false, code: "PROTOCOL_UNSUPPORTED", status: 426,
      },
      {
        name: "refresh rejects unsafe generation",
        schema: "QuickloginDeviceRefresh",
        parser: parseRefreshRequest,
        input: { protocolVersion: 1, generation: 2 ** 53 },
        ok: false, code: "INVALID_REQUEST", status: 400,
      },
      {
        name: "refresh rejects unsupported protocol separately",
        schema: "QuickloginDeviceRefresh",
        parser: parseRefreshRequest,
        input: { protocolVersion: 2, generation: 1 },
        ok: false, code: "PROTOCOL_UNSUPPORTED", status: 426,
      },
      {
        name: "export rejects unsafe session version",
        schema: "QuickloginDeviceExport",
        parser: parseExportRequest,
        input: { protocolVersion: 1, generation: 1, sessionVersion: 2 ** 53 },
        ok: false, code: "INVALID_REQUEST", status: 400,
      },
      {
        name: "export rejects unsupported protocol separately",
        schema: "QuickloginDeviceExport",
        parser: parseExportRequest,
        input: { protocolVersion: 2, generation: 1, sessionVersion: 1 },
        ok: false, code: "PROTOCOL_UNSUPPORTED", status: 426,
      },
    ];

    for (const sample of cases) {
      const parsed = result(sample.parser, sample.input);
      expect(parsed, sample.name).toMatchObject(sample.ok
        ? { ok: true, ...(sample.output === undefined ? {} : { value: sample.output }) }
        : { ok: false, code: sample.code, status: sample.status });
      expect(schemaAccepts(
        openapi.components.schemas[sample.schema],
        sample.input,
        openapi.components.schemas
      ), `${sample.name} OpenAPI 3.1`).toBe(sample.ok);
      expect(schemaAccepts(
        cloudflare.components.schemas[sample.schema],
        sample.input,
        cloudflare.components.schemas
      ), `${sample.name} Cloudflare 3.0`).toBe(sample.cloudflareOk ?? sample.ok);
    }
  });

  it("models all three preference modes without accepting a partial legacy payload", () => {
    const openapi = buildOpenApiDocument(listHttpOperations(createApp())) as Record<string, any>;
    const cloudflare = buildCloudflareSchema(openapi) as Record<string, any>;
    const valid = [
      { eligible: false },
      { eligible: true, masterEnabled: true, deviceLimit: 3, used: 2 },
      { eligible: true, enabled: false },
    ];
    for (const document of [openapi, cloudflare]) {
      for (const sample of valid) {
        expect(schemaAccepts(
          document.components.schemas.QuickloginPreference,
          sample,
          document.components.schemas
        )).toBe(true);
      }
      expect(schemaAccepts(
        document.components.schemas.QuickloginPreference,
        { enabled: true },
        document.components.schemas
      )).toBe(false);
    }
  });
});
