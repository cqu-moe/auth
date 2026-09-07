const INVITATION_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const INVITATION_CODE_LENGTH = 8;

import {
  applyDefaultEntitlements,
  applyPresetEntitlements,
  isInvitationRequired,
} from "./entitlements";

export type InvitationErrorCode =
  | "INVALID_INVITATION_CODE"
  | "INVITATION_REQUIRED"
  | "INVITATION_EXPIRED"
  | "INVITATION_REVOKED"
  | "INVITATION_USED"
  | "INVITATION_IN_USE"
  | "INVITATION_CLAIM_LOST"
  | "INVITATION_CODE_EXHAUSTED";

export class InvitationError extends Error {
  constructor(
    public readonly code: InvitationErrorCode,
    message: string,
    public readonly status = 400
  ) {
    super(message);
    this.name = "InvitationError";
  }
}

export interface InvitationClaim {
  code: string;
  email: string;
  token: string;
}

export type RegistrationInvitationStatus =
  | "active"
  | "in_use"
  | "expired"
  | "used"
  | "revoked";

export interface RegistrationInvitation {
  code: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  claimedAt: string | null;
  claimedByEmail: string | null;
  usedAt: string | null;
  usedByUserId: string | null;
  revokedAt: string | null;
  // 注册该邀请码时套用的权益预设名;null = 回落全局默认预设。
  preset: string | null;
  status: RegistrationInvitationStatus;
}

interface InvitationStateRow {
  code: string;
  expires_at: string;
  claim_token: string | null;
  used_at: string | null;
  revoked_at: string | null;
}

export function normalizeInvitationCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(code) ? code : null;
}

export function generateInvitationCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(INVITATION_CODE_LENGTH));
  let code = "";
  for (const byte of bytes) {
    code += INVITATION_ALPHABET[byte % INVITATION_ALPHABET.length];
  }
  return code;
}

interface InvitationAdminRow {
  code: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  claimed_at: string | null;
  claimed_by_email: string | null;
  used_at: string | null;
  used_by_user_id: string | null;
  revoked_at: string | null;
  preset: string | null;
}

function invitationStatus(
  row: InvitationAdminRow,
  nowIso: string
): RegistrationInvitationStatus {
  if (row.revoked_at) return "revoked";
  if (row.used_at) return "used";
  if (row.expires_at <= nowIso) return "expired";
  if (row.claimed_at) return "in_use";
  return "active";
}

function adminRowToInvitation(
  row: InvitationAdminRow,
  nowIso: string
): RegistrationInvitation {
  return {
    code: row.code,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    claimedAt: row.claimed_at,
    claimedByEmail: row.claimed_by_email,
    usedAt: row.used_at,
    usedByUserId: row.used_by_user_id,
    revokedAt: row.revoked_at,
    preset: row.preset,
    status: invitationStatus(row, nowIso),
  };
}

