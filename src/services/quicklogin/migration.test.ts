import { describe, expect, it } from "vitest";
import {
  assertMigrationApplicable,
  previewQuickloginMigration,
  type QuickloginMapping,
} from "./migration";

const mapping = (users: QuickloginMapping["users"]): QuickloginMapping => ({
  schemaVersion: 1,
  migrationId: "quicklogin-devices-2026-09-09",
  users,
});

describe("quicklogin migration preview", () => {
  it("reports missing mappings instead of choosing a default", async () => {
    const preview = await previewQuickloginMigration([
      { userId: "u1", oldAccess: true, oldMaster: true },
    ], mapping([]));
    expect(preview.missingMapping).toEqual(["u1"]);
    expect(() => assertMigrationApplicable(preview, preview.previewHash))
      .toThrowError("MISSING_MAPPING");
  });

  it("accepts explicit zero and preserves the old master intent", async () => {
    const preview = await previewQuickloginMigration([
      { userId: "u1", oldAccess: true, oldMaster: true },
      { userId: "u2", oldAccess: true, oldMaster: false },
    ], mapping([
      { userId: "u1", deviceLimit: 0 },
      { userId: "u2", deviceLimit: 3 },
    ]));
    expect(preview.initializations).toEqual([
      { userId: "u1", deviceLimit: 0, masterEnabled: true },
      { userId: "u2", deviceLimit: 3, masterEnabled: false },
    ]);
    expect(() => assertMigrationApplicable(preview, preview.previewHash)).not.toThrow();
  });
});
