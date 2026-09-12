import type { HttpOperation } from "../operations";
import type { AuthPolicyEntry } from "../auth-policy";
import { securityForPolicy } from "../auth-policy";

const HTTP_METHODS = new Set([
  "get", "head", "post", "put", "patch", "delete", "options", "trace",
]);

export const DISCOVERY_PATHS = new Set([
  "/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration",
  "/api/auth/.well-known/openid-configuration",
  "/api/auth/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server/api/auth",
]);

const APPROVED_LEGACY = new Set<string>();

export interface EndpointManifestEntry {
  host: string;
  method: string;
  path: string;
  operationId: string;
  kind: "canonical" | "legacy" | "discovery" | "websocket";
}

export interface CoverageManifestEntry {
  method: string;
  path: string;
  kind: EndpointManifestEntry["kind"];
  requestValidation:
    | "json-body-and-parameters"
    | "parameters-only"
    | "form-body-not-validated"
    | "websocket-messages-not-validated";
  requestReason: string;
  responseValidation: "not-supported-by-cloudflare";
  responseContract: "quicklogin-native" | "problem-details-or-protocol";
  responseReason: string;
}

function normalizedPath(path: string) {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function operationKey(method: string, path: string) {
  return `${method.toUpperCase()} ${path}`;
}

function documentOperations(document: Record<string, any>) {
  const result = new Map<string, Record<string, any>>();
  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem as Record<string, unknown>)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      if (!operation || typeof operation !== "object") {
        throw new Error(`Invalid OpenAPI operation ${method.toUpperCase()} ${path}`);
      }
      result.set(operationKey(method, path), operation as Record<string, any>);
    }
  }
  return result;
}

function kindFor(method: string, path: string): EndpointManifestEntry["kind"] {
  if (DISCOVERY_PATHS.has(path)) return "discovery";
  if (method === "GET" && path.endsWith("/cqu/binding/events")) return "websocket";
  if (path.startsWith("/api/v1")) return "canonical";
  return "legacy";
}

function assertSameSet(label: string, left: Iterable<string>, right: Iterable<string>) {
  const a = [...left].sort();
  const b = [...right].sort();
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    const onlyLeft = a.filter((entry) => !b.includes(entry));
    const onlyRight = b.filter((entry) => !a.includes(entry));
    throw new Error(
      `${label} operation mismatch; only-left=${JSON.stringify(onlyLeft)}; ` +
      `only-right=${JSON.stringify(onlyRight)}`
    );
  }
}

export function buildEndpointManifest(
  operations: readonly HttpOperation[],
  document: Record<string, any>
): EndpointManifestEntry[] {
  const documented = documentOperations(document);
  const runtimeKeys = operations.map(({ method, path }) =>
    operationKey(method, normalizedPath(path))
  );
  assertSameSet("runtime/OpenAPI", runtimeKeys, documented.keys());

  return operations.map(({ method, path }) => {
    const normalized = normalizedPath(path);
    const operation = documented.get(operationKey(method, normalized));
    if (!operation || typeof operation.operationId !== "string" || !operation.operationId) {
      throw new Error(`Missing operationId for ${method} ${normalized}`);
    }
    return {
      host: "auth.cqu.moe",
      method,
      path: normalized,
      operationId: operation.operationId,
      kind: kindFor(method, normalized),
    };
  });
}

export function buildCoverageManifest(
  endpoints: readonly EndpointManifestEntry[],
  document: Record<string, any>
): CoverageManifestEntry[] {
  const documented = documentOperations(document);
  return endpoints.map((endpoint) => {
    const operation = documented.get(operationKey(endpoint.method, endpoint.path)) ?? {};
    const content = operation.requestBody?.content as Record<string, unknown> | undefined;
    const contentTypes = Object.keys(content ?? {});
    const isForm = contentTypes.length > 0 && !contentTypes.includes("application/json");
    const isNative = /^\/api\/(?:v1\/)?cqu\/quicklogin\/devices(?:\/|$)/
      .test(endpoint.path);
    let requestValidation: CoverageManifestEntry["requestValidation"];
    let requestReason: string;
    if (endpoint.kind === "websocket") {
      requestValidation = "websocket-messages-not-validated";
      requestReason = "Cloudflare validates the HTTP handshake, not WebSocket messages.";
    } else if (isForm) {
      requestValidation = "form-body-not-validated";
      requestReason = "Cloudflare Schema Validation does not validate form request bodies.";
    } else if (contentTypes.includes("application/json")) {
      requestValidation = "json-body-and-parameters";
      requestReason = "The Cloudflare projection retains the JSON body and path/query parameters.";
    } else {
      requestValidation = "parameters-only";
      requestReason = "This operation has no JSON request body; documented parameters remain projected.";
    }
    return {
      method: endpoint.method,
      path: endpoint.path,
      kind: endpoint.kind,
      requestValidation,
      requestReason,
      responseValidation: "not-supported-by-cloudflare",
      responseContract: isNative ? "quicklogin-native" : "problem-details-or-protocol",
      responseReason: isNative
        ? "The application returns the native QuickLogin DTO/error contract; Cloudflare does not validate responses."
        : "The application or protocol handler enforces the documented response; Cloudflare does not validate responses.",
    };
  });
}

