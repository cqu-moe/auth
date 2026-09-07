import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { withCloudflare, type CloudflareGeolocation } from "better-auth-cloudflare";
import { admin } from "better-auth/plugins/admin";
import { defaultStatements, adminAc } from "better-auth/plugins/admin/access";
import { jwt } from "better-auth/plugins/jwt";
import { createAccessControl } from "better-auth/plugins/access";
import { customSession, emailOTP, twoFactor } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { Resend } from "resend";
import type { Env } from "./types";
import { resolveCaps, subsystemForAccessToken } from "./services/entitlements";
import { isCquMoeHost } from "./utils/cookie-domain";

// Must spread the admin plugin's defaultStatements: its built-in endpoints
// (listUsers/setRole/banUser/...) authorize against actions like
// user:["list","set-role","ban","delete","get"]. Defining a custom `user`
// statement without them strips those actions, so every admin API throws
// FORBIDDEN — which, called via auth.api.* without a catch, surfaces as a 500.
export const statement = {
  ...defaultStatements,
  oauthClient: ["create", "read", "update", "delete"],
  cquScope: ["assign", "revoke"],
  auditLog: ["read"],
  role: ["assign", "revoke"],
  entitlement: ["assign", "revoke"],
} as const;

export const ac = createAccessControl(statement);

export const roles = {
  user: ac.newRole({}),
  admin: ac.newRole({
    user: ["list", "get", "ban"],
    oauthClient: ["read"],
    auditLog: ["read"],
  }),
  superAdmin: ac.newRole({
    ...adminAc.statements,
    oauthClient: ["create", "read", "update", "delete"],
    cquScope: ["assign", "revoke"],
    auditLog: ["read"],
    role: ["assign", "revoke"],
    entitlement: ["assign", "revoke"],
  }),
};

// Scopes the OAuth provider accepts. Single source of truth: the oauthProvider
// config below and the admin client-update validation both reference this.
export const OAUTH_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "cqu:ticket:jwxt",
  "cqu:ticket:jxpj",
  "cqu:ticket:library",
  "cqu:ticket:card",
  "cqu:ticket:any",
];

const currentEmailOtpPaths = new Set([
  "/email-otp/send-verification-otp",
  "/email-otp/check-verification-otp",
]);

