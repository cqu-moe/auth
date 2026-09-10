import { readFile } from "node:fs/promises";
import {
  assertMigrationApplicable,
  previewQuickloginMigration,
  type LegacyQuickloginUser,
  type QuickloginMapping,
} from "../src/services/quicklogin/migration";

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function jsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function main(): Promise<void> {
  const mappingPath = argument("--mapping");
  const legacyPath = argument("--legacy-export");
  if (!mappingPath || !legacyPath) {
    throw new Error("usage: --dry-run --mapping <path> --legacy-export <path>");
  }
  const preview = await previewQuickloginMigration(
    await jsonFile<LegacyQuickloginUser[]>(legacyPath),
    await jsonFile<QuickloginMapping>(mappingPath)
  );
  console.log(JSON.stringify({
    migrationId: preview.migrationId,
    previewHash: preview.previewHash,
    relevantUsers: preview.relevantUsers,
    missingMapping: preview.missingMapping,
    conflicts: preview.conflicts,
    changes: preview.initializations.map(({ userId, deviceLimit, masterEnabled }) => ({
      userId, deviceLimit, masterEnabled,
    })),
  }, null, 2));
  if (process.argv.includes("--apply")) {
    assertMigrationApplicable(preview, argument("--preview-hash") ?? "");
    throw new Error(
      "apply requires the controlled Auth internal runner; this local CLI never writes D1 or production directly"
    );
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
