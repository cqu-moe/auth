import { authenticationStrength, enforceAuthenticationStrength, recordAuthenticationProof } from "./services/auth-strength";
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
import { verifyAuthAccessToken } from "./services/auth-access-token";
import { currentDeviceAuthority } from "./services/device-authority";
import { getCquBinding } from "./services/cqu-binding";
import { authUrls } from "./auth-config";
import { DEVICE_SCOPE } from "./services/quicklogin/contracts";
import {
  assertQuickloginRefreshAllowed,
  createQuickloginConsentReference,
  quickloginAccessTokenClaims,
  QuickloginOAuthError,
} from "./services/quicklogin/oauth-grants";
import {
  assertRefreshTokenUserNotBanned,
  revokeSessionOAuthTokens,
  clearDeviceTrust,
  isBanned,
  revokeUserOAuthTokens,
  type OAuthTokenAdapter,
} from "./services/oauth-tokens";

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
export const OAUTH_CLIENT_SCOPES = [
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
export const OAUTH_SCOPES = [...OAUTH_CLIENT_SCOPES, DEVICE_SCOPE];

const currentEmailOtpPaths = new Set([
  "/email-otp/send-verification-otp",
  "/email-otp/check-verification-otp",
]);

export function createAuth(env: Env, request: Request) {
  const getResend = () => new Resend(env.RESEND_API_KEY);
  const urls = authUrls(env.BETTER_AUTH_URL);
  const quickloginConsentReference = createQuickloginConsentReference(env);

  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    basePath: urls.basePath,
    secret: env.BETTER_AUTH_SECRET,
    ...withCloudflare(
      {
        d1Native: env.DATABASE,
        cf: (request.cf ?? {}) as CloudflareGeolocation,
        autoDetectIpAddress: true,
      },
      {
        session: { cookieCache: { enabled: false } },
        emailAndPassword: {
          enabled: true,
          revokeSessionsOnPasswordReset: true,
          onPasswordReset: async ({ user }) => {
            await clearDeviceTrust((await createAuth(env, request).$context).adapter, user.id);
          },
          sendResetPassword: async ({ user, url }) => {
            void getResend().emails.send({
              from: "auth.cqu.moe <noreply@cqu.moe>",
              to: user.email,
              subject: "重置密码 - auth.cqu.moe",
              html: `<p>点击链接重置密码：<a href="${url}">${url}</a></p>`,
            });
          },
        },
        databaseHooks: {
          session: {
            delete: {
              before: async (session, context) => {
                const adapter = context?.context.adapter ?? (await createAuth(env, request).$context).adapter;
                await revokeSessionOAuthTokens(adapter, session.id);
              },
            },
          },
          user: {
            update: {
              // Every ban path (native /admin/ban-user, admin routes, v1 API)
              // funnels through updateUser, so this is the single choke point
              // to cascade OAuth token revocation on ban.
              after: async (user, context) => {
                const banned = user as {
                  banned?: boolean | null;
                  banExpires?: Date | string | null;
                };
                if (!context || !isBanned(banned)) return;
                await revokeUserOAuthTokens(
                  context.context.adapter as OAuthTokenAdapter,
                  user.id
                );
              },
            },
          },
        },
        hooks: {
          after: createAuthMiddleware(async (ctx) => {
            if (["/two-factor/verify-totp", "/two-factor/verify-backup-code"].includes(ctx.path) && ctx.context.newSession && !(ctx.context.returned instanceof APIError)) {
              await recordAuthenticationProof(ctx.context, ctx.context.newSession, "mfa", true);
            }
            if (ctx.path === "/change-password" && !(ctx.context.returned instanceof APIError) && ctx.context.session) {
              const current = ctx.context.session.session;
              const sessions = await ctx.context.internalAdapter.listSessions(current.userId);
              await ctx.context.internalAdapter.deleteSessions(sessions.filter(session => session.id !== current.id).map(session => session.token));
              await clearDeviceTrust(ctx.context.adapter, current.userId);
            }
            if (["/revoke-sessions", "/revoke-other-sessions", "/revoke-session"].includes(ctx.path) &&
                !(ctx.context.returned instanceof APIError) && ctx.context.session) {
              await clearDeviceTrust(ctx.context.adapter, ctx.context.session.user.id);
            }
            if (ctx.path !== "/oauth2/introspect") return;
            const result = ctx.context.returned as Record<string, unknown> | undefined;
            if (!result || result.active !== true) return;
            const authority = await currentDeviceAuthority(ctx.context.adapter, result);
            if (!authority) return ctx.json({ active: false });
            const { user, client } = authority;
            const sub = subsystemForAccessToken({ user, metadata: client.metadata });
            // skipConsent and subsystem are administrator-controlled client approval.
            // Profile/email remain exclusively in native scope-filtered userinfo.
            const response = { ...result };
            delete response.user;
            delete response.caps;
            delete response.cquBindStatus;
            if (!client.skipConsent || !sub) return ctx.json(response);
            const { bindStatus } = await getCquBinding(env.DATABASE, user.id);
            return ctx.json({ ...response,
              caps: await resolveCaps(env.DATABASE, user.id, sub), cquBindStatus: bindStatus,
            });
          }),
          before: createAuthMiddleware(async (ctx) => {
            await enforceAuthenticationStrength(ctx);
            if (ctx.path === "/two-factor/enable" && ctx.body?.method === "otp") {
              throw new APIError("FORBIDDEN", { message: "邮箱验证码不能作为第二因子" });
            }
            if (ctx.path === "/change-password") ctx.body = { ...ctx.body, revokeOtherSessions: false };
            if (ctx.path === "/oauth2/userinfo") {
              const authorization = ctx.headers?.get("authorization");
              if (!authorization?.startsWith("Bearer ")) throw new APIError("UNAUTHORIZED", { code: "INVALID_TOKEN", message: "Invalid access token" });
              try { await verifyAuthAccessToken(authorization.slice(7), env); }
              catch { throw new APIError("UNAUTHORIZED", { code: "INVALID_TOKEN", message: "Invalid access token" }); }
            }
            // Our authorization-code policy has no confidential OIDC exception.
            const authorizationQuery = { ...ctx.query, ...ctx.body };
            if (ctx.path === "/oauth2/authorize" &&
                (!authorizationQuery?.code_challenge || authorizationQuery?.code_challenge_method !== "S256")) {
              throw new APIError("BAD_REQUEST", { code: "INVALID_REQUEST", message: "S256 PKCE is required" });
            }
            if (ctx.path === "/oauth2/token") {
              const body = ctx.body as {
                grant_type?: unknown;
                client_id?: unknown;
                refresh_token?: unknown;
              } | undefined;
              if (body?.grant_type === "refresh_token") {
                await assertRefreshTokenUserNotBanned(
                  ctx.context.adapter,
                  body?.refresh_token
                );
              }
              try {
                await assertQuickloginRefreshAllowed(env, ctx.context.adapter, {
                  grantType: body?.grant_type,
                  clientId: body?.client_id,
                  refreshToken: body?.refresh_token,
                });
              } catch (error) {
                if (error instanceof QuickloginOAuthError) {
                  throw new APIError("BAD_REQUEST", {
                    code: "INVALID_GRANT",
                    message: "invalid refresh token",
                  });
                }
                throw error;
              }
            }
            if (ctx.path === "/admin/ban-user") {
              const session = await getSessionFromCtx(ctx);
              const targetId = (ctx.body as { userId?: unknown } | undefined)?.userId;
              // z.coerce.string() downstream accepts non-string ids; normalize the same way so the gate cannot be skipped by type juggling.
              const normalizedId = targetId == null ? null : String(targetId);
              if (session && normalizedId !== null && normalizedId !== session.user.id) {
                const target = await ctx.context.internalAdapter.findUserById(normalizedId);
                const targetRole = (target as { role?: string | null } | null)?.role ?? "user";
                const targetRoles = targetRole.split(",").map((role) => role.trim());
                const callerRole = (session.user as { role?: string | null }).role ?? "user";
                const callerIsSuperAdmin = callerRole.split(",").map((role) => role.trim()).includes("superAdmin");
                if (targetRoles.some((role) => role === "admin" || role === "superAdmin") && !callerIsSuperAdmin) {
                  throw new APIError("FORBIDDEN", {
                    code: "CANNOT_BAN_ADMINS",
                    message: "只有 superAdmin 可以封禁 admin 或 superAdmin",
                  });
                }
              }
            }
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
          autoSignInAfterVerification: false,
        },
        disabledPaths: [
          "/two-factor/send-otp",
          "/two-factor/verify-otp",
          "/token",
          "/sign-in/email-otp",
          "/email-otp/request-password-reset",
          "/forget-password/email-otp",
          "/email-otp/reset-password",
          "/verify-email",
        ],
        plugins: [
          authenticationStrength((headers, method, code) => verifyCurrentFactor(env, request, headers, method, code)),
          admin({
            ac,
            roles,
            defaultRole: "user",
            adminRoles: ["admin", "superAdmin"],
          }),
          jwt({
            jwt: { issuer: urls.issuer, audience: urls.issuer },
            jwks: {
              keyPairConfig: { alg: "EdDSA", crv: "Ed25519" },
            },
          }),
          oauthProvider({
            loginPage: "/login",
            consentPage: "/oauth/authorize",
            scopes: OAUTH_SCOPES,
            resources: [urls.issuer],
            // Existing clients share this sole legacy resource. Future API/MCP
            // resources must enable per-client links before adding audiences.
            enforcePerClientResources: false,
            postLogin: {
              page: "/oauth/authorize",
              shouldRedirect: async () => false,
              consentReferenceId: quickloginConsentReference,
            },
            // 按 client→subsystem 只盖该片 caps(最小披露);拿不到映射则盖空 {},绝不盖全量。
            // 用 customAccessTokenClaims(oauth-provider)而非 jwt.definePayload:
            // 已核实 OAuth access token 不经 definePayload,且 definePayload 入参无 client_id。
            customAccessTokenClaims: async (info) => {
              const claims: Record<string, unknown> = {};
              const sub = subsystemForAccessToken(info);
              if (sub) {
                claims.caps = await resolveCaps(env.DATABASE, info.user!.id, sub);
              }
              try {
                return {
                  ...claims,
                  ...(await quickloginAccessTokenClaims(env, info)),
                };
              } catch (error) {
                if (error instanceof QuickloginOAuthError) {
                  throw new APIError("FORBIDDEN", {
                    code: error.code,
                    message: error.code,
                  });
                }
                throw error;
              }
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
                    subject: "验证你的邮箱 - auth.cqu.moe",
                    intro: "请输入以下验证码，完成邮箱验证。",
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
            overrideDefaultEmailVerification: true,
            changeEmail: { enabled: true, verifyCurrentEmail: true },
          }),
          twoFactor({
            issuer: "auth.cqu.moe",
            twoFactorCookieMaxAge: 600,
            trustDeviceMaxAge: 60 * 60 * 24 * 30,
            totpOptions: { digits: 6, period: 30 },
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
          storage: "database",
          customRules: {
            "/two-factor/send-otp": { window: 60, max: 3 },
            "/two-factor/verify-totp": { window: 60, max: 5 },
            "/two-factor/verify-otp": { window: 60, max: 5 },
            "/two-factor/verify-backup-code": { window: 60, max: 5 },
            "/email-otp/send-verification-otp": { window: 60, max: 3 },
            "/email-otp/check-verification-otp": { window: 60, max: 5 },
            "/email-otp/verify-email": { window: 60, max: 5 },
            "/email-otp/request-email-change": { window: 60, max: 5 },
            "/email-otp/change-email": { window: 60, max: 5 },
          },
        },
      }
    ),
  });
}

async function verifyCurrentFactor(env: Env, request: Request, headers: Headers, method: "totp" | "backup-code", code: string): Promise<void> {
  const auth = createAuth(env, request);
  if (method === "totp") await auth.api.verifyTOTP({ headers, body: { code, trustDevice: false } });
  else await auth.api.verifyBackupCode({ headers, body: { code, trustDevice: false, disableSession: true } });
}