export function createAuth(env: Env, request: Request) {
  const getResend = () => new Resend(env.RESEND_API_KEY);

  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    ...withCloudflare(
      {
        d1Native: env.DATABASE,
        kv: env.KV,
        cf: (request.cf ?? {}) as CloudflareGeolocation,
        autoDetectIpAddress: true,
      },
      {
        emailAndPassword: {
          enabled: true,
          sendResetPassword: async ({ user, url }) => {
            void getResend().emails.send({
              from: "auth.cqu.moe <noreply@cqu.moe>",
              to: user.email,
              subject: "重置密码 - auth.cqu.moe",
              html: `<p>点击链接重置密码：<a href="${url}">${url}</a></p>`,
            });
          },
        },
        hooks: {
          before: createAuthMiddleware(async (ctx) => {
            if (!currentEmailOtpPaths.has(ctx.path)) return;
            const session = await getSessionFromCtx(ctx);
            const body = ctx.body as { email?: string; type?: string } | undefined;
            const matchesCurrentEmail =
              session &&
              body?.type === "email-verification" &&
              body.email?.trim().toLowerCase() === session.user.email.toLowerCase();

            if (!matchesCurrentEmail) {
              throw new APIError("FORBIDDEN", {
                code: "CURRENT_EMAIL_OTP_ONLY",
                message: "只能向当前登录邮箱发送或校验验证码",
              });
            }
          }),
        },
        emailVerification: {
          sendOnSignUp: true,
          autoSignInAfterVerification: true,
          sendVerificationEmail: async ({ user, url }) => {
            await getResend().emails.send({
              from: "auth.cqu.moe <noreply@cqu.moe>",
              to: user.email,
              subject: "验证你的邮箱 - auth.cqu.moe",
              html: `<p>点击链接验证邮箱：<a href="${url}">${url}</a></p>`,
            });
          },
        },
        disabledPaths: [
          "/token",
          "/sign-in/email-otp",
          "/email-otp/request-password-reset",
          "/forget-password/email-otp",
          "/email-otp/reset-password",
          "/email-otp/verify-email",
        ],
        plugins: [
          admin({
            ac,
            roles,
            defaultRole: "user",
            adminRoles: ["admin", "superAdmin"],
          }),
          jwt(),
          oauthProvider({
            loginPage: "/login",
            consentPage: "/oauth/authorize",
            scopes: OAUTH_SCOPES,
            // 按 client→subsystem 只盖该片 caps(最小披露);拿不到映射则盖空 {},绝不盖全量。
            // 用 customAccessTokenClaims(oauth-provider)而非 jwt.definePayload:
            // 已核实 OAuth access token 不经 definePayload,且 definePayload 入参无 client_id。
            customAccessTokenClaims: async (info) => {
              const sub = subsystemForAccessToken(info);
              if (!sub) return {};
              const caps = await resolveCaps(env.DATABASE, info.user!.id, sub);
              return { caps };
            },
            silenceWarnings: {
              oauthAuthServerConfig: true,
              openidConfig: true,
            },
          }),
          emailOTP({
            async sendVerificationOTP({ email, otp, type }) {
              const copy = type === "change-email"
                ? {
                    subject: "验证新登录邮箱 - auth.cqu.moe",
                    intro: "请输入以下验证码，完成登录邮箱更换。",
                  }
                : {
                    subject: "确认当前登录邮箱 - auth.cqu.moe",
                    intro: "请输入以下验证码，确认是你本人在更换登录邮箱。",
                  };

              await getResend().emails.send({
                from: "auth.cqu.moe <noreply@cqu.moe>",
                to: email,
                subject: copy.subject,
                html: `<p>${copy.intro}</p><p style="font-size:24px;font-weight:700;letter-spacing:6px">${otp}</p><p>验证码 5 分钟内有效，请勿转发。</p>`,
              });
            },
            otpLength: 6,
            expiresIn: 300,
            allowedAttempts: 3,
            storeOTP: "hashed",
            resendStrategy: "rotate",
            disableSignUp: true,
            changeEmail: { enabled: true, verifyCurrentEmail: true },
          }),
          twoFactor({
            issuer: "auth.cqu.moe",
            twoFactorCookieMaxAge: 600,
            trustDeviceMaxAge: 60 * 60 * 24 * 30,
            totpOptions: { digits: 6, period: 30 },
            otpOptions: {
              digits: 6,
              period: 5,
              allowedAttempts: 3,
              storeOTP: "hashed",
              async sendOTP({ user, otp }) {
                await getResend().emails.send({
                  from: "auth.cqu.moe <noreply@cqu.moe>",
                  to: user.email,
                  subject: "登录二次验证码 - auth.cqu.moe",
                  html: `<p>请输入以下验证码完成登录：</p><p style="font-size:24px;font-weight:700;letter-spacing:6px">${otp}</p><p>验证码 5 分钟内有效，请勿转发。</p>`,
                });
              },
            },
            backupCodeOptions: {
              amount: 10,
              length: 10,
              storeBackupCodes: "encrypted",
            },
          }),
          // customSession 必须放在 plugins 数组最后:它内部调用 getSession()
          // 拿到已组装好的 {user, session}(含 admin 的 role),再追加 caps。
          // 返回值会"完全替换" get-session 响应体,故必须显式回传 user+session。
          customSession(async ({ user, session }) => {
            const caps = await resolveCaps(env.DATABASE, user.id);
            delete (caps as any).cqu; // 不向 SPA 会话披露 quicklogin;设置页改用 GET /api/cqu/quicklogin 专门读写
            return { user, session, caps };
          }),
        ],
        // 一次登录 auth.cqu.moe → cookie 覆盖所有 *.cqu.moe 子域(第一方一体化 SSO)。
        // trustedOrigins 是顶层选项,通配符匹配整个 origin(含 :// 与 *);baseURL 已自动可信。
        // dev(localhost)下保留无害 —— baseURL 已自动可信,不靠它。
        trustedOrigins: ["https://*.cqu.moe"],
        // 注册权益不落在这里的 databaseHooks:公开注册唯一入口是
        // handleInvitationSignup(src/index.ts 拦截 /api/auth/sign-up/email),
        // 它按「邀请码自带预设 → 全局默认预设」显式写入,语义比全局钩子精确
        // (钩子分不清用户是凭哪个邀请码/无码注册的)。admin 后台建号不带权益
        // (fail-closed),需要时由管理台单独授权。
        // 跨子域 cookie 的 Domain 只在 auth host 真为 cqu.moe(生产)时才设。
        // 必须显式写 domain: "cqu.moe":省略时 better-auth 默认取
        // new URL(baseURL).hostname = "auth.cqu.moe",cookie 仅作用于该单一子域,
        // 跨子域 SSO 会静默失败;写 "cqu.moe" 浏览器才会按 ".cqu.moe" 全子域生效。
        // 但在 localhost(.dev.vars BETTER_AUTH_URL=http://localhost:8787)上若仍写
        // Domain=cqu.moe,浏览器会因 Domain 与响应 host 不匹配而【拒收】该 cookie →
        // npm run dev 的登录/会话直接坏掉。故 isCquMoeHost 为假(dev/非 cqu.moe)时
        // 整个省略 crossSubDomainCookies,让 better-auth 回落到 host-only cookie。
        advanced: isCquMoeHost(env.BETTER_AUTH_URL)
          ? { crossSubDomainCookies: { enabled: true, domain: "cqu.moe" } }
          : {},
        rateLimit: {
          enabled: true,
          window: 60,
          max: 30,
          storage: "secondary-storage",
          customRules: {
            "/two-factor/send-otp": { window: 60, max: 3 },
            "/two-factor/verify-totp": { window: 60, max: 5 },
            "/two-factor/verify-otp": { window: 60, max: 5 },
            "/two-factor/verify-backup-code": { window: 60, max: 5 },
            "/email-otp/send-verification-otp": { window: 60, max: 3 },
            "/email-otp/check-verification-otp": { window: 60, max: 5 },
            "/email-otp/request-email-change": { window: 60, max: 5 },
            "/email-otp/change-email": { window: 60, max: 5 },
          },
        },
      }
    ),
  });
}
