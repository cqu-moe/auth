import { Container } from "@cloudflare/containers";
import type { Env } from "../types";

/**
 * CQU 浏览器登录器容器(CF Containers, basic 1 GiB)。
 *
 * 容器内是 aiohttp(container/server.py)+ patchright(container/cqu_login.py):
 *   - POST /run  起一次完整登录, 阻塞等 2FA 码
 *   - POST /code DO 收到 CF 转发的 2FA 邮件提码后推入, 唤醒在途 /run
 *
 * DO 侧用 `env.CQU_LOGIN.getByName(userId)` 取实例, `.containerFetch('/run'|'/code', ...)`
 * 代理到容器(由 @cloudflare/containers 基类提供)。`sleepAfter` 短: 登录是一次性突发,
 * 拿到 ticket 后很快空闲, 让容器尽快休眠省成本。
 */
export class CquLoginContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "20s";
}
