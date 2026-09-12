import { handleEmail } from "./email-handler";
import type { Env } from "./types";
import { processScheduleNotificationBatch } from "./queue/schedule-notifications";
import { createApp } from "./app";

const app = createApp();

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
