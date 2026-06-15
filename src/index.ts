import { Hono } from "hono";
import { cors } from "hono/cors";
import type { HonoEnv } from "./types";
import { createAuth } from "./auth";
import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider";
import { cqu } from "./routes/cqu";
import { cquBinding } from "./routes/cqu-bind";
import { cquQuicklogin } from "./routes/cqu-quicklogin";
import { admin } from "./routes/admin";
import { handleEmail } from "./email-handler";
import type { Env } from "./types";

const app = new Hono<HonoEnv>();

app.use("/*", cors());

app.get("/api/health", (c) =>
  c.json({ status: "ok", version: "d1native-fix", timestamp: new Date().toISOString() })
);

app.get("/.well-known/oauth-authorization-server", async (c) => {
  const auth = createAuth(c.env, c.req.raw);
  return oauthProviderAuthServerMetadata(auth)(c.req.raw);
});

app.get("/.well-known/openid-configuration", async (c) => {
  const auth = createAuth(c.env, c.req.raw);
  return oauthProviderOpenIdConfigMetadata(auth)(c.req.raw);
});

app.all("/api/auth/*", async (c) => {
  const auth = createAuth(c.env, c.req.raw);
  return auth.handler(c.req.raw);
});

// CQU 绑定资源挂在独立子树 /api/cqu/binding；快捷登录自助开关挂 /api/cqu/quicklogin
// （session-only，绝不接受 Bearer，故意不挂在 cqu.ts 的 /api/cqu/* 子树下）；
// cqu.ts（仅剩 service-ticket）挂在 /api/cqu。三者在 Hono trie 中是独立节点，互不遮蔽（与挂载顺序无关）。
app.route("/api/cqu/binding", cquBinding);
app.route("/api/cqu/quicklogin", cquQuicklogin);
app.route("/api/cqu", cqu);
app.route("/api/admin", admin);

app.all("*", async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// 显式默认导出：HTTP 走 Hono（含末尾 app.all("*") catch-all），
// 入站邮件走 Cloudflare Email Routing 的 email() handler。
export default {
  fetch: app.fetch,
  async email(message, env, _ctx) {
    await handleEmail(message, env);
  },
} satisfies ExportedHandler<Env>;
export { CquSessionDO } from "./durable-objects/cqu-session";
export { CquLoginContainer } from "./durable-objects/cqu-login-container";
// Service Binding RPC 入口:第一方子系统经 services binding(entrypoint:"AuthService")
// 调用 verifySession / getCquTicket。命名 entrypoint 随 Worker 自动暴露,auth 侧无需自绑定。
export { AuthService } from "./rpc";
