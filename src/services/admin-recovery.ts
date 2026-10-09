import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { generateRandomString } from "better-auth/crypto";
import { z } from "zod";
import { authResetRevision } from "./auth-reset-revision";
import { hasAuthenticationProof } from "./auth-strength";

export function administratorRecovery(db: D1Database, request: Request): BetterAuthPlugin {
  return {
    id: "administrator-recovery",
    endpoints: {
      resetAuthentication: createAuthEndpoint("/admin/reset-authentication", {
        method: "POST", use: [sessionMiddleware], body: z.object({ userId: z.string().min(1) }),
      }, async ctx => {
        const actor = ctx.context.session;
        // Match the existing user:set-password permission: ordinary admins may
        // list and ban accounts, but only superAdmin may replace credentials.
        const user = await ctx.context.internalAdapter.findUserById(actor.user.id);
        if (!(user as { role?: string } | null)?.role?.split(",").includes("superAdmin") ||
          !await hasAuthenticationProof(ctx.context, actor, "strong") ||
          !await hasAuthenticationProof(ctx.context, actor, "admin")) {
          throw new APIError("FORBIDDEN", { message: "需要管理员权限及近期强认证" });
        }
        const target = await ctx.context.internalAdapter.findUserById(ctx.body.userId);
        if (!target) throw new APIError("NOT_FOUND", { message: "用户不存在" });
        const expected = await authResetRevision(db, request);
        const password = generateRandomString(32, "a-z", "A-Z", "0-9");
        const hash = await ctx.context.password.hash(password);
        const now = new Date().toISOString();
        const proof = (purpose: string) => `security-proof:${actor.session.id}:${purpose}`;
        const statements = [
          db.prepare(`UPDATE auth_reset_revision SET revision = CASE WHEN revision = ?
            AND EXISTS (SELECT 1 FROM session s JOIN user u ON u.id = s.userId
              WHERE s.id = ? AND s.userId = ? AND julianday(s.expiresAt) > julianday('now')
              AND instr(',' || u.role || ',', ',superAdmin,') > 0
              AND (coalesce(u.banned, 0) = 0 OR julianday(u.banExpires) <= julianday('now')))
            AND EXISTS (SELECT 1 FROM user WHERE id = ?)
            AND (SELECT count(DISTINCT identifier) FROM verification WHERE identifier IN (?, ?)
              AND julianday(expiresAt) > julianday('now')
              AND (value = ? OR CASE WHEN json_valid(value) THEN json_extract(value, '$.userId') END = ?)) = 2
            THEN revision + 1 ELSE NULL END WHERE id = 1`).bind(expected, actor.session.id, actor.user.id, target.id, proof("admin"), proof("strong"), actor.user.id, actor.user.id),
          db.prepare("DELETE FROM verification WHERE identifier IN (SELECT '2fa-attempts-' || identifier FROM verification WHERE value = ? AND identifier LIKE '2fa-%')").bind(target.id),
          db.prepare(`DELETE FROM verification WHERE authUserId = ? OR value = ?
            OR CASE WHEN json_valid(value) THEN json_extract(value, '$.userId') END = ?
            OR CASE WHEN json_valid(value) THEN json_extract(value, '$.userData.id') END = ?
            OR CASE WHEN json_valid(value) THEN json_extract(value, '$.sessionId') END IN (SELECT id FROM session WHERE userId = ?)
            OR identifier IN (?, ?, ?)
            OR identifier IN (SELECT 'security-proof:' || id || ':' || p.purpose FROM session CROSS JOIN
              (SELECT 'strong' purpose UNION ALL SELECT 'admin' UNION ALL SELECT 'password' UNION ALL SELECT 'email' UNION ALL SELECT 'mfa') p WHERE userId = ?)`)
            .bind(target.id, target.id, target.id, target.id, target.id, `email-verification-otp-${target.email}`, `forget-password-otp-${target.email}`, `sign-in-otp-${target.email}`, target.id),
          db.prepare("DELETE FROM oauthAccessToken WHERE userId = ? OR refreshId IN (SELECT id FROM oauthRefreshToken WHERE userId = ?)").bind(target.id, target.id),
          db.prepare("DELETE FROM oauthRefreshToken WHERE userId = ?").bind(target.id),
          db.prepare("DELETE FROM session WHERE userId = ?").bind(target.id),
          db.prepare("DELETE FROM passkey WHERE userId = ?").bind(target.id),
          db.prepare("DELETE FROM twoFactor WHERE userId = ?").bind(target.id),
          db.prepare("UPDATE user SET twoFactorEnabled = 0, updatedAt = ? WHERE id = ?").bind(now, target.id),
          db.prepare("UPDATE account SET password = ?, accessToken = NULL, refreshToken = NULL, idToken = NULL, updatedAt = ? WHERE userId = ? AND providerId = 'credential'").bind(hash, now, target.id),
          db.prepare("INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) SELECT ?, ?, 'credential', ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM account WHERE userId = ? AND providerId = 'credential')").bind(crypto.randomUUID(), target.id, target.id, hash, now, now, target.id),
          db.prepare("INSERT INTO auth_recovery_audit (id, actorId, targetId, outcome, createdAt) VALUES (?, ?, ?, 'success', ?)").bind(crypto.randomUUID(), actor.user.id, target.id, now),
        ];
        try { await db.batch(statements); }
        catch { throw new APIError("CONFLICT", { code: "RECOVERY_NOT_APPLIED", message: "重置未生效，请重新验证后重试" }); }
        ctx.setHeader("Cache-Control", "no-store");
        return ctx.json({ status: true, password });
      }),
    },
  };
}