function scanReferences(value: unknown, pointer = "#") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanReferences(entry, `${pointer}/${index}`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === "$ref" && typeof entry === "string" && !entry.startsWith("#/")) {
      throw new Error(`External reference at ${pointer}/$ref`);
    }
    scanReferences(entry, `${pointer}/${key}`);
  }
}

export function assertApiArtifactConsistency(input: {
  runtime: readonly HttpOperation[];
  openapi: Record<string, any>;
  cloudflare: Record<string, any>;
  endpoints: readonly EndpointManifestEntry[];
  coverage: readonly CoverageManifestEntry[];
  authPolicy: readonly AuthPolicyEntry[];
}) {
  const runtimeKeys = input.runtime.map(({ method, path }) =>
    operationKey(method, normalizedPath(path))
  );
  const openapi = documentOperations(input.openapi);
  const cloudflare = documentOperations(input.cloudflare);
  const endpointKeys = input.endpoints.map(({ method, path }) => operationKey(method, path));
  const coverageKeys = input.coverage.map(({ method, path }) => operationKey(method, path));
  const authPolicyKeys = input.authPolicy.map(({ method, path }) =>
    operationKey(method, normalizedPath(path))
  );
  assertSameSet("runtime/OpenAPI", runtimeKeys, openapi.keys());
  assertSameSet("runtime/Cloudflare", runtimeKeys, cloudflare.keys());
  assertSameSet("runtime/endpoints", runtimeKeys, endpointKeys);
  assertSameSet("runtime/coverage", runtimeKeys, coverageKeys);
  assertSameSet("runtime/auth-policy", runtimeKeys, authPolicyKeys);

  const operationIds = input.endpoints.map((endpoint) => endpoint.operationId);
  if (new Set(operationIds).size !== operationIds.length) {
    throw new Error("Duplicate operationId in endpoint manifest");
  }
  for (const endpoint of input.endpoints) {
    const key = operationKey(endpoint.method, endpoint.path);
    const documented = openapi.get(key);
    const projected = cloudflare.get(key);
    if (documented?.operationId !== endpoint.operationId ||
        projected?.operationId !== endpoint.operationId) {
      throw new Error(`operationId mismatch for ${endpoint.method} ${endpoint.path}`);
    }
    if (endpoint.kind !== kindFor(endpoint.method, endpoint.path)) {
      throw new Error(`Incorrect endpoint kind for ${endpoint.method} ${endpoint.path}`);
    }
    const policy = input.authPolicy.find(({ method, path }) =>
      operationKey(method, normalizedPath(path)) === key
    );
    if (!policy || JSON.stringify(documented?.security ?? []) !==
        JSON.stringify(securityForPolicy(policy.policy))) {
      throw new Error(`Authentication policy mismatch for ${key}`);
    }
    const coverage = input.coverage.find(({ method, path }) =>
      operationKey(method, path) === key
    );
    const documentedContent = documented?.requestBody?.content ?? {};
    const projectedContent = projected?.requestBody?.content ?? {};
    if (coverage?.requestValidation === "json-body-and-parameters" &&
        (!documentedContent["application/json"] || !projectedContent["application/json"])) {
      throw new Error(`JSON request body was not retained for ${key}`);
    }
    if (coverage?.requestValidation === "form-body-not-validated" &&
        (!Object.keys(documentedContent).some((type) => type !== "application/json") ||
         projected?.requestBody)) {
      throw new Error(`Form request-body exception is inconsistent for ${key}`);
    }
    const native = /^\/api\/(?:v1\/)?cqu\/quicklogin\/devices(?:\/|$)/
      .test(endpoint.path);
    if (coverage?.responseContract !==
        (native ? "quicklogin-native" : "problem-details-or-protocol")) {
      throw new Error(`Response coverage is inconsistent for ${key}`);
    }
  }

  const legacyKeys = input.endpoints
    .filter(({ kind }) => kind === "legacy")
    .map(({ method, path }) => operationKey(method, path));
  assertSameSet("approved legacy", legacyKeys, APPROVED_LEGACY);
  const discovery = input.endpoints
    .filter(({ kind }) => kind === "discovery")
    .map(({ path }) => path);
  assertSameSet("permanent discovery", discovery, DISCOVERY_PATHS);
  if (input.endpoints.some(({ path }) => path.includes("*"))) {
    throw new Error("Wildcard API endpoint is not allowed in generated artifacts");
  }

  if (input.openapi.openapi !== "3.1.1" || input.cloudflare.openapi !== "3.0.3") {
    throw new Error("Unexpected OpenAPI version");
  }
  const servers = input.cloudflare.servers as Array<{ url?: string }> | undefined;
  if (!servers?.length || servers.some(({ url }) => {
    try {
      if (!url) return true;
      return !["http:", "https:"].includes(new URL(url).protocol);
    }
    catch { return true; }
  })) throw new Error("Cloudflare document requires absolute HTTP(S) servers");
  scanReferences(input.cloudflare);
}
