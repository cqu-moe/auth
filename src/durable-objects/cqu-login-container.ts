import { Container } from "@cloudflare/containers";
import type { Env } from "../types";

/**
 * CQU 浏览器登录器容器(CF Containers, basic 1 GiB)。
 *
 * 容器内是 aiohttp(container/server.py)；登录用裸 CDP，采集/取票仍用 patchright：
 *   - POST /run  起一次完整登录, 阻塞等 2FA 码
 *   - POST /code DO 收到 CF 转发的 2FA 邮件提码后推入, 唤醒在途 /run
 *
 * DO 侧用 `env.CQU_LOGIN.getByName(userId)` 取实例, `.containerFetch('/run'|'/code', ...)`
 * 代理到容器(由 @cloudflare/containers 基类提供)。`sleepAfter` 短: 登录是一次性突发,
 * 拿到 ticket 后很快空闲, 让容器尽快休眠省成本。
 */
export class CquLoginContainer extends Container<Env> {
  defaultPort = 8080;
  // 预热后还需持久化 bootId 和授予验证码权限, 握手请求之间保留原有窗口。
  sleepAfter = "30s";
  // Task 03 约定的 Cloudflare 运行 profile: 实测加长时限; QG_ENABLED=0 关掉青果
  // 住宅代理(海外出口不需要, 也连不上国内代理入口), 容器内全部直连。
  envVars = {
    CQU_BROWSER_PROFILE: "cloudflare",
    QG_ENABLED: "0",
    POSTHOG_PROJECT_TOKEN: this.env.POSTHOG_PROJECT_TOKEN ?? "",
    POSTHOG_HOST: this.env.POSTHOG_HOST ?? "https://p.cqu.moe",
    ENVIRONMENT: this.env.ENVIRONMENT ?? "development",
    RELEASE: this.env.RELEASE ?? "development",
  };

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const browserJob = request.method === "POST" && [
      "/run", "/service-ticket", "/keepalive", "/data-harvest",
      "/external-search", "/external-directory", "/external-capture",
    ].includes(path);
    if (path === "/health" || browserJob) {
      // SDK 的在途计数在冷启动完成后才开始, 启动期间保留原有窗口。
      this.sleepAfter = "30s";
      this.renewActivityTimeout();
    }
    try {
      return await super.fetch(request);
    } finally {
      if (browserJob) {
        // SDK 会保护尚未传完的响应; 调度一次检查以唤醒旧的 30s alarm。
        this.sleepAfter = "1s";
        this.renewActivityTimeout();
        await this.schedule(0, "renewActivityTimeout");
      }
    }
  }
}
