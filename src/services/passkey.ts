import type { BetterAuthPlugin } from "better-auth";
import { generateAuthenticationOptions, verifyAuthenticationResponse, type AuthenticationResponseJSON } from "@simplewebauthn/server";
import { base64 } from "@better-auth/utils/base64";
import { z } from "zod";
import { purposes, recordAuthenticationProof, type SecurityPurpose } from "./auth-strength";
type StoredPasskey = { id: string; credentialID: string; publicKey: string; counter: number; userId: string };
import { passkey } from "@better-auth/passkey";
import { APIError, createAuthEndpoint, sessionMiddleware, getSessionFromCtx } from "better-auth/api";

// Registration uses the application's purpose-bound recent proof, rather than
// native session age. Anonymous registration remains explicitly disabled.
export function verifiedPasskey(baseURL: string) {
  const site = new URL(baseURL);
  return passkey({
    rpID: site.hostname,
    rpName: "CQU 统一认证",
    origin: site.origin,
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    registration: {
      requireSession: false,
      resolveUser: async () => { throw new APIError("UNAUTHORIZED", { message: "请先登录" }); },
      afterVerification: async ({ ctx, verification, user, context }) => {
        const session = await getSessionFromCtx(ctx);
        if (!session || session.user.id !== user.id || session.session.id !== context || !verification.registrationInfo?.userVerified) {
          throw new APIError("FORBIDDEN", { message: "Passkey 必须验证本人身份，并绑定当前登录会话" });
        }
      },
    },
    authentication: {
      afterVerification: async ({ verification }) => {
        if (!verification.authenticationInfo.userVerified) throw new APIError("FORBIDDEN", { message: "Passkey 未完成用户验证" });
      },
    },
  });
}

export async function enforcePasskeyRegistration(ctx: Parameters<typeof getSessionFromCtx>[0]) {
  if (!["/passkey/generate-register-options", "/passkey/verify-registration"].includes(ctx.path)) return;
  const session = await getSessionFromCtx(ctx);
  if (!session) throw new APIError("UNAUTHORIZED", { message: "请先登录" });
  if (ctx.path === "/passkey/generate-register-options") ctx.query = { ...ctx.query, context: session.session.id };
  if (ctx.body?.createSession) throw new APIError("BAD_REQUEST", { message: "绑定 Passkey 不创建新会话" });
}

// Native passkey authentication creates a new login session. Step-up instead
// verifies a credential of the current account and leaves that session intact.
export function passkeyStepUp(baseURL: string): BetterAuthPlugin {
  const site = new URL(baseURL);
  return {
    id: "passkey-step-up",
    endpoints: {
      passkeyStepUpOptions: createAuthEndpoint("/security/passkey/options", {
        method: "POST", use: [sessionMiddleware], body: z.object({ purpose: z.enum(purposes) }),
      }, async ctx => {
        const session = ctx.context.session;
        const keys = await ctx.context.adapter.findMany<StoredPasskey>({ model: "passkey", where: [{ field: "userId", value: session.user.id }] });
        if (!keys.length) throw new APIError("BAD_REQUEST", { message: "尚未绑定 Passkey" });
        const options = await generateAuthenticationOptions({ rpID: site.hostname, userVerification: "required", allowCredentials: keys.map(key => ({ id: key.credentialID })) });
        const challengeId = crypto.randomUUID();
        await ctx.context.internalAdapter.createVerificationValue({
          identifier: `security-passkey:${challengeId}`, expiresAt: new Date(Date.now() + 300_000),
          value: JSON.stringify({ userId: session.user.id, sessionId: session.session.id, purpose: ctx.body.purpose, challenge: options.challenge }),
        });
        return ctx.json({ challengeId, options });
      }),
      passkeyStepUpComplete: createAuthEndpoint("/security/passkey/complete", {
        method: "POST", use: [sessionMiddleware], body: z.object({ challengeId: z.string(), response: z.custom<AuthenticationResponseJSON>(value => !!value && typeof value === "object" && "id" in value && "response" in value) }),
      }, async ctx => {
        const session = ctx.context.session;
        const row = await ctx.context.internalAdapter.consumeVerificationValue(`security-passkey:${ctx.body.challengeId}`);
        if (!row || row.expiresAt.getTime() <= Date.now()) throw new APIError("UNAUTHORIZED", { message: "Passkey 验证已过期，请重试" });
        const pending = JSON.parse(row.value) as { userId: string; sessionId: string; purpose: SecurityPurpose; challenge: string };
        if (pending.userId !== session.user.id || pending.sessionId !== session.session.id) throw new APIError("UNAUTHORIZED", { message: "验证会话不匹配" });
        const key = await ctx.context.adapter.findOne<StoredPasskey>({ model: "passkey", where: [{ field: "credentialID", value: ctx.body.response.id }, { field: "userId", value: session.user.id }] });
        if (!key) throw new APIError("UNAUTHORIZED", { message: "Passkey 不属于当前账号" });
        let result;
        try {
          result = await verifyAuthenticationResponse({ response: ctx.body.response, expectedChallenge: pending.challenge, expectedOrigin: site.origin, expectedRPID: site.hostname, credential: { id: key.credentialID, publicKey: base64.decode(key.publicKey), counter: key.counter }, requireUserVerification: true });
        } catch { throw new APIError("UNAUTHORIZED", { message: "Passkey 验证失败" }); }
        if (!result.verified) throw new APIError("UNAUTHORIZED", { message: "Passkey 验证失败" });
        const updated = await ctx.context.adapter.incrementOne({ model: "passkey", where: [{ field: "id", value: key.id }, { field: "userId", value: session.user.id }, { field: "counter", value: key.counter }], increment: { counter: result.authenticationInfo.newCounter - key.counter } });
        if (!updated) throw new APIError("UNAUTHORIZED", { message: "Passkey 已更改，请重试" });
        await recordAuthenticationProof(ctx.context, session, pending.purpose, true);
        return ctx.json({ verified: true });
      }),
    },
  };
}