export async function createRegistrationInvitation(
  db: D1Database,
  createdBy: string,
  options: {
    preset?: string | null;
    now?: Date;
    codeFactory?: () => string;
  } = {}
): Promise<RegistrationInvitation> {
  const { preset = null, now = new Date(), codeFactory = generateInvitationCode } = options;
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = normalizeInvitationCode(codeFactory());
    if (!code) continue;
    const result = await db
      .prepare(
        `INSERT OR IGNORE INTO registration_invitation
           (code, created_by, created_at, expires_at, preset)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(code, createdBy, createdAt, expiresAt, preset)
      .run();
    if (result.meta.changes === 1) {
      return {
        code,
        createdBy,
        createdAt,
        expiresAt,
        claimedAt: null,
        claimedByEmail: null,
        usedAt: null,
        usedByUserId: null,
        revokedAt: null,
        preset,
        status: "active",
      };
    }
  }
  throw new InvitationError(
    "INVITATION_CODE_EXHAUSTED",
    "邀请码生成失败，请重试",
    500
  );
}

export async function listRegistrationInvitations(
  db: D1Database,
  now = new Date()
): Promise<RegistrationInvitation[]> {
  const result = await db
    .prepare(
      `SELECT code, created_by, created_at, expires_at,
              claimed_at, claimed_by_email, used_at, used_by_user_id, revoked_at, preset
       FROM registration_invitation
       ORDER BY created_at DESC
       LIMIT 100`
    )
    .all<InvitationAdminRow>();
  const nowIso = now.toISOString();
  return result.results.map((row) => adminRowToInvitation(row, nowIso));
}

export async function revokeRegistrationInvitation(
  db: D1Database,
  rawCode: unknown,
  now = new Date()
): Promise<void> {
  const code = normalizeInvitationCode(rawCode);
  if (!code) {
    throw new InvitationError("INVALID_INVITATION_CODE", "邀请码不存在", 404);
  }
  const result = await db
    .prepare(
      `UPDATE registration_invitation
       SET revoked_at = ?
       WHERE code = ?
         AND used_at IS NULL
         AND revoked_at IS NULL
         AND claim_token IS NULL`
    )
    .bind(now.toISOString(), code)
    .run();
  if (result.meta.changes === 1) return;

  const row = await db
    .prepare(
      `SELECT code, expires_at, claim_token, used_at, revoked_at
       FROM registration_invitation WHERE code = ?`
    )
    .bind(code)
    .first<InvitationStateRow>();
  if (row?.revoked_at) return;
  if (row?.used_at) {
    throw new InvitationError("INVITATION_USED", "已使用的邀请码不能撤销", 409);
  }
  if (row?.claim_token) {
    throw new InvitationError(
      "INVITATION_IN_USE",
      "邀请码正在用于注册，暂时不能撤销",
      409
    );
  }
  throw new InvitationError("INVALID_INVITATION_CODE", "邀请码不存在", 404);
}

function stateError(row: InvitationStateRow | null, nowIso: string): InvitationError {
  if (!row) {
    return new InvitationError("INVALID_INVITATION_CODE", "邀请码无效");
  }
  if (row.revoked_at) {
    return new InvitationError("INVITATION_REVOKED", "邀请码已撤销");
  }
  if (row.used_at) {
    return new InvitationError("INVITATION_USED", "邀请码已使用");
  }
  if (row.expires_at <= nowIso) {
    return new InvitationError("INVITATION_EXPIRED", "邀请码已过期");
  }
  if (row.claim_token) {
    return new InvitationError(
      "INVITATION_IN_USE",
      "邀请码正在被使用，请稍后重试",
      409
    );
  }
  return new InvitationError("INVALID_INVITATION_CODE", "邀请码暂时不可用");
}

export async function claimInvitation(
  db: D1Database,
  rawCode: unknown,
  email: string,
  now = new Date()
): Promise<InvitationClaim> {
  const code = normalizeInvitationCode(rawCode);
  if (!code) throw new InvitationError("INVALID_INVITATION_CODE", "邀请码无效");

  const token = crypto.randomUUID();
  const nowIso = now.toISOString();
  const claimed = await db
    .prepare(
      `UPDATE registration_invitation
       SET claim_token = ?, claimed_at = ?, claimed_by_email = ?
       WHERE code = ?
         AND revoked_at IS NULL
         AND used_at IS NULL
         AND expires_at > ?
         AND claim_token IS NULL
       RETURNING code`
    )
    .bind(token, nowIso, email, code, nowIso)
    .first<{ code: string }>();

  if (claimed) return { code, email, token };

  const row = await db
    .prepare(
      `SELECT code, expires_at, claim_token, used_at, revoked_at
       FROM registration_invitation WHERE code = ?`
    )
    .bind(code)
    .first<InvitationStateRow>();
  throw stateError(row, nowIso);
}

export async function releaseInvitation(
  db: D1Database,
  claim: InvitationClaim
): Promise<void> {
  await db
    .prepare(
      `UPDATE registration_invitation
       SET claim_token = NULL, claimed_at = NULL, claimed_by_email = NULL
       WHERE code = ? AND claim_token = ? AND used_at IS NULL`
    )
    .bind(claim.code, claim.token)
    .run();
}

export async function completeInvitation(
  db: D1Database,
  claim: InvitationClaim,
  userId: string,
  now = new Date()
): Promise<void> {
  const result = await db
    .prepare(
      `UPDATE registration_invitation
       SET used_at = ?, used_by_user_id = ?,
           claim_token = NULL, claimed_at = NULL, claimed_by_email = NULL
       WHERE code = ? AND claim_token = ? AND used_at IS NULL`
    )
    .bind(now.toISOString(), userId, claim.code, claim.token)
    .run();
  if (result.meta.changes !== 1) {
    throw new InvitationError(
      "INVITATION_CLAIM_LOST",
      "邀请码核销失败，请联系管理员",
      409
    );
  }
}

function invitationErrorResponse(error: InvitationError): Response {
  return Response.json(
    { code: error.code, message: error.message },
    { status: error.status }
  );
}

async function responseUserId(response: Response): Promise<string | null> {
  try {
    const body = (await response.clone().json()) as { user?: { id?: unknown } };
    return typeof body.user?.id === "string" ? body.user.id : null;
  } catch {
    return null;
  }
}

export async function handleInvitationSignup(
  request: Request,
  db: D1Database,
  register: (request: Request) => Promise<Response>,
  now = new Date()
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const contentType = request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      .trim()
      .toLowerCase();
    const parsed =
      contentType === "application/x-www-form-urlencoded"
        ? Object.fromEntries((await request.clone().formData()).entries())
        : await request.clone().json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid body");
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return invitationErrorResponse(
      new InvitationError("INVALID_INVITATION_CODE", "邀请码无效")
    );
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const codeProvided =
    typeof body.code === "string" && body.code.trim() !== "";

  // 剥掉 code 字段后转发给 Better Auth(它不认识这个字段)。
  const forward = () => {
    const { code: _code, ...authBody } = body;
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    headers.set("content-type", "application/json");
    const forwarded = new Request(request.url, {
      method: request.method,
      headers,
      body: JSON.stringify(authBody),
    });
    return register(forwarded);
  };

  // 注册成功后从响应/邮箱反查 userId(响应体拿不到时按 email 兜底)。
  const resolveUserId = async (response: Response): Promise<string | null> => {
    const fromBody = await responseUserId(response);
    if (fromBody || !email) return fromBody;
    const existing = await db
      .prepare(`SELECT id FROM user WHERE lower(email) = lower(?) LIMIT 1`)
      .bind(email)
      .first<{ id: string }>();
    return existing?.id ?? null;
  };

  // 权益写入失败只记日志,不让已成功的注册报错(缺省零行 = fail-closed)。
  const applyEntitlements = async (userId: string, preset: string | null) => {
    try {
      if (preset) await applyPresetEntitlements(db, userId, preset);
      else await applyDefaultEntitlements(db, userId);
    } catch (e) {
      console.error(
        `[signup] apply entitlements failed for userId=${userId}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  };

  // ── 无邀请码路径:仅当管理台关闭了「强制邀请码」才放行 ──
  if (!codeProvided) {
    if (await isInvitationRequired(db)) {
      return invitationErrorResponse(
        new InvitationError("INVITATION_REQUIRED", "注册需要邀请码")
      );
    }
    const response = await forward();
    if (response.ok) {
      const userId = await resolveUserId(response);
      // 无码注册按全局默认预设给权益(未配置 = 零权益)。
      if (userId) await applyEntitlements(userId, null);
    }
    return response;
  }

  // ── 邀请码路径:原子占用 → 注册 → 核销 → 写权益 ──
  let claim: InvitationClaim;
  try {
    claim = await claimInvitation(db, body.code, email, now);
  } catch (error) {
    if (error instanceof InvitationError) return invitationErrorResponse(error);
    throw error;
  }

  let response: Response;
  try {
    response = await forward();
  } catch (error) {
    await releaseInvitation(db, claim);
    throw error;
  }
  if (!response.ok) {
    await releaseInvitation(db, claim);
    return response;
  }

  const userId = await resolveUserId(response);
  if (!userId) {
    throw new InvitationError(
      "INVITATION_CLAIM_LOST",
      "注册成功但邀请码核销失败，请联系管理员",
      500
    );
  }

  await completeInvitation(db, claim, userId, now);
  // 邀请码自带预设优先(完全替代默认);未指定则回落全局默认预设。
  const invitation = await db
    .prepare(`SELECT preset FROM registration_invitation WHERE code = ?`)
    .bind(claim.code)
    .first<{ preset: string | null }>();
  await applyEntitlements(userId, invitation?.preset ?? null);
  return response;
}
