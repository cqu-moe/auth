import { betterAuth } from "better-auth";
import { openAPI } from "better-auth/plugins";
import { createAuth } from "../../auth";
import type { Env } from "../../types";
import { policyForOperation, securityForPolicy } from "../auth-policy";

export async function getBetterAuthOpenApi(env: Env, request: Request) {
  const configured = createAuth(env, request);
  const schemaAuth = betterAuth({
    ...configured.options,
    plugins: [
      ...(configured.options.plugins ?? []),
      openAPI({ disableDefaultReference: true }),
    ],
  });
  return schemaAuth.api.generateOpenAPISchema();
}

function rewriteRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteRefs);
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  if (source.nullable === true) {
    if (typeof source.type === "string") output.type = [source.type, "null"];
    else if (Array.isArray(source.type) && !source.type.includes("null")) output.type = [...source.type, "null"];
  }
  for (const [key, entry] of Object.entries(source)) {
    if (key === "nullable") continue;
    if (key === "type" && typeof entry === "string" && entry.endsWith("[]")) {
      output.type = "array";
      output.items = { type: entry.slice(0, -2) };
      continue;
    }
    if (key === "type" && entry === "json") {
      output.type = "object";
      output.additionalProperties = true;
      continue;
    }
    if (key === "type" && output.type !== undefined) continue;
    if (key === "$ref" && typeof entry === "string" && entry.startsWith("#/components/schemas/")) {
      output[key] = entry.replace("#/components/schemas/", "#/components/schemas/Auth");
    } else if (key === "security" && Array.isArray(entry)) {
      output[key] = entry.map((requirement) => {
        if (!requirement || typeof requirement !== "object") return requirement;
        const mapped: Record<string, unknown> = {};
        for (const [scheme, scopes] of Object.entries(requirement as Record<string, unknown>)) {
          mapped[scheme === "apiKeyCookie" ? "cookieAuth" : scheme] = scopes;
        }
        return mapped;
      });
    } else output[key] = rewriteRefs(entry);
  }
  return output;
}

function addPathParameters(path: string, item: Record<string, any>) {
  const names = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
  for (const operation of Object.values(item)) {
    if (!operation || typeof operation !== "object") continue;
    const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
    for (const name of names) {
      if (!parameters.some((parameter: any) => parameter?.in === "path" && parameter?.name === name)) {
        parameters.push({ name, in: "path", required: true, schema: { type: "string" } });
      }
    }
    operation.parameters = parameters;
  }
}

function pruneSchemas(document: Record<string, any>) {
  const schemas = document.components.schemas as Record<string, unknown>;
  const used = new Set<string>();
  const scan = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(scan);
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === "$ref" && typeof entry === "string" && entry.startsWith("#/components/schemas/")) {
        used.add(entry.slice("#/components/schemas/".length));
      } else scan(entry);
    }
  };
  scan(document.paths);
  let size = -1;
  while (size !== used.size) {
    size = used.size;
    for (const name of [...used]) scan(schemas[name]);
  }
  for (const name of Object.keys(schemas)) if (!used.has(name)) delete schemas[name];
}

export function mergeBetterAuthOpenApi(
  base: Record<string, any>,
  authDocument: Record<string, any>
) {
  const document = structuredClone(base);
  for (const [name, schema] of Object.entries(authDocument.components?.schemas ?? {})) {
    document.components.schemas[`Auth${name}`] = rewriteRefs(schema);
  }
  for (const [suffix, pathItem] of Object.entries(authDocument.paths ?? {})) {
    const rewritten = rewriteRefs(pathItem) as Record<string, any>;
    if (suffix === "/get-session") delete rewritten.post;
    addPathParameters(suffix, rewritten);
    for (const [method, operation] of Object.entries(rewritten)) {
      if (!operation || typeof operation !== "object") continue;
      (operation as Record<string, unknown>).operationId = `auth_${method}_${suffix}`
        .replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "");
      (operation as Record<string, unknown>).summary ??= `${method.toUpperCase()} auth ${suffix}`;
      const policyPath = `/api/v1/auth${suffix}`.replace(/\{([^}]+)\}/g, ":$1");
      const policy = policyForOperation({ method: method.toUpperCase(), path: policyPath });
      if (!policy) throw new Error(`Missing auth policy for ${method.toUpperCase()} ${suffix}`);
      (operation as Record<string, unknown>).security = securityForPolicy(policy);
    }
    if (suffix === "/error" && rewritten.get) {
      rewritten.get.responses = {
        "302": {
          description: "Redirect to the safe application error page",
          headers: { Location: { schema: { type: "string", const: "/auth/error" } } },
        },
      };
    }
    if (suffix === "/get-session" && rewritten.get) {
      rewritten.get.security = [];
      const schema = rewritten.get.responses?.["200"]?.content?.["application/json"]?.schema;
      if (schema?.properties) {
        schema.properties.caps = { type: "object", additionalProperties: { type: "object", additionalProperties: true } };
        if (Array.isArray(schema.required) && !schema.required.includes("caps")) schema.required.push("caps");
      }
    }
    if (suffix === "/sign-up/email" && rewritten.post) {
      rewritten.post.security = [];
      const schema = rewritten.post.requestBody?.content?.["application/json"]?.schema;
      if (schema?.properties) schema.properties.code = { type: "string", pattern: "^[A-Z0-9]{8}$" };
    }
    if (["/oauth2/token", "/oauth2/introspect", "/oauth2/revoke"].includes(suffix) &&
        rewritten.post?.requestBody?.content?.["application/json"]) {
      rewritten.post.requestBody.content = {
        "application/x-www-form-urlencoded":
          rewritten.post.requestBody.content["application/json"],
      };
    }
    const canonicalPath = `/api/v1/auth${suffix}`;
    const canonicalRuntime = document.paths[canonicalPath] as Record<string, any> | undefined;
    if (canonicalRuntime) {
      const canonical: Record<string, any> = {};
      for (const [method, runtimeOperation] of Object.entries(canonicalRuntime)) {
        const generated = rewritten[method];
        if (!generated || typeof generated !== "object") {
          canonical[method] = runtimeOperation;
          continue;
        }
        canonical[method] = {
          ...generated,
          operationId: runtimeOperation.operationId,
          summary: generated.summary ?? runtimeOperation.summary,
        };
      }
      document.paths[canonicalPath] = canonical;
    }

    const legacyPath = `/api/auth${suffix}`;
    const legacyRuntime = document.paths[legacyPath] as Record<string, any> | undefined;
    if (legacyRuntime) {
      const legacy: Record<string, any> = {};
      for (const [method, runtimeOperation] of Object.entries(legacyRuntime)) {
        const generated = rewritten[method];
        if (!generated || typeof generated !== "object") {
          legacy[method] = runtimeOperation;
          continue;
        }
        legacy[method] = {
          ...structuredClone(generated),
          operationId: runtimeOperation.operationId,
          summary: generated.summary ?? runtimeOperation.summary,
        };
      }
      document.paths[legacyPath] = legacy;
    }
  }
  pruneSchemas(document);
  return document;
}
