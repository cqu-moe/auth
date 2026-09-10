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
import { cquQuickloginDevices } from "./routes/cqu-quicklogin-devices";
import { admin } from "./routes/admin";
import { handleEmail } from "./email-handler";
import type { Env } from "./types";
import { handleInvitationSignup } from "./services/registration-invitations";
import { processScheduleNotificationBatch } from "./queue/schedule-notifications";

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

// 注册必须先由应用层原子占用邀请码；单独挂在 Better Auth catch-all 之前，
// 确保直接调用公开 sign-up endpoint 也不能绕过邀请码校验。
app.post("/api/auth/sign-up/email", async (c) => {
  const auth = createAuth(c.env, c.req.raw);
  return handleInvitationSignup(
    c.req.raw,
    c.env.DATABASE,
    (request) => auth.handler(request)
  );
});

// 公开只读:注册页据此决定邀请码是必填还是选填。
// 只回一个布尔位,不泄露任何预设/邀请码内容。
app.get("/api/auth/registration-settings", async (c) => {
  const { isInvitationRequired } = await import("./services/entitlements");
  return c.json({ invitationRequired: await isInvitationRequired(c.env.DATABASE) });
});

app.all("/api/auth/*", async (c) => {
  const auth = createAuth(c.env, c.req.raw);
  return auth.handler(c.req.raw);
});

// CQU 绑定资源挂在独立子树 /api/cqu/binding；快捷登录自助开关挂 /api/cqu/quicklogin
// （session-only，绝不接受 Bearer，故意不挂在 cqu.ts 的 /api/cqu/* 子树下）；
// cqu.ts（仅剩 service-ticket）挂在 /api/cqu。三者在 Hono trie 中是独立节点，互不遮蔽（与挂载顺序无关）。
app.route("/api/cqu/binding", cquBinding);
app.route("/api/cqu/quicklogin/devices", cquQuickloginDevices);
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
  async queue(batch, env, _ctx) {
    if (batch.queue === "schedule-notifications") {
      await processScheduleNotificationBatch(batch, env);
      return;
    }
    console.warn(JSON.stringify({
      event: "queue.unknown",
      queue: batch.queue,
      message: "Unknown queue",
    }));
  },
} satisfies ExportedHandler<Env>;
export { CquSessionDO } from "./durable-objects/cqu-session";
export { CquLoginContainer } from "./durable-objects/cqu-login-container";
export { CquQuickloginAccountDO } from "./durable-objects/cqu-quicklogin-account";
export { CquQuickloginDeviceDO } from "./durable-objects/cqu-quicklogin-device";
// Service Binding RPC 入口:第一方子系统经 services binding(entrypoint:"AuthService")
// 调用 verifySession / getCquTicket。命名 entrypoint 随 Worker 自动暴露,auth 侧无需自绑定。
export { AuthService } from "./rpc";
