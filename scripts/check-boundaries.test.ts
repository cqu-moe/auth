import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkBoundaries } from "./check-boundaries";

function fixture(frontendImport: string) {
  const root = mkdtempSync(resolve(tmpdir(), "boundary-test-"));
  for (const path of ["src", "shared", "frontend/src"]) mkdirSync(resolve(root, path), { recursive: true });
  writeFileSync(resolve(root, "src/private.ts"), "export const privateValue = 1;\n");
  writeFileSync(resolve(root, "shared/value.ts"), "export const value = 1;\n");
  writeFileSync(resolve(root, "frontend/src/page.ts"), frontendImport);
  return root;
}

describe("import boundary checker", () => {
  it("accepts shared imports and rejects imports resolving into backend src", () => {
    expect(checkBoundaries(fixture('import { value } from "../../shared/value"; void value;\n'))).toEqual([]);
    expect(checkBoundaries(fixture('import { privateValue } from "../../src/private"; void privateValue;\n')))
      .toEqual([expect.stringContaining("frontend import resolves into backend src")]);
  });
});
