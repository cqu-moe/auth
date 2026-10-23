import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "../src/app";
import { listHttpOperations } from "../src/api/operations";
import { buildOpenApiDocument } from "../src/api/openapi/document";
import { buildCloudflareSchema } from "../src/api/openapi/cloudflare";
import { DatabaseSync } from "node:sqlite";
import { getBetterAuthOpenApi, mergeBetterAuthOpenApi } from "../src/api/openapi/auth";
import {
  assertApiArtifactConsistency,
  buildCoverageManifest,
  buildEndpointManifest,
} from "../src/api/openapi/artifacts";
import type { Env } from "../src/types";
import { buildAuthPolicy } from "../src/api/auth-policy";

async function main() {
const root = resolve(process.env.API_OUTPUT_ROOT ?? process.cwd());
const docsDir = resolve(root, "docs/api");
const sharedDir = resolve(root, "shared");
mkdirSync(docsDir, { recursive: true });
mkdirSync(sharedDir, { recursive: true });

const operations = listHttpOperations(createApp());
const database = new DatabaseSync(":memory:");
const env = {
  DATABASE: database,
  BETTER_AUTH_URL: "https://auth.cqu.moe",
  BETTER_AUTH_SECRET: "local-openapi-generation-secret-only-123456789",
  AUTH_RESEND_API_KEY: "re_local_generation",
} as unknown as Env;
const authDocument = await getBetterAuthOpenApi(env, new Request("https://auth.cqu.moe"));
const document = mergeBetterAuthOpenApi(
  buildOpenApiDocument(operations) as unknown as Record<string, any>,
  authDocument as unknown as Record<string, any>
);
database.close();
const cloudflare = buildCloudflareSchema(document as unknown as Record<string, unknown>);
const endpoints = buildEndpointManifest(operations, document);
const coverage = buildCoverageManifest(endpoints, document);
const authPolicy = buildAuthPolicy(operations);
assertApiArtifactConsistency({
  runtime: operations,
  openapi: document,
  cloudflare,
  endpoints,
  coverage,
  authPolicy,
});
const writeJson = (name: string, value: unknown, compact = false) =>
  writeFileSync(
    resolve(docsDir, name),
    `${JSON.stringify(value, null, compact ? undefined : 2)}\n`
  );
writeJson("openapi.json", document);
writeJson("cloudflare.openapi.json", cloudflare, true);
writeJson("endpoints.json", endpoints);
writeJson("coverage.json", coverage);
writeJson("auth-policy.json", authPolicy);

execFileSync(
  resolve(process.cwd(), "node_modules/.bin/openapi-typescript"),
  [resolve(docsDir, "openapi.json"), "-o", resolve(sharedDir, "api-types.generated.ts")],
  { stdio: "inherit" }
);
}

void main();
