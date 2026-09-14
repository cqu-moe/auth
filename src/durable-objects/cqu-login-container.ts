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
  // 30s 空闲即睡: 保留足够窗口让保活/取票复用刚登录完的浏览器进程, 又不为空转付费。
  // 容器生命周期仍由 SDK 的请求计数驱动, 不自行写定时 stop。
  sleepAfter = "30s";
  // Task 03 约定的 Cloudflare 运行 profile: 实测加长时限; QG_ENABLED=0 关掉青果
  // 住宅代理(海外出口不需要, 也连不上国内代理入口), 容器内全部直连。
  envVars = {
    CQU_BROWSER_PROFILE: "cloudflare",
    QG_ENABLED: "0",
  };
}
