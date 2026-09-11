import type { HttpOperation } from "../operations";

function openApiPath(path: string) {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function operationId(operation: HttpOperation) {
  return `${operation.method.toLowerCase()}_${operation.path}`
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function securityFor(path: string) {
  if (path.includes("/admin/")) return [{ cookieAuth: [] }];
  if (path.includes("/cqu/service-ticket")) return [{ bearerAuth: [] }];
  if (path.includes("/cqu/quicklogin")) return [{ cookieAuth: [] }];
  if (path.includes("/cqu/binding")) return [{ cookieAuth: [] }, { bearerAuth: [] }];
  return undefined;
}

function successSchemaFor(operation: HttpOperation): Record<string, unknown> | undefined {
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const data = (schema: Record<string, unknown>) => ({
    type: "object", required: ["data"], properties: { data: schema },
  });
  if (operation.path === "/api/v1/cqu/binding" && operation.method === "GET") {
    return data(ref("BindingSnapshot"));
  }
  if (operation.path === "/api/v1/admin/users" && operation.method === "GET") {
    return {
      type: "object", required: ["data", "pagination"],
      properties: { data: { type: "array", items: { type: "object" } }, pagination: ref("PageInfo") },
    };
  }
  if (operation.path === "/api/v1/admin/entitlement-presets" && operation.method === "GET") {
    return data({ type: "array", items: ref("EntitlementPreset") });
  }
  if (operation.path === "/api/v1/admin/registration-invitations" && operation.method === "GET") {
    return data({ type: "array", items: ref("RegistrationInvitation") });
  }
  if (operation.path === "/api/v1/admin/oauth-clients" && operation.method === "GET") {
    return data({ type: "array", items: ref("OAuthClientView") });
  }
  return undefined;
}

const entitlementItemRef = { $ref: "#/components/schemas/EntitlementItem" };

function requestSchemaFor(operation: HttpOperation): Record<string, unknown> | undefined {
  const path = operation.path.replace(/^\/api\/(?:v1\/)?admin/, "/admin");
  if (operation.path === "/api/v1/cqu/service-tickets" && operation.method === "POST") {
    return { oneOf: [
      { type: "object", additionalProperties: false, required: ["service"], properties: { service: { type: "string", enum: ["jwxt", "jxpj", "library", "card"] } } },
      { type: "object", additionalProperties: false, required: ["serviceUrl"], properties: { serviceUrl: { type: "string", format: "uri" } } },
    ] };
  }
  if (operation.path.endsWith("/cqu/binding") && operation.method === "POST") {
    return { type: "object", additionalProperties: false, properties: { kind: { type: "string", enum: ["direct", "forward"] } } };
  }
  if (operation.path.endsWith("/cqu/binding/credentials") && operation.method === "PUT") {
    return { type: "object", additionalProperties: false, required: ["studentId", "password"], properties: { studentId: { type: "string", minLength: 1 }, password: { type: "string", minLength: 1, writeOnly: true } } };
  }
  if (operation.path.endsWith("/cqu/quicklogin") && operation.method === "PUT") {
    return { type: "object", additionalProperties: false, required: ["enabled"], properties: { enabled: { type: "boolean" } } };
  }
  if (/^\/admin\/users\/:id$/.test(path) && operation.method === "PATCH") {
    return operation.path.startsWith("/api/v1")
      ? { oneOf: [
          { type: "object", additionalProperties: false, required: ["banned"], properties: { banned: { type: "boolean" } } },
          { type: "object", additionalProperties: false, required: ["role"], properties: { role: { type: "string", enum: ["user", "admin", "superAdmin"] } } },
        ] }
      : { type: "object", additionalProperties: false, properties: { action: { type: "string", enum: ["ban", "unban"] }, role: { type: "string", enum: ["user", "admin", "superAdmin"] } } };
  }
  if (path.endsWith("/cqu-binding") && operation.method === "PATCH") {
    return { type: "object", additionalProperties: false, required: ["status"], properties: { status: { type: "string", enum: ["active", "revoked"] } } };
  }
  if (path === "/admin/registration-invitations" && operation.method === "POST") {
    return { type: "object", additionalProperties: false, properties: { preset: { type: ["string", "null"] } } };
  }
  if (path === "/admin/registration-settings" && operation.method === "PUT") {
    return { type: "object", additionalProperties: false, required: ["invitationRequired"], properties: { invitationRequired: { type: "boolean" } } };
  }
  if (path.endsWith("/entitlements") && operation.method === "PUT") {
    return { type: "object", additionalProperties: false, required: ["items"], properties: { items: { type: "array", items: entitlementItemRef } } };
  }
  if (path.endsWith("/entitlements") && operation.method === "PATCH") {
    return { type: "object", additionalProperties: false, required: ["preset"], properties: { preset: { type: "string", minLength: 1 } } };
  }
  if (path.endsWith("/entitlements/preset") && operation.method === "POST") {
    return { type: "object", additionalProperties: false, required: ["preset"], properties: { preset: { type: "string", minLength: 1 } } };
  }
  if (path.includes("/entitlement-presets/") && operation.method === "PUT") {
    return { type: "object", additionalProperties: false, required: ["items"], properties: { items: { type: "array", items: entitlementItemRef } } };
  }
  if (path === "/admin/entitlement-default" && operation.method === "PUT") {
    return { type: "object", additionalProperties: false, required: operation.path.startsWith("/api/v1") ? ["preset"] : [], properties: { preset: { type: ["string", "null"] } } };
  }
  if (path.endsWith("/scopes") && operation.method === "PUT") {
    return { type: "object", additionalProperties: false, required: ["scopes"], properties: { scopes: { type: "array", uniqueItems: true, items: { type: "string", pattern: "^cqu:ticket:[\\w*]+$" } } } };
  }
  return undefined;
}

export function buildOpenApiDocument(operations: readonly HttpOperation[]) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of operations) {
    const path = openApiPath(operation.path);
    const parameters: Array<Record<string, unknown>> = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
      name: match[1], in: "path", required: true, schema: { type: "string" },
    }));
    if (operation.path === "/api/cqu/service-ticket" && operation.method === "GET") {
      parameters.push(
        { name: "service", in: "query", required: false, schema: { type: "string" } },
        { name: "serviceUrl", in: "query", required: false, schema: { type: "string", format: "uri" } }
      );
    }
    if (operation.path.endsWith("/admin/users") && operation.method === "GET") {
      parameters.push(
        { name: "page", in: "query", required: false, schema: { type: "integer", minimum: 1 } },
        { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100 } }
      );
    }
    const successSchema = successSchemaFor(operation);
    const requestSchema = requestSchemaFor(operation);
    const entry: Record<string, unknown> = {
      operationId: operationId(operation),
      summary: `${operation.method} ${operation.path}`,
      parameters,
      security: securityFor(operation.path) ?? [],
      responses: {
        "200": {
          description: "Successful response",
          ...(successSchema ? { content: { "application/json": { schema: successSchema } } } : {}),
        },
        "400": {
          description: "Invalid request",
          content: { "application/problem+json": { schema: { $ref: "#/components/schemas/ApiProblem" } } },
        },
      },
    };
    if (requestSchema) {
      entry.requestBody = {
        required: !(
          operation.path.endsWith("/cqu/binding") ||
          operation.path.endsWith("/registration-invitations") ||
          operation.path.endsWith("/secrets")
        ),
        content: { "application/json": { schema: requestSchema } },
      };
    }
    if (operation.path.includes("/entitlements") && operation.method !== "GET") {
      entry["x-required-permissions"] = operation.method === "DELETE"
        ? ["entitlement:revoke"]
        : ["entitlement:assign"];
    }
    if (operation.path.includes("/oauth-clients/") && operation.path.endsWith("/scopes") && operation.method === "PUT") {
      entry["x-required-permissions"] = ["cquScope:assign", "cquScope:revoke"];
    }
    paths[path] ??= {};
    paths[path][operation.method.toLowerCase()] = entry;
  }
  return {
    openapi: "3.1.1",
    info: { title: "CQU Auth API", version: "1.0.0", license: { name: "MIT" } },
    servers: [{ url: "https://auth.cqu.moe" }],
    paths,
    components: {
      securitySchemes: {
        cookieAuth: { type: "apiKey", in: "cookie", name: "__Secure-better-auth.session_token" },
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      },
      schemas: {
        ApiProblem: {
          type: "object",
          additionalProperties: false,
          required: ["type", "title", "status", "detail", "code"],
          properties: {
            type: { type: "string", const: "about:blank" },
            title: { type: "string" },
            status: { type: "integer" },
            detail: { type: "string" },
            code: { type: "string" },
          },
        },
        PageInfo: {
          type: "object", additionalProperties: false,
          required: ["page", "limit", "total", "totalPages"],
          properties: {
            page: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1, maximum: 100 },
            total: { type: "integer", minimum: 0 }, totalPages: { type: "integer", minimum: 1 },
          },
        },
        CquSessionStatus: {
          type: "object", required: ["status", "atrustStatus"], additionalProperties: true,
          properties: { status: { type: "string" }, atrustStatus: { type: "string" }, studentId: { type: "string" } },
        },
        BindingSnapshot: {
          type: "object", additionalProperties: false,
          required: ["bindStatus", "sessionStatus"],
          properties: {
            address: { type: "string" }, bindStatus: { type: "string", enum: ["unbound", "pending", "active", "revoked"] },
            kind: { type: "string", enum: ["direct", "forward"] }, forwardAddress: { type: "string" },
            sessionStatus: { anyOf: [{ $ref: "#/components/schemas/CquSessionStatus" }, { type: "object", required: ["error"], properties: { error: { type: "boolean", const: true } } }] },
          },
        },
        EntitlementItem: {
          type: "object", additionalProperties: false, required: ["subsystem", "capability", "value"],
          properties: { subsystem: { type: "string" }, capability: { type: "string" }, value: { type: "string" } },
        },
        EntitlementPreset: {
          type: "object", additionalProperties: false, required: ["name", "items", "updatedAt"],
          properties: { name: { type: "string" }, items: { type: "array", items: { $ref: "#/components/schemas/EntitlementItem" } }, updatedAt: { type: "string" } },
        },
        RegistrationInvitation: {
          type: "object", additionalProperties: true, required: ["code", "createdBy", "createdAt", "expiresAt", "status"],
          properties: { code: { type: "string", pattern: "^[A-Z0-9]{8}$" }, createdBy: { type: "string" }, createdAt: { type: "string" }, expiresAt: { type: "string" }, status: { type: "string" }, preset: { type: ["string", "null"] } },
        },
        OAuthClientView: {
          type: "object", additionalProperties: false, required: ["client_id"],
          properties: {
            client_id: { type: "string" }, client_name: { type: ["string", "null"] }, client_uri: { type: ["string", "null"] },
            logo_uri: { type: ["string", "null"] }, redirect_uris: { type: "array", items: { type: "string" } },
            post_logout_redirect_uris: { type: "array", items: { type: "string" } }, scope: { type: "string" },
            token_endpoint_auth_method: { type: ["string", "null"] }, grant_types: { type: "array", items: { type: "string" } },
            response_types: { type: "array", items: { type: "string" } }, require_pkce: { type: "boolean" },
            skip_consent: { type: "boolean" }, enable_end_session: { type: "boolean" }, disabled: { type: "boolean" },
          },
        },
      },
    },
  };
}
