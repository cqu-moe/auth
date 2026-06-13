import { DurableObject } from "cloudflare:workers";
import { CquSsoClient, type CasCookies, CquSsoError } from "../services/cqu-sso";
import { decrypt } from "../services/crypto";
import {
  nextStatus,
  type CquStatus,
  type CquEvent,
} from "../services/cqu-2fa/state-machine";
import { shouldStartLogin } from "../services/cqu-2fa/single-flight";
import { decodeJwtExp } from "../services/cqu-2fa/jwt-exp";
import {
  shouldProactiveRelogin,
  pruneAttempts,
  shouldThrottleRelogin,
  RELOGIN_RATE_WINDOW_MS,
  MAX_RELOGINS_PER_WINDOW,
  CONSECUTIVE_RELOGIN_FAIL_ALERT,
} from "../services/cqu-2fa/relogin-policy";
import type { Env } from "../types";

const KEEPALIVE_INTERVAL_MS = 15 * 60 * 1000;
const RETRY_INTERVAL_MS = 60 * 1000;
const MAX_FAST_RETRIES = 5;
// TGT 绝对寿命 ~8h；在 7h 处主动重铸, 留 ~1h 余量给重登流程(容器点火 + 发码 + 邮件到达 + 提交)。
const PROACTIVE_RELOGIN_MS = 7 * 60 * 60 * 1000;
const DUMMY_SERVICE = "https://my.cqu.edu.cn/authserver/authentication/cas";

export const SERVICE_URLS: Record<string, string> = {
  jwxt: "https://my.cqu.edu.cn/authserver/authentication/cas",
  jxpj: "https://my.cqu.edu.cn/authserver/authentication/cas",
  library: "https://lib.cqu.edu.cn/cas/validate",
  card: "https://card.cqu.edu.cn/cas/validate",
};

interface SessionState {
  userId: string;
  studentId: string;
  cookies: CasCookies;
  objectId: string;
  tgt: string;
  // 当前 TGT 的铸造时刻(ms)。alarm 用它判定是否到 +7h 主动重登窗口。
  loginAt: number;
  lastKeepAlive: number;
  lastRequestedAt: number;
  consecutiveFailures: number;
}

interface StoredCredentials {
  encryptedPassword: string;
  iv: string;
}

// single-flight 锁: 一次容器登录在途的标记。`token` 同时是容器侧 session 键,
// deposit-code 凭它把 2FA 码 POST /code 路由到正确的在途 /run。
interface LoginInFlight {
  token: string;
  startedAt: number;
}

// 绑定确认码暂存(kind=bind_confirm)。Phase 6 经 WS 推浏览器后清除。
interface PendingCode {
  code: string;
  kind: string;
  expiresAt: number;
}

// CF Email Routing 提码后投递的载荷(见 src/email-handler.ts)。
interface DepositCodePayload {
  code: string;
  kind: "login_2fa" | "bind_confirm";
  sender?: string;
  ts?: number;
}

// 容器 /run 的返回(见 container/server.py + cqu_login.run_login)。
interface ContainerRunResult {
  ok: boolean;
  cookies?: CasCookies;
  ticket?: string;
  error?: string;
}

// 暂存的绑定码 TTL: 绑定确认码实测后端有效期约 10min(邮件正文写的"2分钟"不准),
// 暂存兜底必须比它活得更久, 否则迟到/重连的浏览器回放到的是已被后端作废的码;
// 取 12min 留 ~2min 余量覆盖时钟漂移与 WS 重连窗口。
const PENDING_CODE_TTL_MS = 12 * 60 * 1000;

export class CquSessionDO extends DurableObject<Env> {
  private state: SessionState | null = null;
  private ssoClient = new CquSsoClient();

  private async loadState(): Promise<void> {
    if (!this.state) {
      this.state = (await this.ctx.storage.get<SessionState>("state")) ?? null;
    }
  }

  private async getStatus(): Promise<CquStatus> {
    return (
      (await this.ctx.storage.get<CquStatus>("status")) ?? "unbound"
    );
  }

