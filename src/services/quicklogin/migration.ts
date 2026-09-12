export interface QuickloginMapping {
  schemaVersion: 1;
  migrationId: string;
  users: Array<{ userId: string; deviceLimit: number }>;
}

export interface LegacyQuickloginUser {
  userId: string;
  oldAccess: boolean;
  oldMaster: boolean;
}

export interface MigrationPreview {
  migrationId: string;
  previewHash: string;
  relevantUsers: number;
  missingMapping: string[];
  conflicts: string[];
  initializations: Array<{
    userId: string;
    deviceLimit: number;
    masterEnabled: boolean;
  }>;
}

export class QuickloginMigrationError extends Error {
  constructor(public readonly code: "INVALID_MAPPING" | "MISSING_MAPPING") {
    super(code);
  }
}

function validateMapping(mapping: QuickloginMapping): void {
  if (mapping.schemaVersion !== 1 || !mapping.migrationId || !Array.isArray(mapping.users)) {
    throw new QuickloginMigrationError("INVALID_MAPPING");
  }
  const seen = new Set<string>();
  for (const entry of mapping.users) {
    if (!entry.userId || seen.has(entry.userId) ||
        !Number.isSafeInteger(entry.deviceLimit) || entry.deviceLimit < 0) {
      throw new QuickloginMigrationError("INVALID_MAPPING");
    }
    seen.add(entry.userId);
  }
}

async function sha256(value: string): Promise<string> {
  const result = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(result)]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function previewQuickloginMigration(
  legacyUsers: LegacyQuickloginUser[],
  mapping: QuickloginMapping
): Promise<MigrationPreview> {
  validateMapping(mapping);
  const relevant = legacyUsers
    .filter((user) => user.oldAccess || user.oldMaster)
    .slice()
    .sort((left, right) => left.userId.localeCompare(right.userId));
  const byUser = new Map(mapping.users.map((entry) => [entry.userId, entry.deviceLimit]));
  const relevantIds = new Set(relevant.map((user) => user.userId));
  const missingMapping = relevant
    .filter((user) => !byUser.has(user.userId))
    .map((user) => user.userId);
  const conflicts = mapping.users
    .filter((entry) => !relevantIds.has(entry.userId))
    .map((entry) => entry.userId)
    .sort();
  const initializations = relevant.flatMap((user) => {
    const deviceLimit = byUser.get(user.userId);
    return deviceLimit === undefined ? [] : [{
      userId: user.userId,
      deviceLimit,
      masterEnabled: user.oldMaster,
    }];
  });
  const canonical = JSON.stringify({
    schemaVersion: mapping.schemaVersion,
    migrationId: mapping.migrationId,
    source: relevant,
    mapping: mapping.users.slice().sort((a, b) => a.userId.localeCompare(b.userId)),
  });
  return {
    migrationId: mapping.migrationId,
    previewHash: await sha256(canonical),
    relevantUsers: relevant.length,
    missingMapping,
    conflicts,
    initializations,
  };
}

export function assertMigrationApplicable(preview: MigrationPreview, previewHash: string): void {
  if (preview.missingMapping.length > 0) {
    throw new QuickloginMigrationError("MISSING_MAPPING");
  }
  if (!previewHash || preview.previewHash !== previewHash) {
    throw new QuickloginMigrationError("INVALID_MAPPING");
  }
}
