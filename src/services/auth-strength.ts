import type { AuthContext, BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, getSessionFromCtx, sessionMiddleware } from "better-auth/api";
import { z } from "zod";

export const purposes = ["password", "email", "mfa", "admin"] as const;
export type SecurityPurpose = typeof purposes[number];
type SecuritySession = { user: { id: string; twoFactorEnabled?: boolean | null }; session: { id: string; expiresAt: Date } };
const prefix = (sessionId: string, purpose: string) => `security-proof:${sessionId}:${purpose}`;

export async function hasAuthenticationProof(context: Pick<AuthContext, "internalAdapter">, session: SecuritySession, purpose: string): Promise<boolean> {
  const row = await context.internalAdapter.findVerificationValue(prefix(session.session.id, purpose));
  return !!row && row.value === session.user.id && row.expiresAt.getTime() > Date.now();
}

export async function recordAuthenticationProof(context: Pick<AuthContext, "internalAdapter">, session: SecuritySession, purpose: SecurityPurpose, strong: boolean): Promise<void> {
  const entries: Array<{ purpose: string; expiresAt: Date }> = [{ purpose, expiresAt: new Date(Date.now() + 300_000) }];
  if (strong) entries.push({ purpose: "strong", expiresAt: session.session.expiresAt });
  // Admin admission is session-long; an explicit admin step-up additionally
  // needs its distinct five-minute proof for sensitive admin operations.
  for (const entry of entries) {
    const identifier = prefix(session.session.id, entry.purpose);
    await context.internalAdapter.deleteVerificationByIdentifier(identifier);
    await context.internalAdapter.createVerificationValue({ identifier, value: session.user.id, expiresAt: entry.expiresAt });
  }
}

export function sensitivePurpose(path: string): SecurityPurpose | null {
  if (path === "/admin/set-user-password") return "admin";
  if (path === "/change-password" || path === "/set-password") return "password";
  if (["/change-email", "/email-otp/request-email-change", "/email-otp/change-email"].includes(path)) return "email";
  if (["/passkey/generate-register-options", "/passkey/verify-registration", "/passkey/delete-passkey", "/passkey/update-passkey", "/two-factor/enable", "/two-factor/disable", "/two-factor/get-totp-uri", "/two-factor/generate-backup-codes"].includes(path)) return "mfa";
  return null;
}

export async function enforceAuthenticationStrength(ctx: Parameters<typeof getSessionFromCtx>[0]): Promise<void> {
  let purpose = sensitivePurpose(ctx.path);
  if (ctx.path === "/two-factor/verify-totp") {
    const session = await getSessionFromCtx(ctx);
    if (session) {
      const factor = await ctx.context.adapter.findOne<{ verified?: boolean }>({ model: "twoFactor", where: [{ field: "userId", value: session.user.id }] });
      if (factor?.verified === false) purpose = "mfa";
    }
  }
  const administrative = ctx.path.startsWith("/admin/");
  if (!purpose && !administrative) return;
  const session = await getSessionFromCtx(ctx);
  if (!session) return; // Native endpoint retains its normal unauthenticated error.
  if (administrative && !await hasAuthenticationProof(ctx.context, session, "strong")) {
    throw new APIError("FORBIDDEN", { code: "STRONG_AUTH_REQUIRED", message: "管理功能需要强认证" });
  }
  if (purpose && !await hasAuthenticationProof(ctx.context, session, purpose)) {
    throw new APIError("FORBIDDEN", { code: "RECENT_AUTH_REQUIRED", message: "请重新验证身份后继续" });
  }
}

export function authenticationStrength(verifyFactor: (headers: Headers, method: "totp" | "backup-code", code: string) => Promise<void>): BetterAuthPlugin {
  return {
    id: "authentication-strength",
    endpoints: {
      securityChallenge: createAuthEndpoint("/security/challenge", {
        method: "POST", use: [sessionMiddleware],
        body: z.object({ password: z.string(), purpose: z.enum(purposes) }),
      }, async (ctx) => {
        const session = ctx.context.session as SecuritySession;
        await ctx.context.password.checkPassword(session.user.id, ctx);
        if (!session.user.twoFactorEnabled) {
          if (ctx.body.purpose === "admin") throw new APIError("FORBIDDEN", { code: "MFA_SETUP_REQUIRED", message: "请先在安全设置中启用二次验证" });
          await recordAuthenticationProof(ctx.context, session, ctx.body.purpose, false);
          return ctx.json({ verified: true });
        }
        const challenge = crypto.randomUUID();
        await ctx.context.internalAdapter.createVerificationValue({
          identifier: `security-challenge:${challenge}`,
          value: JSON.stringify({ userId: session.user.id, sessionId: session.session.id, purpose: ctx.body.purpose }),
          expiresAt: new Date(Date.now() + 300_000),
        });
        return ctx.json({ verified: false, challenge });
      }),
      securityComplete: createAuthEndpoint("/security/complete", {
        method: "POST", use: [sessionMiddleware],
        body: z.object({ challenge: z.string(), method: z.enum(["totp", "backup-code"]), code: z.string() }),
      }, async (ctx) => {
        const session = ctx.context.session as SecuritySession;
        const row = await ctx.context.internalAdapter.consumeVerificationValue(`security-challenge:${ctx.body.challenge}`);
        if (!row || row.expiresAt.getTime() <= Date.now()) throw new APIError("UNAUTHORIZED", { message: "验证已过期，请重新输入密码" });
        const challenge = JSON.parse(row.value) as { userId: string; sessionId: string; purpose: SecurityPurpose };
        if (challenge.userId !== session.user.id || challenge.sessionId !== session.session.id || !session.user.twoFactorEnabled) throw new APIError("UNAUTHORIZED", { message: "验证会话不匹配" });
        await verifyFactor(new Headers(ctx.headers), ctx.body.method, ctx.body.code);
        await recordAuthenticationProof(ctx.context, session, challenge.purpose, true);
        return ctx.json({ verified: true });
      }),
      securityStatus: createAuthEndpoint("/security/status", { method: "GET", use: [sessionMiddleware], query: z.object({ purpose: z.enum(purposes).optional() }) }, async (ctx) => {
        return ctx.json({ strong: await hasAuthenticationProof(ctx.context, ctx.context.session, "strong"), verified: !!ctx.query.purpose && await hasAuthenticationProof(ctx.context, ctx.context.session, ctx.query.purpose) });
      }),
    },
    rateLimit: [{ pathMatcher: (path) => path.startsWith("/security/"), window: 60, max: 10 }],
  };
}
