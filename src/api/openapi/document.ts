import type { HttpOperation } from "../operations";
import { buildAuthPolicy, securityForPolicy } from "../auth-policy";
import { z } from "@hono/zod-openapi";
import { CreateCquBindingBody, CquCredentialsBody } from "../v1/cqu-binding.schema";
import { QuickloginPreferenceBody } from "../v1/cqu-quicklogin.schema";
import { TicketTargetSchema } from "../v1/cqu-service-tickets.schema";
import { CreateInvitationBody, RegistrationSettingsBody } from "../v1/admin/invitations.schema";
import { UserPatchSchema } from "../v1/admin/users.schema";
import {
  EntitlementDefaultBody,
  MergeEntitlementPresetBody,
  ReplaceEntitlementsBody,
} from "../v1/admin/entitlements.schema";
import {
  OAuthClientCreateBody,
  OAuthClientPatchBody,
  OAuthClientScopesBody,
  OAuthClientSecretBody,
} from "../v1/admin/oauth-clients.schema";
import {
  QUICKLOGIN_SCHEMAS,
  quickloginOperationContract,
} from "./quicklogin";

function openApiPath(path: string) {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function operationId(operation: HttpOperation) {
  return `${operation.method.toLowerCase()}_${operation.path}`
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function securityFor(operation: HttpOperation) {
  return securityForPolicy(buildAuthPolicy([operation])[0].policy);
}

function successSchemaFor(operation: HttpOperation): Record<string, unknown> {
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const data = (schema: Record<string, unknown>) => ({
    type: "object", required: ["data"], properties: { data: schema },
  });
  if (operation.method === "DELETE" || operation.method === "OPTIONS" ||
      operation.path.endsWith("/cqu/binding/events") ||
      operation.path.includes("/quicklogin")) return {};
  if (operation.path === "/api/v1/cqu/binding" && operation.method === "GET") {
    return data(ref("BindingSnapshot"));
  }
  if (operation.path === "/api/v1/cqu/binding" && operation.method === "POST") {
    return data({
      type: "object", additionalProperties: false, required: ["address", "status"],
      properties: { address: { type: "string" }, status: { type: "string" } },
    });
  }
  if (operation.path === "/api/v1/cqu/binding/credentials") {
    return data({
      type: "object", additionalProperties: false, required: ["studentId"],
      properties: { studentId: { type: "string" } },
    });
  }
  if (operation.path === "/api/v1/admin/users" && operation.method === "GET") {
    return {
      type: "object", required: ["data", "pagination"],
      properties: { data: { type: "array", items: ref("ApiUser") }, pagination: ref("PageInfo") },
    };
  }
  if (operation.path === "/api/v1/admin/users/:id" && operation.method === "GET") {
    return data(ref("ApiUser"));
  }
  if (operation.path === "/api/v1/admin/users/:id" && operation.method === "PATCH") {
    return data({
      oneOf: [
        { type: "object", additionalProperties: false, required: ["id", "banned"], properties: { id: { type: "string" }, banned: { type: "boolean" } } },
        { type: "object", additionalProperties: false, required: ["id", "role"], properties: { id: { type: "string" }, role: { type: "string", enum: ["user", "admin", "superAdmin"] } } },
      ],
    });
  }
  if (operation.path.endsWith("/cqu-binding") && operation.method === "PATCH") {
    return data({
      type: "object", additionalProperties: false, required: ["status"],
      properties: { status: { type: "string", enum: ["active", "revoked"] } },
    });
  }
  if (operation.path === "/api/v1/admin/entitlement-presets" && operation.method === "GET") {
    return data({ type: "array", items: ref("EntitlementPreset") });
  }
  if (operation.path === "/api/v1/admin/registration-invitations" && operation.method === "GET") {
    return data({ type: "array", items: ref("RegistrationInvitation") });
  }
  if (operation.path.endsWith("/users/:id/entitlements") && operation.method === "GET") {
    return data({ type: "array", items: ref("EntitlementRow") });
  }
  if (operation.path.endsWith("/users/:id/entitlements") && operation.method === "PUT") {
    return data({
      type: "object", additionalProperties: false, required: ["items"],
      properties: { items: { type: "array", items: ref("EntitlementItem") } },
    });
  }
  if (operation.path.endsWith("/users/:id/entitlements") && operation.method === "PATCH") {
    return data({ type: "object", additionalProperties: false, required: ["applied"], properties: { applied: { type: "integer", minimum: 0 } } });
  }
  if (operation.path.includes("/entitlement-presets/:name") && operation.method === "PUT") {
    return data({
      type: "object", additionalProperties: false, required: ["name", "items"],
      properties: { name: { type: "string" }, items: { type: "array", items: ref("EntitlementItem") } },
    });
  }
  if (operation.path.endsWith("/entitlement-default")) {
    return data({ type: "object", additionalProperties: false, required: ["preset"], properties: { preset: { type: ["string", "null"] } } });
  }
  if (operation.path === "/api/v1/admin/oauth-clients" && operation.method === "GET") {
    return data({ type: "array", items: ref("OAuthClientView") });
  }
  if (operation.path === "/api/v1/health") {
    return data({
      type: "object", additionalProperties: false, required: ["status", "timestamp"],
      properties: { status: { type: "string", const: "ok" }, timestamp: { type: "string", format: "date-time" } },
    });
  }
  if (operation.path === "/api/v1/cqu/service-tickets") {
    return data({
      type: "object", additionalProperties: false, required: ["ticket"],
      properties: { ticket: { type: "string", minLength: 1 } },
    });
  }
  if (operation.path.endsWith("/registration-settings")) {
    return data({
      type: "object", additionalProperties: false, required: ["invitationRequired"],
      properties: { invitationRequired: { type: "boolean" } },
    });
  }
  if (operation.path.includes("/.well-known/") || operation.path.startsWith("/.well-known/")) {
    return {
      type: "object", additionalProperties: true, required: ["issuer"],
      properties: {
        issuer: { type: "string", format: "uri" },
        authorization_endpoint: { type: "string", format: "uri" },
        token_endpoint: { type: "string", format: "uri" },
        jwks_uri: { type: "string", format: "uri" },
      },
    };
  }
  if (operation.path === "/api/v1/openapi.json") {
    return {
      type: "object", additionalProperties: true, required: ["openapi", "info", "paths"],
      properties: { openapi: { type: "string", const: "3.1.1" }, info: { type: "object" }, paths: { type: "object" } },
    };
  }
  if (operation.path.endsWith("/registration-invitations") && operation.method === "POST") {
    return data({ allOf: [ref("RegistrationInvitation"), {
      type: "object", required: ["registrationUrl"], properties: { registrationUrl: { type: "string", format: "uri" } },
    }] });
  }
  if (operation.path.includes("/oauth-clients") && operation.method === "POST") {
    return data({ type: "object", additionalProperties: true, required: ["client_id"], properties: { client_id: { type: "string" }, client_secret: { type: "string", writeOnly: true } } });
  }
  if (operation.path.endsWith("/oauth-clients/:id") && operation.method === "PATCH") {
    return data({ type: "object", additionalProperties: false, required: ["client_id"], properties: { client_id: { type: "string" }, client_secret: { type: "string", writeOnly: true } } });
  }
  if (operation.path.endsWith("/scopes")) {
    return data({ type: "object", additionalProperties: false, required: ["client_id", "scopes"], properties: { client_id: { type: "string" }, scopes: { type: "array", items: { type: "string" } } } });
  }
  if (operation.path.startsWith("/api/v1/auth/") || operation.path.startsWith("/api/auth/")) {
    return { type: "object", additionalProperties: true };
  }
  throw new Error(`Missing success response schema for ${operation.method} ${operation.path}`);
}

const entitlementItemRef = { $ref: "#/components/schemas/EntitlementItem" };

function requestSchemaFor(operation: HttpOperation): Record<string, unknown> | undefined {
  const schema = (value: any) => {
    const { $schema: _draft, ...result } = z.toJSONSchema(value as any) as Record<string, unknown>;
    return result;
  };
  const path = operation.path.replace(/^\/api\/(?:v1\/)?admin/, "/admin");
  if (operation.path === "/api/v1/cqu/service-tickets" && operation.method === "POST") {
    return schema(TicketTargetSchema);
  }
  if (operation.path.endsWith("/cqu/binding") && operation.method === "POST") {
    return schema(CreateCquBindingBody);
  }
  if (operation.path.endsWith("/cqu/binding/credentials") && operation.method === "PUT") {
    const output = schema(CquCredentialsBody);
    ((output.properties as Record<string, any>).password).writeOnly = true;
    return output;
  }
  if (operation.path.endsWith("/cqu/quicklogin") && operation.method === "PUT") {
    return schema(QuickloginPreferenceBody);
  }
  if (/^\/admin\/users\/:id$/.test(path) && operation.method === "PATCH") {
    return operation.path.startsWith("/api/v1")
      ? schema(UserPatchSchema)
      : { type: "object", additionalProperties: false, properties: { action: { type: "string", enum: ["ban", "unban"] }, role: { type: "string", enum: ["user", "admin", "superAdmin"] } } };
  }
  if (path.endsWith("/cqu-binding") && operation.method === "PATCH") {
    return { type: "object", additionalProperties: false, required: ["status"], properties: { status: { type: "string", enum: ["active", "revoked"] } } };
  }
  if (path === "/admin/registration-invitations" && operation.method === "POST") {
    return schema(CreateInvitationBody);
  }
  if (path === "/admin/registration-settings" && operation.method === "PUT") {
    return schema(RegistrationSettingsBody);
  }
  if (path.endsWith("/entitlements") && operation.method === "PUT") {
    return schema(ReplaceEntitlementsBody);
  }
  if (path.endsWith("/entitlements") && operation.method === "PATCH") {
    return schema(MergeEntitlementPresetBody);
  }
  if (path.endsWith("/entitlements/preset") && operation.method === "POST") {
    return { type: "object", additionalProperties: false, required: ["preset"], properties: { preset: { type: "string", minLength: 1 } } };
  }
  if (path.includes("/entitlement-presets/") && operation.method === "PUT") {
    return schema(ReplaceEntitlementsBody);
  }
  if (path === "/admin/entitlement-default" && operation.method === "PUT") {
    return operation.path.startsWith("/api/v1") ? schema(EntitlementDefaultBody) : { type: "object", additionalProperties: false, properties: { preset: { type: ["string", "null"] } } };
  }
  if (path.endsWith("/scopes") && operation.method === "PUT") {
    const output = schema(OAuthClientScopesBody);
    ((output.properties as Record<string, any>).scopes).uniqueItems = true;
    ((output.properties as Record<string, any>).scopes.items).pattern = "^cqu:ticket:[\\w*]+$";
    return output;
  }
  if (operation.path === "/api/v1/admin/oauth-clients" && operation.method === "POST") {
    return schema(OAuthClientCreateBody);
  }
  if (/^\/api\/v1\/admin\/oauth-clients\/:id$/.test(operation.path) && operation.method === "PATCH") {
    return { ...schema(OAuthClientPatchBody), minProperties: 1 };
  }
  if (operation.path.endsWith("/oauth-clients/:id/secrets") && operation.method === "POST") {
    return schema(OAuthClientSecretBody);
  }
  return undefined;
}

function successStatuses(operation: HttpOperation): string[] {
  if (operation.method === "DELETE") return ["204"];
  if (operation.path.endsWith("/cqu/binding/events")) return ["101"];
  if (operation.path.endsWith("/cqu/binding") && operation.method === "POST") return ["200", "201"];
  if (operation.path === "/api/v1/cqu/service-tickets" ||
      (operation.path === "/api/v1/admin/registration-invitations" && operation.method === "POST") ||
      (operation.path === "/api/v1/admin/oauth-clients" && operation.method === "POST") ||
      operation.path.endsWith("/oauth-clients/:id/secrets")) return ["201"];
  return ["200"];
}

function responsesFor(
  operation: HttpOperation,
  schema: Record<string, unknown>,
  hasJsonBody: boolean
) {
  const responses: Record<string, unknown> = {};
  const sensitive = operation.path.startsWith("/api/v1/admin/") ||
    operation.path.startsWith("/api/v1/cqu/");
  for (const status of successStatuses(operation)) {
    if (status === "204") responses[status] = { description: "No content" };
    else if (status === "101") responses[status] = {
      description: "WebSocket protocol switch",
      headers: {
        Upgrade: { schema: { type: "string", const: "websocket" } },
        Connection: { schema: { type: "string", const: "Upgrade" } },
      },
    };
    else responses[status] = {
      description: status === "201" ? "Created" : "Successful response",
      ...(sensitive ? { headers: { "Cache-Control": { schema: { type: "string", const: "no-store" } } } } : {}),
      content: { "application/json": { schema } },
    };
  }
  const hasValidatedQuery =
    (operation.path.endsWith("/admin/users") && operation.method === "GET") ||
    (operation.path.endsWith("/cqu/binding") && ["GET", "DELETE"].includes(operation.method));
  const problemResponse = (description: string) => ({
    description,
    ...(sensitive ? { headers: { "Cache-Control": { schema: { type: "string", const: "no-store" } } } } : {}),
    content: { "application/problem+json": { schema: { $ref: "#/components/schemas/ApiProblem" } } },
  });
  if (hasJsonBody || hasValidatedQuery) responses["400"] = problemResponse("Invalid request");
  if (hasJsonBody) responses["415"] = problemResponse("Unsupported request media type");
  return responses;
}

export function buildOpenApiDocument(operations: readonly HttpOperation[]) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of operations) {
    const path = openApiPath(operation.path);
    const parameters: Array<Record<string, unknown>> = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
      name: match[1], in: "path", required: true,
      schema: { type: "string", minLength: 1 },
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
      security: securityFor(operation),
      responses: responsesFor(operation, successSchema, requestSchema !== undefined),
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
    const quickloginContract = quickloginOperationContract(operation);
    if (quickloginContract) Object.assign(entry, quickloginContract);
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
        oauthClientAuth: { type: "http", scheme: "basic" },
        twoFactorCookie: { type: "apiKey", in: "cookie", name: "__Secure-better-auth.two_factor" },
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
          type: "object", required: ["status"], additionalProperties: true,
          properties: { status: { type: "string" }, studentId: { type: "string" } },
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
        EntitlementRow: {
          type: "object", additionalProperties: false,
          required: ["userId", "subsystem", "capability", "value"],
          properties: {
            userId: { type: "string" }, subsystem: { type: "string" },
            capability: { type: "string" }, value: { type: "string" },
          },
        },
        ApiUser: {
          type: "object", additionalProperties: true, required: ["id"],
          properties: {
            id: { type: "string" }, email: { type: "string", format: "email" },
            name: { type: "string" }, role: { type: ["string", "null"] },
            banned: { type: ["boolean", "null"] },
          },
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
        ...QUICKLOGIN_SCHEMAS,
      },
    },
  };
}
