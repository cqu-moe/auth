import type { Env } from "../../types";
import {
  QuickloginAccountClient,
  QuickloginAccountClientError,
} from "./account-client";
import { DEVICE_SCOPE, type ErrorCode } from "./contracts";
import { createHash } from "@better-auth/utils/hash";
import { base64Url } from "@better-auth/utils/base64";

export const QUICKLOGIN_OFFICIAL_METADATA_KEY = "quickloginOfficial";

export class QuickloginOAuthError extends Error {
  constructor(public readonly code: ErrorCode) {
    super(code);
    this.name = "QuickloginOAuthError";
  }
}

interface ConsentContext {
  user?: { id: string } | null;
  scopes: string[];
}

interface AccessTokenContext extends ConsentContext {
  referenceId?: string;
  metadata?: Record<string, unknown>;
}

export function createQuickloginConsentReference(env: Env) {
  let pending: { userId: string; grantId: string } | null = null;

  return async ({ user, scopes }: ConsentContext): Promise<string | undefined> => {
    if (!scopes.includes(DEVICE_SCOPE)) return undefined;
    if (!user?.id || !env.QUICKLOGIN_CLIENT_ID) {
      throw new QuickloginOAuthError("FORBIDDEN");
    }
    if (pending) {
      if (pending.userId !== user.id) {
        throw new QuickloginOAuthError("FORBIDDEN");
      }
      return pending.grantId;
    }

    const grant = await new QuickloginAccountClient(env).createPendingGrant(
      user.id,
      env.QUICKLOGIN_CLIENT_ID,
      Date.now()
    );
    pending = { userId: user.id, grantId: grant.grantId };
    return pending.grantId;
  };
}

export async function quickloginAccessTokenClaims(
  env: Env,
  info: AccessTokenContext
): Promise<{ ql_grant?: string }> {
  if (!info.scopes.includes(DEVICE_SCOPE)) return {};
  if (
    !info.user?.id ||
    !info.referenceId ||
    info.metadata?.[QUICKLOGIN_OFFICIAL_METADATA_KEY] !== true ||
    !env.QUICKLOGIN_CLIENT_ID
  ) {
    throw new QuickloginOAuthError("FORBIDDEN");
  }

  try {
    const grant = await new QuickloginAccountClient(env).activateGrant(
      info.user.id,
      info.referenceId,
      Date.now()
    );
    if (
      grant.ownerUserId !== info.user.id ||
      grant.clientId !== env.QUICKLOGIN_CLIENT_ID
    ) {
      throw new QuickloginOAuthError("FORBIDDEN");
    }
    return { ql_grant: grant.grantId };
  } catch (error) {
    if (error instanceof QuickloginOAuthError) throw error;
    if (error instanceof QuickloginAccountClientError) {
      throw new QuickloginOAuthError(error.code);
    }
    throw error;
  }
}

interface OAuthTokenRow {
  id: string;
}

interface RefreshTokenRow extends OAuthTokenRow {
  clientId: string;
  userId: string;
  referenceId?: string | null;
  revoked?: Date | null;
  rotatedAt?: Date | null;
  rotationReplayExpiresAt?: Date | null;
  expiresAt: Date;
}

interface RefreshTokenAdapter {
  findOne<T>(input: {
    model: string;
    where: Array<{ field: string; value: unknown }>;
  }): Promise<T | null>;
}

async function hashStoredToken(token: string): Promise<string> {
  const digest = await createHash("SHA-256").digest(
    new TextEncoder().encode(token)
  );
  return base64Url.encode(new Uint8Array(digest), { padding: false });
}

export async function assertQuickloginRefreshAllowed(
  env: Env,
  adapter: RefreshTokenAdapter,
  input: {
    grantType?: unknown;
    clientId?: unknown;
    refreshToken?: unknown;
  }
): Promise<void> {
  if (
    input.grantType !== "refresh_token" ||
    input.clientId !== env.QUICKLOGIN_CLIENT_ID ||
    typeof input.refreshToken !== "string" ||
    input.refreshToken.length === 0
  ) {
    return;
  }

  const row = await adapter.findOne<RefreshTokenRow>({
    model: "oauthRefreshToken",
    where: [
      { field: "token", value: await hashStoredToken(input.refreshToken) },
    ],
  });
  if (
    !row ||
    row.clientId !== env.QUICKLOGIN_CLIENT_ID
  ) {
    return;
  }
  if (row.revoked) {
    const replayable = row.rotatedAt && row.revoked.getTime() === row.rotatedAt.getTime() &&
      row.rotationReplayExpiresAt && row.rotationReplayExpiresAt.getTime() >= Date.now();
    if (!replayable || !row.referenceId) throw new QuickloginOAuthError("FORBIDDEN");
    // A cached rotation response must not revive a revoked OAuth family.
    const live = await adapter.findOne<RefreshTokenRow>({
      model: "oauthRefreshToken",
      where: [
        { field: "userId", value: row.userId },
        { field: "clientId", value: row.clientId },
        { field: "referenceId", value: row.referenceId },
        { field: "revoked", value: null },
      ],
    });
    if (!live || live.expiresAt.getTime() <= Date.now()) throw new QuickloginOAuthError("FORBIDDEN");
  }
  if (!row.referenceId) return;

  try {
    await new QuickloginAccountClient(env).assertGrant(
      row.userId,
      row.referenceId,
      row.clientId
    );
  } catch (error) {
    if (error instanceof QuickloginAccountClientError) {
      throw new QuickloginOAuthError(error.code);
    }
    throw error;
  }
}

export async function revokeProviderGrantFamily(
  env: Env,
  userId: string,
  clientId: string,
  grantId: string
): Promise<void> {
  if (
    !userId ||
    !clientId ||
    !grantId ||
    clientId !== env.QUICKLOGIN_CLIENT_ID
  ) {
    throw new QuickloginOAuthError("FORBIDDEN");
  }

  const { createAuth } = await import("../../auth");
  const auth = createAuth(
    env,
    new Request(`${env.BETTER_AUTH_URL}/api/v1/auth/oauth2/token`)
  );
  const ctx = await auth.$context;
  const where = [
    { field: "userId", value: userId },
    { field: "clientId", value: clientId },
    { field: "referenceId", value: grantId },
  ];

  await ctx.adapter.deleteMany({
    model: "oauthAccessToken",
    where,
  });

  for (;;) {
    const rows = await ctx.adapter.findMany<OAuthTokenRow>({
      model: "oauthRefreshToken",
      where: [...where, { field: "revoked", operator: "eq", value: null }],
      limit: 100,
    });
    if (rows.length === 0) break;
    const revokedAt = new Date();
    for (const row of rows) {
      await ctx.adapter.update({
        model: "oauthRefreshToken",
        where: [
          { field: "id", value: row.id },
          { field: "revoked", operator: "eq", value: null },
        ],
        update: { revoked: revokedAt },
      });
    }
  }

  await ctx.adapter.deleteMany({
    model: "oauthAccessToken",
    where,
  });
}
