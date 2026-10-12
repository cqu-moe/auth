import { isBanned } from "./oauth-tokens";

export type FeedSubscriptionLimit =
  | { kind: "limited"; value: number }
  | { kind: "unlimited" }
  | { kind: "missing" };

export type FeedPolicy = {
  access: boolean;
  subscriptionLimit: FeedSubscriptionLimit;
};

export type FeedRecipient =
  | { status: "verified"; email: string }
  | { status: "unverified" }
  | { status: "blocked" };

export type FeedAuthRequest = {
  contractVersion: number;
  clientId: string;
  clientSecret: string;
  userId: string;
};

export type FeedAuthErrorCode =
  | "INVALID_REQUEST"
  | "UNSUPPORTED_VERSION"
  | "INVALID_CLIENT"
  | "CLIENT_NOT_ALLOWED"
  | "SUBJECT_UNAVAILABLE"
  | "AUTH_UNAVAILABLE"
  | "AUTH_DATA_INVALID";

export type FeedAuthResult<T> =
  | { ok: true; contractVersion: 1; checkedAt: number; data: T }
  | {
      ok: false;
      code: FeedAuthErrorCode;
      retryable: boolean;
      requestId: string;
    };

type EntitlementRow = { subsystem: string; capability: string; value: string };
type UserRow = {
  id: string;
  email: string;
  emailVerified: boolean | number | null;
  banned: boolean | number | null;
  banExpires: string | null;
};

export type FeedAuthError = {
  code: FeedAuthErrorCode;
  retryable: boolean;
};

export type FeedContext = {
  policy: FeedPolicy;
  user: UserRow;
  checkedAt: number;
};

export function feedAuthError<T>(
  code: FeedAuthErrorCode,
  requestId: string,
  retryable = false
): FeedAuthResult<T> {
  return { ok: false, code, retryable, requestId };
}

export function parseFeedRequest(value: unknown): FeedAuthRequest | FeedAuthError {
  if (!value || typeof value !== "object") {
    return { code: "INVALID_REQUEST", retryable: false };
  }
  const request = value as Partial<Record<keyof FeedAuthRequest, unknown>>;
  if (
    typeof request.clientId !== "string" ||
    !request.clientId ||
    typeof request.clientSecret !== "string" ||
    !request.clientSecret ||
    typeof request.userId !== "string" ||
    !request.userId
  ) {
    return { code: "INVALID_REQUEST", retryable: false };
  }
  if (request.contractVersion !== 1) {
    return { code: "UNSUPPORTED_VERSION", retryable: false };
  }
  return {
    contractVersion: 1,
    clientId: request.clientId,
    clientSecret: request.clientSecret,
    userId: request.userId,
  };
}

function parseSubscriptionLimit(row: EntitlementRow | undefined): FeedSubscriptionLimit | FeedAuthError {
  if (!row) return { kind: "missing" };
  if (row.value === "") return { kind: "unlimited" };
  if (/^\d+$/.test(row.value) && Number.isSafeInteger(Number(row.value))) {
    return { kind: "limited", value: Number(row.value) };
  }
  return { code: "AUTH_DATA_INVALID", retryable: false };
}

export async function resolveFeedContext(
  db: D1Database,
  userId: string
): Promise<FeedContext | FeedAuthError> {
  const checkedAt = Date.now();
  let results: D1Result<unknown>[];
  try {
    results = await db.batch([
      db.prepare(
        "SELECT id, email, emailVerified, banned, banExpires FROM user WHERE id = ?"
      ).bind(userId),
      db.prepare(
        "SELECT subsystem, capability, value FROM user_entitlement WHERE user_id = ? AND subsystem = 'feed'"
      ).bind(userId),
    ]);
  } catch {
    return { code: "AUTH_UNAVAILABLE", retryable: true };
  }

  const user = results[0]?.results[0] as UserRow | undefined;
  if (
    !user ||
    isBanned({
      banned: user.banned === true || user.banned === 1,
      banExpires: user.banExpires,
    })
  ) {
    return { code: "SUBJECT_UNAVAILABLE", retryable: false };
  }
  if (user.id !== userId) {
    return { code: "AUTH_DATA_INVALID", retryable: false };
  }

  const rows = results[1]?.results as EntitlementRow[] | undefined;
  const access = rows?.some((row) => row.capability === "access" && row.value === "1") === true;
  const limit = parseSubscriptionLimit(
    rows?.find((row) => row.capability === "sub_limit")
  );
  if ("code" in limit) return limit;
  return { policy: { access, subscriptionLimit: limit }, user, checkedAt };
}

export function feedRecipientDataError(user: UserRow): FeedAuthError | null {
  if (
    typeof user.email !== "string" ||
    !user.email ||
    !(user.emailVerified === true || user.emailVerified === false ||
      user.emailVerified === 0 || user.emailVerified === 1)
  ) {
    return { code: "AUTH_DATA_INVALID", retryable: false };
  }
  return null;
}