  private async setStatus(status: CquStatus): Promise<void> {
    await this.ctx.storage.put("status", status);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WS 升级分支(在 action switch 之前): 浏览器在绑定 onboarding 期间连上来等
    // bind_confirm 码秒推。用 Hibernatable WebSocket — 接受 server 端后即可忘掉,
    // DO 被驱逐也能存活, 唤醒后由 webSocket* 回调处理。鉴权/路由(只有正确用户的
    // 浏览器能到达本 DO)由 Worker route(Task 6.2)负责; 本 DO 已按 idFromName(userId)
    // 按用户寻址, 这里只管 accept。
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      // pair[1] 是 server 端 — 交给 DO 托管(hibernatable); pair[0] 返回给客户端。
      this.ctx.acceptWebSocket(pair[1]);
      // 回放兜底: 码可能在浏览器 WS 连上(或重连)之前就到了, depositCode 的实时 send
      // 推给了零个 socket 而丢失。此处在 accept 后立刻读暂存的 pendingCode, 若仍有效
      // (未过期且 kind=bind_confirm)就主动补推给这条新连接, 让迟到/重连的浏览器立即收到。
      const pending =
        await this.ctx.storage.get<PendingCode>("pendingCode");
      if (
        pending &&
        pending.kind === "bind_confirm" &&
        pending.expiresAt > Date.now()
      ) {
        try {
          pair[1].send(
            JSON.stringify({
              type: "bind_code",
              code: pending.code,
              ts: Date.now(),
            })
          );
        } catch {
          // 回放补推失败(连接已断/正在关闭)忽略, 不影响 accept 与 101 返回。
        }
      }
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    const action = url.pathname.split("/").pop();

    try {
      switch (action) {
        case "init": {
          const body = await request.json<{
            userId: string;
            studentId: string;
            encryptedPassword: string;
            iv: string;
          }>();
          await this.ctx.storage.put<StoredCredentials>("credentials", {
            encryptedPassword: body.encryptedPassword,
            iv: body.iv,
          });
          const result = await this.initSession(
            body.userId,
            body.studentId,
            body.encryptedPassword,
            body.iv
          );
          return Response.json(result);
        }
        case "service-ticket": {
          const service = url.searchParams.get("service");
          if (!service)
            return Response.json({ error: "Missing service" }, { status: 400 });
          const ticket = await this.getServiceTicket(service);
          return Response.json({ ticket });
        }
        case "deposit-code": {
          const body = await request.json<DepositCodePayload>();
          const delivered = await this.depositCode(body);
          return Response.json({ success: true, delivered });
        }
        case "status": {
          const status = await this.getStatusResponse();
          return Response.json(status);
        }
        case "destroy": {
          await this.destroy();
          return Response.json({ success: true });
        }
        case "revoke": {
          await this.revoke();
          return Response.json({ success: true });
        }
        default:
          return Response.json({ error: "Unknown action" }, { status: 404 });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "Internal error";
      const code = e instanceof CquSsoError ? e.code : "INTERNAL_ERROR";
      return Response.json({ error: message, code }, { status: 500 });
    }
  }

  // --- Hibernatable WebSocket 回调 ---
  // 浏览器只 RECEIVE(bind_code 由 depositCode 主动 send), 这里的入站消息无业务用途。
  // 签名对齐 @cloudflare/workers-types DurableObject 接口。

  /** 客户端入站消息: 无业务语义(浏览器只收), 收到即丢弃。 */
  async webSocketMessage(
    _ws: WebSocket,
    _message: string | ArrayBuffer
  ): Promise<void> {
    // no-op: 浏览器仅作为 bind_code 的接收端。
  }

  /** 连接关闭: 尽力回关一次, 让 hibernatable socket 干净下线。 */
  async webSocketClose(
    ws: WebSocket,
    code: number,
    _reason: string,
    _wasClean: boolean
  ): Promise<void> {
    try {
      ws.close(code, "client closed");
    } catch {
      // 已关闭/无法关闭: 忽略。
    }
  }

  /** 连接出错: 尽力关闭, 不抛出。 */
  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    try {
      ws.close(1011, "ws error");
    } catch {
      // 忽略。
    }
  }

