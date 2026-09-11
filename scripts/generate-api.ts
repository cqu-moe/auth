import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "../src/app";
import { listHttpOperations } from "../src/api/operations";
import { buildOpenApiDocument } from "../src/api/openapi/document";
import { buildCloudflareSchema } from "../src/api/openapi/cloudflare";
import { DatabaseSync } from "node:sqlite";
import { getBetterAuthOpenApi, mergeBetterAuthOpenApi } from "../src/api/openapi/auth";
import type { Env } from "../src/types";

async function main() {
const root = resolve(process.env.API_OUTPUT_ROOT ?? process.cwd());
const docsDir = resolve(root, "docs/api");
const sharedDir = resolve(root, "shared");
mkdirSync(docsDir, { recursive: true });
mkdirSync(sharedDir, { recursive: true });

const operations = listHttpOperations(createApp());
const database = new DatabaseSync(":memory:");
const values = new Map<string, string>();
const env = {
  DATABASE: database,
  KV: { get: async (key: string) => values.get(key) ?? null, put: async (key: string, value: string) => values.set(key, value), delete: async (key: string) => values.delete(key) },
  BETTER_AUTH_URL: "https://auth.cqu.moe",
  BETTER_AUTH_SECRET: "local-openapi-generation-secret-only-123456789",
  RESEND_API_KEY: "re_local_generation",
} as unknown as Env;
const authDocument = await getBetterAuthOpenApi(env, new Request("https://auth.cqu.moe"));
const document = mergeBetterAuthOpenApi(
  buildOpenApiDocument(operations) as unknown as Record<string, any>,
  authDocument as unknown as Record<string, any>
);
database.close();
const cloudflare = buildCloudflareSchema(document as unknown as Record<string, unknown>);
const kind = (path: string) => path.includes("/binding/events")
  ? "websocket"
  : path.startsWith("/.well-known") || path.includes("/.well-known/")
    ? "discovery"
    : path.startsWith("/api/v1") ? "canonical" : "legacy";
const endpoints = operations.map((operation) => ({
  host: "auth.cqu.moe",
  method: operation.method,
  path: operation.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}"),
  operationId: `${operation.method.toLowerCase()}_${operation.path}`.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, ""),
  kind: kind(operation.path),
}));
const coverage = endpoints.map((endpoint) => ({
  method: endpoint.method,
  path: endpoint.path,
  requestBody: endpoint.path.includes("/oauth2/token") ? "form-not-validated-by-cloudflare" : endpoint.kind === "websocket" ? "websocket-message-not-validated" : "documented",
  responseValidation: "not-supported-by-cloudflare",
}));
const writeJson = (name: string, value: unknown) =>
  writeFileSync(resolve(docsDir, name), `${JSON.stringify(value, null, 2)}\n`);
writeJson("openapi.json", document);
writeJson("cloudflare.openapi.json", cloudflare);
writeJson("endpoints.json", endpoints);
writeJson("coverage.json", coverage);

execFileSync(
  resolve(process.cwd(), "node_modules/.bin/openapi-typescript"),
  [resolve(docsDir, "openapi.json"), "-o", resolve(sharedDir, "api-types.generated.ts")],
  { stdio: "inherit" }
);
}

void main();
