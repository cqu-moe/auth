import { betterAuth } from "better-auth";
import { withCloudflare, type CloudflareGeolocation } from "better-auth-cloudflare";
import { admin } from "better-auth/plugins/admin";
import { defaultStatements, adminAc } from "better-auth/plugins/admin/access";
import { jwt } from "better-auth/plugins/jwt";
import { createAccessControl } from "better-auth/plugins/access";
import { oauthProvider } from "@better-auth/oauth-provider";
import { Resend } from "resend";
import type { Env } from "./types";

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
];

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
        emailVerification: {
          sendVerificationEmail: async ({ user, url }) => {
            void getResend().emails.send({
              from: "auth.cqu.moe <noreply@cqu.moe>",
              to: user.email,
              subject: "验证你的邮箱 - auth.cqu.moe",
              html: `<p>点击链接验证邮箱：<a href="${url}">${url}</a></p>`,
            });
          },
        },
        disabledPaths: ["/token"],
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
            silenceWarnings: {
              oauthAuthServerConfig: true,
              openidConfig: true,
            },
          }),
        ],
        rateLimit: {
          enabled: true,
          window: 60,
          max: 30,
        },
      }
    ),
  });
}
