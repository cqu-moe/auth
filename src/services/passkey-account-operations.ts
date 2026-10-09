import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, createAuthMiddleware, sessionMiddleware } from "better-auth/api";
import { generateRandomString, symmetricEncrypt } from "better-auth/crypto";
import { setSessionCookie } from "better-auth/cookies";
import { createOTP } from "@better-auth/utils/otp";
import { z } from "zod";
import { hasAuthenticationProof } from "./auth-strength";
import { clearDeviceTrust } from "./oauth-tokens";

// Better Auth's allowPasswordless only applies to accounts without a password.
// These four mutations accept a verified Passkey instead, keeping the native
// account/factor schema, crypto, verification and session-revocation hooks.
// Native password endpoints and their verification functions remain unchanged.
export function passkeyAccountOperations(): BetterAuthPlugin {
  const verified = (purpose: "password" | "mfa") => createAuthMiddleware(async ctx => {
    const session = ctx.context.session;
    if (!session || !await hasAuthenticationProof(ctx.context, session, purpose, "passkey")) {
      throw new APIError("FORBIDDEN", { code: "PASSKEY_AUTH_REQUIRED", message: "请先使用 Passkey 验证此次操作" });
    }
  });
  // Match the configured native encrypted ten-code format. The upstream
  // generator is not exported at runtime; native verification consumes these.
  const recoveryCodes = async (secret: Parameters<typeof symmetricEncrypt>[0]["key"]) => {
    const backupCodes = Array.from({ length: 10 }, () => {
      const raw = generateRandomString(10, "a-z", "0-9", "A-Z");
      return `${raw.slice(0, 5)}-${raw.slice(5)}`;
    });
    return { backupCodes, encrypted: await symmetricEncrypt({ key: secret, data: JSON.stringify(backupCodes) }) };
  };
  return {
    id: "passkey-account-operations",
    endpoints: {
      passkeyChangePassword: createAuthEndpoint("/security/passkey/change-password", {
        method: "POST", use: [sessionMiddleware, verified("password")], body: z.object({ newPassword: z.string() }),
      }, async ctx => {
        const { minPasswordLength, maxPasswordLength } = ctx.context.password.config;
        if (ctx.body.newPassword.length < minPasswordLength || ctx.body.newPassword.length > maxPasswordLength) throw new APIError("BAD_REQUEST", { message: "新密码长度不符合要求" });
        const account = await ctx.context.internalAdapter.findCredentialAccount(ctx.context.session.user.id);
        if (!account?.password) throw new APIError("BAD_REQUEST", { message: "账号尚未设置密码" });
        await ctx.context.internalAdapter.updateAccount(account.id, { password: await ctx.context.password.hash(ctx.body.newPassword) });
        // createAuth's shared after hook revokes other sessions and device trust,
        // preserving this session and private RPC background synchronization.
        return ctx.json({ status: true });
      }),
      passkeyEnableTwoFactor: createAuthEndpoint("/security/passkey/two-factor/enable", {
        method: "POST", use: [sessionMiddleware, verified("mfa")], body: z.object({}),
      }, async ctx => {
        const user = ctx.context.session.user;
        const existing = await ctx.context.adapter.findOne<{ id: string; verified: boolean }>({ model: "twoFactor", where: [{ field: "userId", value: user.id }] });
        if (existing && existing.verified !== false) throw new APIError("BAD_REQUEST", { message: "请先关闭当前身份验证器再重新设置" });
        const secret = generateRandomString(32);
        const codes = await recoveryCodes(ctx.context.secretConfig);
        const data = { secret: await symmetricEncrypt({ key: ctx.context.secretConfig, data: secret }), backupCodes: codes.encrypted, verified: false };
        if (existing) await ctx.context.adapter.update({ model: "twoFactor", where: [{ field: "id", value: existing.id }], update: data });
        else await ctx.context.adapter.create({ model: "twoFactor", data: { ...data, userId: user.id } });
        return ctx.json({ method: "totp" as const, totpURI: createOTP(secret, { digits: 6, period: 30 }).url("auth.cqu.moe", user.email), backupCodes: codes.backupCodes });
      }),
      passkeyDisableTwoFactor: createAuthEndpoint("/security/passkey/two-factor/disable", {
        method: "POST", use: [sessionMiddleware, verified("mfa")], body: z.object({}),
      }, async ctx => {
        const session = ctx.context.session;
        const user = await ctx.context.internalAdapter.updateUser(session.user.id, { twoFactorEnabled: false });
        await ctx.context.adapter.deleteMany({ model: "twoFactor", where: [{ field: "userId", value: user.id }] });
        await clearDeviceTrust(ctx.context.adapter, user.id);
        // The current session has just supplied UV proof; refresh its user data
        // without replacing it or transferring proof to a different session.
        await setSessionCookie(ctx, { session: session.session, user });
        return ctx.json({ status: true });
      }),
      passkeyGenerateBackupCodes: createAuthEndpoint("/security/passkey/two-factor/generate-backup-codes", {
        method: "POST", use: [sessionMiddleware, verified("mfa")], body: z.object({}),
      }, async ctx => {
        if (!ctx.context.session.user.twoFactorEnabled) throw new APIError("BAD_REQUEST", { message: "请先启用二次验证" });
        const factor = await ctx.context.adapter.findOne<{ id: string }>({ model: "twoFactor", where: [{ field: "userId", value: ctx.context.session.user.id }] });
        if (!factor) throw new APIError("BAD_REQUEST", { message: "未找到身份验证器" });
        const codes = await recoveryCodes(ctx.context.secretConfig);
        await ctx.context.adapter.update({ model: "twoFactor", where: [{ field: "id", value: factor.id }], update: { backupCodes: codes.encrypted } });
        return ctx.json({ status: true, backupCodes: codes.backupCodes });
      }),
    },
  };
}
