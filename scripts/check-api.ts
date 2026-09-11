import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

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
  "shared/api-types.generated.ts",
]) {
  const expected = readFileSync(resolve(process.cwd(), file));
  const actual = readFileSync(resolve(temp, file));
  if (!expected.equals(actual)) throw new Error(`Generated API artifact is stale: ${file}`);
}
