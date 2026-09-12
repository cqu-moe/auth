import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createApp } from "../src/app";
import { listHttpOperations } from "../src/api/operations";
import { assertApiArtifactConsistency } from "../src/api/openapi/artifacts";

const temp = mkdtempSync(resolve(tmpdir(), "auth-api-check-"));
execFileSync(process.execPath, ["--import", "tsx", "scripts/generate-api.ts"], {
  cwd: process.cwd(),
  env: { ...process.env, API_OUTPUT_ROOT: temp },
  stdio: "inherit",
});
for (const file of [
  "docs/api/openapi.json",
  "docs/api/cloudflare.openapi.json",
  "docs/api/endpoints.json",
  "docs/api/coverage.json",
  "docs/api/auth-policy.json",
  "shared/api-types.generated.ts",
]) {
  const expected = readFileSync(resolve(process.cwd(), file));
  const actual = readFileSync(resolve(temp, file));
  if (!expected.equals(actual)) throw new Error(`Generated API artifact is stale: ${file}`);
  if (file === "docs/api/cloudflare.openapi.json" && expected.byteLength > 512 * 1024) {
    throw new Error(`Cloudflare API schema exceeds 512 KiB: ${expected.byteLength} bytes`);
  }
}

const readJson = (file: string) => JSON.parse(
  readFileSync(resolve(process.cwd(), file), "utf8")
);
assertApiArtifactConsistency({
  runtime: listHttpOperations(createApp()),
  openapi: readJson("docs/api/openapi.json"),
  cloudflare: readJson("docs/api/cloudflare.openapi.json"),
  endpoints: readJson("docs/api/endpoints.json"),
  coverage: readJson("docs/api/coverage.json"),
  authPolicy: readJson("docs/api/auth-policy.json"),
});
