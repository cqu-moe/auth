import { APIError } from "better-auth/api";
import { base64Url } from "@better-auth/utils/base64";
import { createHash } from "@better-auth/utils/hash";

interface OAuthTokenRow {
  id: string;
}

type WhereValue = string | number | boolean | string[] | Date | number[] | null;
interface WhereField {
  field: string;
  value: WhereValue;
  operator?: "eq";
}

interface RefreshTokenRow extends OAuthTokenRow {
  userId: string;
  revoked?: Date | null;
}

// Shared ban semantics: mirrors the admin plugin, where an expired ban is
// lazily lifted at session create and no longer counts as banned.
export function isBanned(user: {
  banned?: boolean | null;
  banExpires?: Date | string | null;
}): boolean {
  if (!user.banned) return false;
  return !user.banExpires || new Date(user.banExpires).getTime() > Date.now();
}

export interface OAuthTokenAdapter {
  findOne<T>(input: {
    model: string;
    where: WhereField[];
  }): Promise<T | null>;
  findMany<T>(input: {
    model: string;
    where: WhereField[];
    limit?: number;
  }): Promise<T[]>;
  update(input: {
    model: string;
    where: WhereField[];
    update: Record<string, unknown>;
  }): Promise<unknown>;
  deleteMany(input: {
    model: string;
    where: WhereField[];
  }): Promise<unknown>;
}

async function hashStoredToken(token: string): Promise<string> {
  const digest = await createHash("SHA-256").digest(
    new TextEncoder().encode(token)
  );
  return base64Url.encode(new Uint8Array(digest), { padding: false });
}

// Ban cascade: better-auth banUser only deletes session rows, while OAuth
// access/refresh tokens survive and keep minting Bearer tokens via the
// refresh grant. Mirror the client-deletion cascade at user level.
export async function revokeUserOAuthTokens(
  adapter: OAuthTokenAdapter,
  userId: string
): Promise<void> {
  const where = [{ field: "userId", value: userId }];
  await adapter.deleteMany({ model: "oauthAccessToken", where });
  for (;;) {
    const rows = await adapter.findMany<OAuthTokenRow>({
      model: "oauthRefreshToken",
      where: [...where, { field: "revoked", operator: "eq", value: null }],
      limit: 100,
    });
    if (rows.length === 0) break;
    const revokedAt = new Date();
    for (const row of rows) {
      await adapter.update({
        model: "oauthRefreshToken",
        where: [
          { field: "id", value: row.id },
          { field: "revoked", operator: "eq", value: null },
        ],
        update: { revoked: revokedAt },
      });
    }
  }
}

// Fail-closed gate for every refresh_token grant: a banned user must not be
// able to rotate surviving tokens (e.g. rows issued before the cascade
// existed). Mirrors the admin plugin: an expired ban counts as not banned.
export async function assertRefreshTokenUserNotBanned(
  adapter: OAuthTokenAdapter,
  refreshToken: unknown
): Promise<void> {
  if (typeof refreshToken !== "string" || refreshToken.length === 0) return;
  const row = await adapter.findOne<RefreshTokenRow>({
    model: "oauthRefreshToken",
    where: [
      { field: "token", value: await hashStoredToken(refreshToken) },
    ],
  });
  if (!row?.userId) return;
  const user = await adapter.findOne<{
    banned?: boolean | null;
    banExpires?: Date | string | null;
  }>({
    model: "user",
    where: [{ field: "id", value: row.userId }],
  });
  if (!user || !isBanned(user)) return;
  throw new APIError("BAD_REQUEST", {
    code: "INVALID_GRANT",
    message: "invalid refresh token",
  });
}
