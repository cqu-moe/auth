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
  operator?: "eq" | "starts_with";
}

interface RefreshTokenRow extends OAuthTokenRow {
  userId: string;
  clientId: string;
  rotationReplayExpiresAt?: Date | null;
  sessionId?: string | null;
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
  refreshToken: unknown,
  rotationReplayClientId?: string
): Promise<void> {
  if (typeof refreshToken !== "string" || refreshToken.length === 0) return;
  const row = await adapter.findOne<RefreshTokenRow>({
    model: "oauthRefreshToken",
    where: [
      { field: "token", value: await hashStoredToken(refreshToken) },
    ],
  });
  if (!row?.userId) return;
  // The provider setting is global; only QuickLogin opts into response replay.
  if (row.revoked && row.rotationReplayExpiresAt &&
      row.rotationReplayExpiresAt.getTime() >= Date.now() &&
      (!rotationReplayClientId || row.clientId !== rotationReplayClientId)) {
    // Let native client validation and reuse detection retain their revocation semantics.
    await adapter.update({
      model: "oauthRefreshToken",
      where: [{ field: "id", value: row.id }],
      update: { rotationReplayExpiresAt: null, rotationReplayResponse: null },
    });
  }
  const user = await adapter.findOne<{
    banned?: boolean | null;
    banExpires?: Date | string | null;
  }>({
    model: "user",
    where: [{ field: "id", value: row.userId }],
  });
  const session = row.sessionId ? await adapter.findOne<{ userId: string; expiresAt: Date }>({
    model: "session", where: [{ field: "id", value: row.sessionId }],
  }) : null;
  if (user && !isBanned(user) && session?.userId === row.userId && new Date(session.expiresAt).getTime() > Date.now()) return;
  throw new APIError("BAD_REQUEST", {
    code: "INVALID_GRANT",
    message: "invalid refresh token",
  });
}

export async function revokeSessionOAuthTokens(adapter: OAuthTokenAdapter, sessionId: string) {
  for (;;) {
    const rows = await adapter.findMany<{ id: string }>({ model: "oauthRefreshToken", where: [
      { field: "sessionId", value: sessionId }, { field: "revoked", value: null },
    ], limit: 100 });
    if (!rows.length) return;
    for (const row of rows) await adapter.update({ model: "oauthRefreshToken", where: [{ field: "id", value: row.id }], update: { revoked: new Date() } });
  }
}

export async function clearDeviceTrust(adapter: OAuthTokenAdapter, userId: string) {
  for (const prefix of ["trust-device-", "2fa-"]) await adapter.deleteMany({ model: "verification", where: [
    { field: "value", value: userId }, { field: "identifier", operator: "starts_with", value: prefix },
  ] });
}