  /**
   * 首登: 存凭证 + 经容器(patchright 浏览器登录器)铸第一份 TGT。
   *
   * 走与 relogin() 同一条容器路径; 成功落 cookies + loginAt + 状态机 FIRST_LOGIN_OK(→ active)。
   *
   * NOTE(onboarding, Phase 6 定稿): 真实首登要求绑定先 active(密保邮箱已设为专属地址、
   * 2FA 邮件能被 CF 捕获)才能跑通——容器发码后 DO 必须能收到 deposit-code。Phase 5 这里
   * 只负责「存凭证 + 触发容器登录」, 不强求 onboarding 时序完全闭合; 在尚未绑定 2FA 邮件的
   * 环境里, 容器会在等码处超时返回失败, initSession 据此返回 {success:false}(route 据此回滚)。
   */
  private async initSession(
    userId: string,
    studentId: string,
    _encryptedPassword: string,
    _iv: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // 占位 state, 让 runContainerLogin 能拿到 userId/studentId。
      this.state = {
        userId,
        studentId,
        cookies: { SOURCEID_TGC: "", SESSION: "", rg_objectid: "" },
        objectId: "",
        tgt: "",
        loginAt: 0,
        lastKeepAlive: Date.now(),
        lastRequestedAt: Date.now(),
        consecutiveFailures: 0,
      };
      await this.setStatus("binding");
      const outcome = await this.containerLogin(
        "FIRST_LOGIN_OK",
        "FIRST_LOGIN_FAIL"
      );
      if (outcome === "in_flight") {
        // 已有在途首登(如重复提交), 让它跑完; 不当失败回滚, 也不谎报成功。
        return {
          success: false,
          error: "CQU 登录正在进行中（请勿重复提交）",
        };
      }
      if (outcome === "failed") {
        return { success: false, error: "CQU 登录失败（容器登录未成功）" };
      }
      await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_INTERVAL_MS);
      return { success: true };
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : "Unknown error",
      };
    }
  }

  private async getServiceTicket(service: string): Promise<string> {
    await this.loadState();
    const status = await this.getStatus();
    if (!this.state || status !== "active") {
      throw new CquSsoError("SESSION_INACTIVE", "CQU session not active");
    }
    const serviceUrl = SERVICE_URLS[service];
    if (!serviceUrl) {
      throw new CquSsoError("UNKNOWN_SERVICE", `Unknown service: ${service}`);
    }
    this.state.lastRequestedAt = Date.now();
    await this.ctx.storage.put("state", this.state);
    return this.ssoClient.getServiceTicket(this.state.cookies, serviceUrl);
  }

  /**
   * CF Email Routing 提码后投递点(见 src/email-handler.ts POST /deposit-code)。
   * 按 kind 分流:
   *   - login_2fa  : 把码推给在途容器 /run(凭 loginInFlight.token 作 session 键路由)。
   *                  无在途登录则记日志并忽略(迟到/无主码)。
   *   - bind_confirm: 暂存 pendingCode(Phase 6 经 WS 秒推浏览器)。
   *
   * @returns delivered —— 码是否真正送达目标:
   *   - login_2fa  : 仅当(有在途登录锁 && 有 session 状态 && 容器 /code 返回 ok)为 true;
   *                  无锁/无 state/!res.ok/异常 均 false(码被丢弃, 调用方据此记丢码而非 accepted)。
   *   - bind_confirm: true(已落 pendingCode 兜底, 即便实时 WS 推送零接收方也不算丢)。
   *   - 未知 kind   : false。
   */
  private async depositCode(payload: DepositCodePayload): Promise<boolean> {
    await this.loadState();
    const { code, kind } = payload;

    if (kind === "login_2fa") {
      const lock = await this.ctx.storage.get<LoginInFlight>("loginInFlight");
      if (!lock) {
        console.warn(
          `[CquSession] login_2fa code arrived but no login in flight, ignoring`
        );
        return false;
      }
      const userId = this.state?.userId;
      if (!userId) {
        console.warn(
          `[CquSession] login_2fa code arrived but no session state, ignoring`
        );
        return false;
      }
      try {
        const stub = this.getLoginContainer(userId);
        const res = await stub.fetch(
          new Request("https://c/code", {
            method: "POST",
            body: JSON.stringify({ session: lock.token, code }),
          })
        );
        if (!res.ok) {
          console.error(
            `[CquSession] container /code returned non-ok status=${res.status}`
          );
          return false;
        }
        return true;
      } catch (e) {
        console.error(
          `[CquSession] failed to push login_2fa code to container: ${errMsg(e)}`
        );
        return false;
      }
    }

    if (kind === "bind_confirm") {
      // 暂存: 浏览器若连接略晚(WS 还没建好), 仍能事后读到(Task 6.2 加读路径)。
      const pending: PendingCode = {
        code,
        kind,
        expiresAt: Date.now() + PENDING_CODE_TTL_MS,
      };
      await this.ctx.storage.put("pendingCode", pending);
      // 秒推所有已连接的浏览器(hibernatable WS)。send 失败(连接已断/正在关闭)忽略,
      // pendingCode 兜底。
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(JSON.stringify({ type: "bind_code", code, ts: Date.now() }));
        } catch {
          // 忽略单个 socket 的发送失败, 不影响其它 socket 与暂存。
        }
      }
      return true;
    }

    console.warn(`[CquSession] deposit-code unknown kind: ${kind}`);
    return false;
  }

  private async getStatusResponse(): Promise<Record<string, unknown>> {
    await this.loadState();
    const status = await this.getStatus();
    if (!this.state) return { status };
    return {
      status,
      studentId: this.state.studentId,
      loginAt: this.state.loginAt,
      lastKeepAlive: this.state.lastKeepAlive,
      lastRequestedAt: this.state.lastRequestedAt,
    };
  }

  private async destroy(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.state = null;
    // deleteAll 已清掉 status/loginInFlight/pendingCode/state/credentials/reloginAttempts/reloginFailures;
    // 显式回到 unbound, 让后续 status 查询语义清晰(而非依赖默认值)。
    await this.setStatus("unbound");
  }

  /**
   * 撤销(吊销): 管理员/系统触发的「标记禁用、保留墓碑」, 区别于 destroy(用户自助彻底删)。
   *   ① status → revoked: alarm() 已对 revoked 早退不再保活/重登; getServiceTicket 因 status≠active
   *      拒发 ST; email 管道对 revoked 拒收码 —— 三处都凭 status 闸住, 此处置位即生效。
   *   ② deleteAlarm: 立即停掉 keepalive/主动重登的 alarm 循环, 不等下次触发自然早退。
   *   ③ delete loginInFlight: 清在途登录锁, 防残留锁挡住后续(如解封后)的合法登录。
   * 与 destroy 的关键区别: **保留** state/credentials —— 凭证留痕便于审计, 墓碑由 D1
   * cqu_bind_addresses.status=revoked 承载; 这里不 deleteAll, 故 revoked 是可逆禁用而非彻底清除。
   */
  private async revoke(): Promise<void> {
    await this.setStatus("revoked");
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.delete("loginInFlight");
  }

  async alarm(): Promise<void> {
    await this.loadState();
    if (!this.state) return;
    const status = await this.getStatus();
    // 已撤销/未绑定的会话不再保活。
    if (status === "revoked" || status === "unbound") return;

    // 主动重登: TGT 接近 ~8h 硬上限前(+7h)且当前 active, 提前重铸, 避免热路径在过期窗口取不到 ST。
    // 判定抽成纯函数 shouldProactiveRelogin(便于单测), 语义与旧内联条件完全一致(含 `>=` 边界)。
    if (
      shouldProactiveRelogin(
        status,
        this.state.loginAt,
        Date.now(),
        PROACTIVE_RELOGIN_MS
      )
    ) {
      console.warn(
        `[CquSession] ${this.state.studentId}: TGT age >= 7h, proactive relogin`
      );
      await this.relogin();
      // relogin 内部已更新状态; 重新排 alarm 继续保活循环。
      await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_INTERVAL_MS);
      return;
    }

    const outcome = await this.runKeepAlive();

    if (outcome === "active") {
      await this.setStatus("active");
      this.state.lastKeepAlive = Date.now();
      this.state.consecutiveFailures = 0;
      await this.ctx.storage.put("state", this.state);
      // 探针自愈回 active 也打断「连续重登失败」链, 避免遗留的 reloginFailures
      // 误触 CONSECUTIVE_RELOGIN_FAIL_ALERT 告警。
      await this.ctx.storage.put("reloginFailures", 0);
      await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_INTERVAL_MS);
      return;
    }

    if (outcome === "expired") {
      // 探针证实 TGT 服务端失效 — 触发容器重登铸新 TGT。
      // relogin 自带 single-flight + 状态机(RELOGIN_START/OK/FAIL), 失败落 expired。
      console.warn(
        `[CquSession] ${this.state.studentId}: session expired server-side, triggering container relogin`
      );
      await this.relogin();
      this.state.consecutiveFailures = 0;
      await this.ctx.storage.put("state", this.state);
      await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_INTERVAL_MS);
      return;
    }

    // outcome === "transient": 够不到 CQU SSO。CAS 会话服务端几乎肯定还有效,
    // 保留 cookies/status 不动, 快重试而非误判重登。
    this.state.consecutiveFailures = (this.state.consecutiveFailures ?? 0) + 1;
    const fastRetry = this.state.consecutiveFailures <= MAX_FAST_RETRIES;
    const delay = fastRetry ? RETRY_INTERVAL_MS : KEEPALIVE_INTERVAL_MS;
    console.warn(
      `[CquSession] ${this.state.studentId}: keepalive unreachable (attempt #${this.state.consecutiveFailures}), keeping session, retrying in ${delay}ms`
    );
    await this.ctx.storage.put("state", this.state);
    await this.ctx.storage.setAlarm(Date.now() + delay);
  }

  /**
   * 一轮保活探针。返回:
   * - "active":    凭已有 cookie 仍能换 ST, 会话有效。
   * - "expired":   服务端可达但 TGT 失效 — 需真重登。
   * - "transient": 够不到 CQU; cookie 原样保留, 调用方应快重试。
   *
   * NOTE: 与旧实现不同, 这里只「探针」, 不在 runKeepAlive 内直接重登;
   * 重登(走容器)由 alarm() 在 outcome==="expired" 时统一触发, 以复用 single-flight。
   */
  private async runKeepAlive(): Promise<"active" | "expired" | "transient"> {
    const state = this.state!;
    try {
      await this.ssoClient.getServiceTicket(state.cookies, DUMMY_SERVICE);
      return "active";
    } catch (e) {
      if (isTransientError(e)) {
        console.warn(
          `[CquSession] ${state.studentId}: probe unreachable: ${errMsg(e)}`
        );
        return "transient";
      }
      // 非网络失败(如 TGT_EXPIRED): 会话服务端失效。
      // 诊断: 落 expired 前记一条 — errMsg 会带上含 status + page 分类的消息,
      // 用于区分真过期(page=cas-login)与瑞数误判(page=waf-challenge)。
      console.warn(
        `[CquSession] ${state.studentId}: probe says expired: ${errMsg(e)}`
      );
      return "expired";
    }
  }

  /**
   * 容器驱动的重登。single-flight 保护已下沉到 containerLogin: 已有在途登录(锁未过期)时
   * containerLogin 返回 "in_flight", 不点火第二个容器、不重设锁。
   * 解密存储的密码 → 调容器 /run 铸新 TGT → 成功落 cookies + loginAt + RELOGIN_OK(→ active);
   * 失败落 RELOGIN_FAIL(→ expired)。锁无论成败都清掉。
   */
  private async relogin(): Promise<void> {
    if (!this.state) throw new Error("No state");
    const studentId = this.state.studentId;
    const now = Date.now();

    // 重登限频(只在重登路径, 不进 containerLogin —— 否则会误伤永不该被限流的首登)。
    // 读近期重登发起时刻, 裁到窗口; 若已达 runaway 闸则告警并直接 return:
    // 不点火容器、不记录本次尝试、状态保持不变(不推进到 relogging), 避免自激循环烧穿容器/触瑞数风控。
    const stored =
      (await this.ctx.storage.get<number[]>("reloginAttempts")) ?? [];
    const pruned = pruneAttempts(stored, now, RELOGIN_RATE_WINDOW_MS);
    if (
      shouldThrottleRelogin(
        pruned,
        now,
        RELOGIN_RATE_WINDOW_MS,
        MAX_RELOGINS_PER_WINDOW
      )
    ) {
      console.error(
        `[CquSession] ${studentId}: ALERT relogin throttled — ${pruned.length} relogins in last hour, skipping to avoid runaway/瑞数 risk`
      );
      return;
    }
    // 未限流: 记录本次发起时刻并落盘, 再继续容器登录。
    pruned.push(now);
    await this.ctx.storage.put("reloginAttempts", pruned);

    const outcome = await this.containerLogin(
      "RELOGIN_OK",
      "RELOGIN_FAIL",
      // RELOGIN_START 仅在真正发起新登录时推进状态(active/expired → relogging);
      // 命中在途锁则不动状态, 让在途登录自己收尾。
      "RELOGIN_START"
    );
    if (outcome === "in_flight") {
      // 命中在途锁: 不算一次失败、也不重置失败计数(让在途登录自己收尾)。
      console.info(
        `[CquSession] ${studentId}: relogin already in flight, skip`
      );
      return;
    }
    if (outcome === "failed") {
      // containerLogin 失败时已把状态推到 RELOGIN_FAIL(→ expired) 并清锁。
      console.error(`[CquSession] ${studentId}: relogin failed`);
      // 连续重登失败计数自增 + 持久化; 达阈值告警(会话多半真坏: 密码改了/转发断了/瑞数变更)。
      const failures =
        ((await this.ctx.storage.get<number>("reloginFailures")) ?? 0) + 1;
      await this.ctx.storage.put("reloginFailures", failures);
      if (failures >= CONSECUTIVE_RELOGIN_FAIL_ALERT) {
        console.error(
          `[CquSession] ${studentId}: ALERT ${failures} consecutive relogin failures — session likely broken (密码改了/转发断了/瑞数变更)`
        );
      }
      return;
    }
    // outcome === "ok": 重登成功, 新 TGT 已铸 —— 重置连续失败计数。warn 级以便在
    // observability 可见(info 级实测在当前配置下不可见; 重登成功此前无任何日志, 是观测盲区)。
    await this.ctx.storage.put("reloginFailures", 0);
    console.warn(`[CquSession] ${studentId}: relogin OK, new TGT minted`);
  }

  /**
   * 调容器 /run 跑一次完整浏览器登录(首登 / 重登共用)。
   *
   * single-flight 在此集中: 先从 storage 读最新锁, 若已有「活的、未过期」在途登录
   * (shouldStartLogin === false) 则返回 "in_flight", 不点火第二个容器、不覆盖锁,
   * 这样 init()→containerLogin 与 relogin()→containerLogin 都能抵御重复触发
   * (如绑定时的双击提交)。
   *
   * 设置 single-flight 锁(token 作容器 session 键, deposit-code 凭它路由 2FA 码),
   * 解密密码 → POST /run → 成功落 cookies + loginAt + `okEvent`; 失败走 `failEvent`。
   * 锁无论成败都清。
   *
   * @param startEvent 真正发起新登录前推进状态机的事件(如 RELOGIN_START → relogging);
   *                   命中在途锁时不会触发, 避免无谓的状态翻动。
   * @returns "in_flight" 已有在途登录(未做任何改动) | "ok" 成功 | "failed" 失败
   */
  private async containerLogin(
    okEvent: "FIRST_LOGIN_OK" | "RELOGIN_OK",
    failEvent: "FIRST_LOGIN_FAIL" | "RELOGIN_FAIL",
    startEvent?: CquEvent
  ): Promise<"in_flight" | "ok" | "failed"> {
    const state = this.state!;

    // single-flight 守卫: 读最新锁, 活锁在途则直接退出, 不抢锁、不二次发码。
    const existingLock =
      await this.ctx.storage.get<LoginInFlight>("loginInFlight");
    if (!shouldStartLogin(existingLock ?? null, Date.now())) {
      return "in_flight";
    }

    const creds = await this.ctx.storage.get<StoredCredentials>("credentials");
    if (!creds) {
      await this.failLogin(failEvent);
      throw new Error("No stored credentials");
    }

    // 确认要发起新登录后再推进状态机(如 RELOGIN_START → relogging)。
    if (startEvent) {
      const status = await this.getStatus();
      await this.setStatus(nextStatus(status, startEvent));
    }

    const token = crypto.randomUUID();
    const lock: LoginInFlight = { token, startedAt: Date.now() };
    await this.ctx.storage.put("loginInFlight", lock);

    try {
      const password = await decrypt(
        creds.encryptedPassword,
        creds.iv,
        this.env.ENCRYPTION_KEY
      );
      const stub = this.getLoginContainer(state.userId);
      const res = await stub.fetch(
        new Request("https://c/run", {
          method: "POST",
          body: JSON.stringify({
            studentId: state.studentId,
            password,
            service: DUMMY_SERVICE,
            method: "mail",
            session: token,
          }),
        })
      );
      const result = await res.json<ContainerRunResult>();
      if (!res.ok || !result.ok || !result.cookies) {
        console.warn(
          `[CquSession] ${state.studentId}: container /run not ok — httpStatus=${res.status} ok=${result.ok} hasCookies=${!!result.cookies} error=${result.error ?? "(none)"}`
        );
        await this.failLogin(failEvent);
        return "failed";
      }

      // I2: /run 阻塞期间(可达 ~5min)其它请求(如 getServiceTicket)可能已更新过
      // state.lastRequestedAt 并落盘。不要用 await 之前抓取的快照整盘覆盖, 而是
      // 重读最新 state 后只改 cookie/loginAt/lastKeepAlive 这几个本次登录拥有的字段。
      const fresh =
        (await this.ctx.storage.get<SessionState>("state")) ?? state;
      const now = Date.now();
      fresh.cookies = result.cookies;
      fresh.loginAt = now;
      fresh.lastKeepAlive = now;
      this.state = fresh;
      // 诊断: 尽力解出新 TGT(SOURCEID_TGC, JWT) 的 exp, 观测其服务端寿命, 排查
      // 会话疑似「定点过期」(按固定时刻而非固定时长)。绝不记录 token 本身, 只记
      // exp 时刻与剩余分钟数。decodeJwtExp 纯函数不抛, 再用 try/catch 兜底, 确保
      // 诊断绝不影响登录。
      try {
        const exp = decodeJwtExp(result.cookies.SOURCEID_TGC);
        if (exp !== null) {
          console.warn(
            `[CquSession] ${state.studentId}: new TGT exp=${new Date(exp * 1000).toISOString()} (ageBudget=${Math.round((exp * 1000 - Date.now()) / 60000)}min)`
          );
        } else {
          console.warn(
            `[CquSession] ${state.studentId}: new TGT exp=undecodable`
          );
        }
      } catch {
        // 诊断失败绝不影响登录主流程。
      }
      await this.ctx.storage.put("state", fresh);
      const status = await this.getStatus();
      await this.setStatus(nextStatus(status, okEvent));
      await this.ctx.storage.delete("loginInFlight");
      return "ok";
    } catch (e) {
      console.error(
        `[CquSession] ${state.studentId}: container login error: ${errMsg(e)}`
      );
      await this.failLogin(failEvent);
      return "failed";
    }
  }

  /** 登录失败收尾: 按 `failEvent` 推进状态机(首登→unbound / 重登→expired) + 清 single-flight 锁。 */
  private async failLogin(
    failEvent: "FIRST_LOGIN_FAIL" | "RELOGIN_FAIL"
  ): Promise<void> {
    const status = await this.getStatus();
    await this.setStatus(nextStatus(status, failEvent));
    await this.ctx.storage.delete("loginInFlight");
  }

  /** 取该用户的浏览器登录器容器实例(寻址镜像 CQU_SESSION: idFromName → get)。 */
  private getLoginContainer(userId: string): DurableObjectStub {
    const id = this.env.CQU_LOGIN.idFromName(userId);
    return this.env.CQU_LOGIN.get(id);
  }
}

function isTransientError(e: unknown): boolean {
  // 网络错误(超时/重置)和不可解析页面(CQU 维护)不证明凭证坏 — 只有服务端 auth 拒绝才算。
  if (e instanceof CquSsoError) {
    return e.code === "NETWORK_ERROR" || e.code === "PARSE_ERROR";
  }
  return true; // 未知失败: 保守, 重试而非误判重登。
}

function errMsg(e: unknown): string {
  if (e instanceof CquSsoError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}
