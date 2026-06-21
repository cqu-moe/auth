import { DurableObject } from "cloudflare:workers";
import { CquSsoClient, type CasCookies, type CquStorageState, CquSsoError } from "../services/cqu-sso";
import { decrypt } from "../services/crypto";
import { validateCquServiceUrl } from "../services/service-url";
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
  classifyLoginFailure,
  shouldRequireReauth,
  nextKeepaliveDelayMs,
} from "../services/cqu-2fa/relogin-policy";
import {
  pruneStMintLog,
  stMintThrottled,
  distinctBroadHosts,
  type StMintRecord,
  ST_MINT_RATE_WINDOW_MS,
  MAX_ST_MINTS_PER_USER,
  MAX_ST_MINTS_PER_CLIENT,
  DISTINCT_HOST_ALERT_THRESHOLD,
} from "../services/st-mint-policy";
import { resolveCaps } from "../services/entitlements";
import { cquErrorHttpStatus } from "../services/cqu-error-status";
import {
  tgtFromState,
  hasValidTgt,
  classifyNodeTicketResponse,
  ticketFromClassification,
  sanitizeNodeDetail,
  NODE_DEADLINE_MS,
  type NodeTicketBody,
} from "../services/cqu-node-protocol";
import type { Env } from "../types";

// keepalive 每个探针经国内节点提取 1 个青果 IP(连 CQU 出站经青果)。频率直接决定青果消耗:
// 15min→96 个/天, 60min→24 个/天 —— 取 60min 省青果(单账号够用)。代价: 会话若在两次探针
// 间意外失效, 最长 ~60min 后才被探到并重登(期间 on-demand 取票会 TGT_EXPIRED)。TGT 绝对
// 寿命 ~8h 且 7h 处已主动重铸, 故 60min 足以兜住「正常过期」; 仅罕见「定点过期」窗口变长。
const KEEPALIVE_INTERVAL_MS = 60 * 60 * 1000;
const RETRY_INTERVAL_MS = 60 * 1000;
const MAX_FAST_RETRIES = 5;
// 熔断: transient(瑞数/网络)连续失败时 keepalive 退避封顶(从 KEEPALIVE_INTERVAL_MS 指数涨到 6h)。
const KEEPALIVE_MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
// TGT 绝对寿命 ~8h；在 7h 处主动重铸, 留 ~1h 余量给重登流程(容器点火 + 发码 + 邮件到达 + 提交)。
const PROACTIVE_RELOGIN_MS = 7 * 60 * 60 * 1000;
const DUMMY_SERVICE = "https://my.cqu.edu.cn/authserver/authentication/cas";

// Workers VPC binding(env.LOGIN_NODE)的内部占位 host。运行时由 VPC service 路由到
// 国内登录节点(container/server.py);host 内容不被校验, 仅作合法 URL 的占位(传输安全
// 由 VPC service 私有隧道保证, http:// scheme 仅为构造合法 Request 所需)。
// 「连 CQU」四处出站(/run /service-ticket /keepalive /code)均经此前缀发到国内节点
// (节点本地用青果代理连 CQU)。Phase 2 四处出站迁移已完成。
const LOGIN_NODE_BASE = "http://cqu-login.internal";

export const SERVICE_URLS: Record<string, string> = {
  jwxt: "https://my.cqu.edu.cn/authserver/authentication/cas",
  jxpj: "https://my.cqu.edu.cn/authserver/authentication/cas",
  library: "https://lib.cqu.edu.cn/cas/validate",
  card: "https://card.cqu.edu.cn/cas/validate",
};

interface SessionState {
  userId: string;
  studentId: string;
  storageState: CquStorageState | null;
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
  // DO 真实收到该码的时刻(ms, 原始值)。回放时原样发回, 作前端倒计时锚点 + 去重键,
  // 不能用 Date.now() 顶替, 否则倒计时锚点漂移且无法去重。
  ts: number;
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
  state?: CquStorageState;
  ticket?: string;
  error?: string;
}

// 暂存的绑定码 TTL: 绑定确认码实测后端有效期约 10min(邮件正文写的"2分钟"不准),
// 暂存兜底必须比它活得更久, 否则迟到/重连的浏览器回放到的是已被后端作废的码;
// 取 12min 留 ~2min 余量覆盖时钟漂移与 WS 重连窗口。
const PENDING_CODE_TTL_MS = 12 * 60 * 1000;

// 展示用有效期: 客户端倒计时基线 + 回放门槛(超此即死码, 不回放)。
// 注意它与 PENDING_CODE_TTL_MS 语义不同:
//   - CODE_VALIDITY_MS(10min) = 码对用户「可用/可展示」的有效期, 算 remainingMs 与回放门槛用;
//   - PENDING_CODE_TTL_MS(12min) = pendingCode 在 DO 里的暂存窗口, 比有效期多留 ~2min 余量
//     覆盖时钟漂移与 WS 重连。10min < 12min 是有意为之: 暂存还在但已超有效期的码不再回放。
const CODE_VALIDITY_MS = 10 * 60 * 1000;

// 服务端→客户端的码消息(live 广播 + 回放统一用此契约, 前端按此解析)。
// kind 映射: bind_confirm → "bind_code", login_2fa → "login_2fa"。
// ts = DO 真实收码时刻(原始值, 回放也发这个); remainingMs = 发送时现算的剩余有效期。
interface CodeMessage {
  type: "login_2fa" | "bind_code";
  code: string;
  ts: number;
  remainingMs: number;
}

function buildCodeMessage(
  kind: string,
  code: string,
  ts: number
): CodeMessage {
  return {
    type: kind === "bind_confirm" ? "bind_code" : "login_2fa",
    code,
    ts,
    remainingMs: Math.max(0, CODE_VALIDITY_MS - (Date.now() - ts)),
  };
}

export class CquSessionDO extends DurableObject<Env> {
  private state: SessionState | null = null;
  // 熔断: containerLogin 把本次失败原因(credential/transient)暂存于此, 供同一
  // relogin 调用链读取。DO 单线程, 仅在一次 alarm→relogin→containerLogin 链内有效。
  private lastLoginFailReason: "credential" | "transient" = "transient";
  // Phase 2 后已无调用方(登录/取票/keepalive 均改走 LOGIN_NODE 国内节点);仅作回滚窗口
  // 保留(应急可手改 DO 出站切回此直连路径), 随 CF 容器在 Phase 4 一并移除。
  private ssoClient = new CquSsoClient();

  private async loadState(): Promise<void> {
    if (!this.state) {
      this.state = (await this.ctx.storage.get<SessionState>("state")) ?? null;
    }
  }

  /**
   * #6 体量守卫后落 state。DO 单个 storage value 硬上限 128KiB; 完整 storageState 的 localStorage
   * 体量不受控, 越过上限 → ctx.storage.put 抛 → 会话静默卡死。put 前序列化测字节数, 超阈值
   * (STORAGE_STATE_WARN_BYTES=100KiB)打一条告警(只记字节数/studentId/cookie 数, **绝不含 state 内容**),
   * 让 observability 能在真撞墙前预警。仍照常 put(不裁剪 —— 裁剪非必需 origin 的 localStorage 复杂,
   * 留作后续; 当前最小实现只加告警, 见 PR 说明)。
   */
  private async putStateGuarded(state: SessionState): Promise<void> {
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(state)).length;
      if (bytes > STORAGE_STATE_WARN_BYTES) {
        console.error(
          `[CquSession] ${state.studentId}: ALERT storageState size ${bytes}B > ${STORAGE_STATE_WARN_BYTES}B (approaching DO 128KiB value limit; cookies=${state.storageState?.cookies.length ?? 0} origins=${state.storageState?.origins.length ?? 0})`
        );
      }
    } catch {
      // 体量探测失败绝不影响落盘主流程。
    }
    await this.ctx.storage.put("state", state);
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
      // keepalive: 客户端定期发字符串 "ping", 运行时直接回 "pong"。auto-response 在
      // 运行时层完成, 不唤醒 DO(不计 billable duration), 也不进 webSocketMessage 回调,
      // 故 JSON 码消息不受影响。setWebSocketAutoResponse 设的是整个 DO 的单一全局配对,
      // 幂等(重复调用只是覆盖为同一值), 每条新连接都走这条配置, 在此设置即可。
      this.ctx.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair("ping", "pong")
      );
      // 回放兜底: 码可能在浏览器 WS 连上(或重连)之前就到了, depositCode 的实时 send
      // 推给了零个 socket 而丢失。此处在 accept 后立刻读暂存的 pendingCode, 若仍在有效期内
      // 就按其 kind 主动补推给这条新连接, 让迟到/重连的浏览器立即收到:
      //   - bind_confirm → type:"bind_code"(绑定向导用)
      //   - login_2fa    → type:"login_2fa"(用户实时面板用)
      // ts 发 pending.ts 原始值(真实收码时刻), 让前端倒计时锚点正确 + 能据此去重;
      // 门槛用「仍在有效期内」(Date.now() - pending.ts < CODE_VALIDITY_MS)而非
      // expiresAt, 不回放已超 10min 展示有效期的死码(尽管暂存窗口 12min 还没到)。
      const pending =
        await this.ctx.storage.get<PendingCode>("pendingCode");
      if (
        pending &&
        (pending.kind === "bind_confirm" || pending.kind === "login_2fa") &&
        Date.now() - pending.ts < CODE_VALIDITY_MS
      ) {
        try {
          pair[1].send(
            JSON.stringify(
              buildCodeMessage(pending.kind, pending.code, pending.ts)
            )
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
          const serviceUrl = url.searchParams.get("serviceUrl");
          if (!service && !serviceUrl)
            return Response.json(
              { error: "Missing service or serviceUrl" },
              { status: 400 }
            );
          // clientId 空串(route 在无 azp/client_id 时传 "")按 null 处理 —— 自成限频桶。
          const clientId = url.searchParams.get("clientId") || null;
          // source 审计标签防伪:只认固定白名单(route/rpc), 其余(含缺失)归 "unknown",
          // 杜绝不受信调用方往审计日志 source 字段注入任意值(log-forging 防御纵深)。
          const rawSource = url.searchParams.get("source");
          const source =
            rawSource === "route" || rawSource === "rpc" ? rawSource : "unknown";
          const ticket = await this.getServiceTicket({
            service: service ?? undefined,
            serviceUrl: serviceUrl ?? undefined,
            clientId,
            source,
          });
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
        case "unrevoke": {
          await this.unrevoke();
          return Response.json({ success: true });
        }
        default:
          return Response.json({ error: "Unknown action" }, { status: 404 });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "Internal error";
      // 策略/客户端错误(CquSsoError)映射各自语义的 4xx(429/403/409/400),
      // 而非一律 500(伪装成服务器崩溃)。非 CquSsoError 仍回 500。
      const code = e instanceof CquSsoError ? e.code : "INTERNAL_ERROR";
      const status = e instanceof CquSsoError ? cquErrorHttpStatus(code) : 500;
      return Response.json({ error: message, code }, { status });
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
        storageState: null,
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

  // DO 是取票的权威 chokepoint(route/RPC/cookie 各入口最终都汇到这里)。
  // 不论上游是否已校验,凡 serviceUrl 输入此处都【无条件】再做 host 校验红线;
  // service(符号 key)走白名单表。解析出的 target 永远是受信 URL,绝不回传原始 input。
  //
  // 安全闸都落在此唯一 chokepoint(route / 未来 RPC getCquTicket / DO 内铸都汇于此;
  // betterAuth HTTP rateLimit 覆盖不到 RPC 与 DO 内铸):
  //   ① D5 opt-in:广路径(serviceUrl)取票要求 user 的 cqu.quicklogin = true(符号 key 不受此限);
  //   ② D6 限频:对所有取票(两模式)做 per-user + per-client 滑动窗口限频(StMintRecord 落 storage);
  //   ③ D6 告警:广路径上若窗口内不同 host 数越阈值则告警(开放重定向探测信号, 只告警不拦);
  //   ④ D6 审计:成功取票后打一条结构化日志(绝不含 ticket/cookies/密码)。
  // NOTE: keepalive 探针走国内节点 POST /keepalive(经 Workers VPC binding), 不经本方法(getServiceTicket)。
  // 但改造后探针在节点侧 navigate /login?service=PROBE **真在 CAS 铸一张可用 ST**(再丢弃),
  // 是新增的真实出票动作 —— 故 runKeepAlive 的 alive 成功路径已自行补「st_mint 审计 + 计入限流窗口」
  // (source:"keepalive", 见 recordKeepaliveMint), 让审计/限流覆盖 keepalive 的出票面(~24/账号/天)。
  // 区别: keepalive 是后台系统探活, **记账但豁免拒绝**(不调 stMintThrottled, 被限流挡掉会破坏会话保鲜)。
  private async getServiceTicket(arg: {
    service?: string;
    serviceUrl?: string;
    clientId?: string | null;
    source?: string;
  }): Promise<string> {
    await this.loadState();
    const status = await this.getStatus();
    if (!this.state || status !== "active") {
      // needs_reauth: 凭据真死(熔断终态), 区分于一般 SESSION_INACTIVE, 让前端提示重绑。
      if (status === "needs_reauth") {
        throw new CquSsoError("NEEDS_REAUTH", "CQU session needs re-auth (请重新绑定)");
      }
      throw new CquSsoError("SESSION_INACTIVE", "CQU session not active");
    }

    // 旧会话迁移守卫:改造前只存 3 cookie(无完整 storageState)。部署后这类 active 会话若
    // 直接取票会把 null state 发给节点 → 400 → 退避(不重登)。在此当作需重登而拒发,
    // 绝不向节点 POST null/undefined state;实际重登由 keepalive 的同款守卫驱动(见 runKeepAlive)。
    if (!this.state.storageState) {
      throw new CquSsoError(
        "SESSION_INACTIVE",
        "CQU session needs re-login (no storage state)"
      );
    }

    // ① 定模式 + 解析受信 target。broad = serviceUrl 模式(广路径快捷登录)。
    const broad = !!arg.serviceUrl;
    let target: string;
    if (arg.serviceUrl) {
      // 权威再校验(red line):即便 route 已校验,RPC/其他入口仍汇于此。
      // validateCquServiceUrl 抛的是普通 Error,会被 DO fetch catch 映射成
      // INTERNAL_ERROR(伪装成服务器崩溃);包成 CquSsoError 让 RPC getCquTicket
      // 与 route 都能回传准确的 INVALID_SERVICE_URL。
      try {
        target = validateCquServiceUrl(arg.serviceUrl);
      } catch {
        throw new CquSsoError("INVALID_SERVICE_URL", "非法的 serviceUrl");
      }
    } else if (arg.service) {
      const symbolic = SERVICE_URLS[arg.service];
      if (!symbolic) {
        throw new CquSsoError(
          "UNKNOWN_SERVICE",
          `Unknown service: ${arg.service}`
        );
      }
      target = symbolic;
    } else {
      throw new CquSsoError(
        "MISSING_SERVICE",
        "Missing service or serviceUrl"
      );
    }

    // ② D5 — 浏览器插件快捷登录 opt-in:仅广路径(serviceUrl)受限;符号 key 取票不受此闸。
    // quicklogin flag 永远不是「取票闸」本身(出票的权威校验在 host 校验 + scope),
    // 它只表达「用户是否同意插件替他用任意广路径取 ST」—— 未同意则广路径直接拒。
    if (broad) {
      const caps = await resolveCaps(this.env.DATABASE, this.state.userId, "cqu");
      if (caps.cqu?.quicklogin !== true) {
        throw new CquSsoError(
          "QUICKLOGIN_NOT_ENABLED",
          "未开启浏览器插件快捷登录"
        );
      }
    }

    // ③ D6 — 限频(所有取票, 两模式都过)。先读窗口内记录, 裁剪后判定 per-user/per-client 闸。
    const now = Date.now();
    const clientId = arg.clientId ?? null;
    const stored =
      (await this.ctx.storage.get<StMintRecord[]>("stMintLog")) ?? [];
    const pruned = pruneStMintLog(stored, now, ST_MINT_RATE_WINDOW_MS);
    if (
      stMintThrottled(
        pruned,
        clientId,
        MAX_ST_MINTS_PER_USER,
        MAX_ST_MINTS_PER_CLIENT
      )
    ) {
      console.error(
        `[CquSession] ${this.state.studentId}: ALERT ST mint rate-limited (clientId=${clientId ?? "?"})`
      );
      throw new CquSsoError("RATE_LIMITED", "取票过于频繁,请稍后再试");
    }

    // ④ D6 — distinct-host 告警(仅广路径):窗口内不同 broad host 数(含本次候选)越阈值即告警。
    // 只告警, 不抛 —— 它是「拿本服务当 ST 中继的开放重定向探测」信号, 不是硬错误。
    const host = new URL(target).hostname;
    if (broad && distinctBroadHosts(pruned, host) > DISTINCT_HOST_ALERT_THRESHOLD) {
      console.error(
        `[CquSession] ${this.state.studentId}: ALERT ST mint distinct broad hosts > ${DISTINCT_HOST_ALERT_THRESHOLD} in window (open-redirector probe signal, clientId=${clientId ?? "?"})`
      );
    }

    // ⑤ 记录本次尝试 + 铸票 + 审计。先把尝试落 storage(镜像 relogin() 的「铸前记录」),
    // 让限频对「铸票失败死循环」也鲁棒(失败也算一次尝试, 不会绕过窗口闸)。
    this.state.lastRequestedAt = now;
    await this.putStateGuarded(this.state);
    const record: StMintRecord = { ts: now, clientId, host, broad };
    pruned.push(record);
    await this.ctx.storage.put("stMintLog", pruned);

    const ticket = await this.mintServiceTicketViaNode(this.state.storageState, target);

    // D6 审计(结构化; CF observability 抓 console)。绝不记录 ticket / cookies / 密码。
    console.log(
      JSON.stringify({
        evt: "st_mint",
        userId: this.state.userId,
        clientId,
        host,
        broad,
        source: arg.source ?? "route",
        ts: now,
      })
    );
    return ticket;
  }

  /**
   * 闸后那一跳「换票」出站:经 Workers VPC binding 发到国内节点 POST /service-ticket,
   * 节点本地用青果代理去 CQU CAS 换 ST(并已对同青果 IP 做过瞬态退避重试)。
   * 取票四道闸仍在 getServiceTicket 上游, 这里只负责出站换票 + 把节点响应映射回
   * 既有 CquSsoError 语义, 让 route/RPC 调用方无感(与原 ssoClient.getServiceTicket 抛的码一致):
   *   · 200 {ok,ticket} → 返回 ticket
   *   · 409            → CquSsoError("TGT_EXPIRED")  真过期, 交重登(不重试)
   *   · 502 / 其它非 ok → CquSsoError("WAF_CHALLENGE") 瞬态(重试已在节点端做尽)
   */
  private async mintServiceTicketViaNode(
    state: CquStorageState | null,
    serviceUrl: string
  ): Promise<string> {
    let res: Response;
    try {
      res = await this.env.LOGIN_NODE.fetch(
        new Request(`${LOGIN_NODE_BASE}/service-ticket`, {
          method: "POST",
          body: JSON.stringify({ serviceUrl, state }),
          // 出站 deadline(NODE_DEADLINE_MS=90s, 略大于节点最坏 ~80s): 防节点 backlog 时
          // DO 被无限拖住(DO 单线程串行, 长 fetch 阻塞该用户后续请求)。超时归 transient。
          signal: AbortSignal.timeout(NODE_DEADLINE_MS),
        })
      );
    } catch (e) {
      // VPC/网络层异常 + AbortError(超时)= 瞬态(WAF_CHALLENGE), 让 DO 退避而非误判过期。
      throw new CquSsoError(
        "WAF_CHALLENGE",
        `LOGIN_NODE /service-ticket fetch failed: ${errMsg(e)}`
      );
    }
    // body 解析失败(非 JSON)传 null 给分类器 → transient。409 由分类器先于 body 判(语义最明确)。
    let body: NodeTicketBody | null;
    try {
      body = await res.json<NodeTicketBody>();
    } catch {
      body = null;
    }
    // 分类 + 抛既有 CquSsoError 语义全收敛到纯函数(409→TGT_EXPIRED, 其余/非 JSON/缺 ticket→WAF_CHALLENGE)。
    return ticketFromClassification(
      classifyNodeTicketResponse(res.status, body)
    );
  }

  /**
   * CF Email Routing 提码后投递点(见 src/email-handler.ts POST /deposit-code)。
   * 按 kind 分流:
   *   - login_2fa  : 无条件先把码暴露给用户实时面板(暂存 pendingCode + 广播 login_2fa),
   *                  再按是否有在途登录决定节点路径——有在途登录则推给国内节点 /code
   *                  (凭 loginInFlight.token 作 session 键路由), 无在途登录是用户手动登录的码,
   *                  已送达实时面板, 不再算丢码。
   *   - bind_confirm: 暂存 pendingCode(Phase 6 经 WS 秒推浏览器)。
   *
   * @returns delivered —— 码是否真正送达「容器路径」目标(决定调用方记 accepted 还是 code_dropped):
   *   - login_2fa  : 无在途登录 → true(已送达用户实时面板, 不算丢码);
   *                  有在途登录但无 session 状态(退化态) → false(码已广播无害, 但节点路径走不通);
   *                  有在途登录且推节点: 节点 /code 返回 ok → true, !res.ok/异常 → false。
   *                  即 code_dropped(false) 现专指「系统自动重登时容器收码失败/退化态」,
   *                  不再表示「码凭空丢弃」(码至少已广播给用户实时面板)。
   *   - bind_confirm: true(已落 pendingCode 兜底, 即便实时 WS 推送零接收方也不算丢)。
   *   - 未知 kind   : false。
   */
  private async depositCode(payload: DepositCodePayload): Promise<boolean> {
    await this.loadState();
    const { code, kind } = payload;

    if (kind === "login_2fa") {
      // 无条件副作用(不管在途与否, 先做): 把码暴露给用户实时面板。
      // 暂存 pendingCode 兜底(浏览器迟到/重连时由 fetch WS 升级分支回放), 再秒推所有已连接的
      // 浏览器(hibernatable WS), 写法复刻 bind_confirm 分支。
      const ts = Date.now();
      const pending: PendingCode = {
        code,
        kind,
        ts,
        expiresAt: ts + PENDING_CODE_TTL_MS,
      };
      await this.ctx.storage.put("pendingCode", pending);
      const message = JSON.stringify(buildCodeMessage(kind, code, ts));
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(message);
        } catch {
          // 忽略单个 socket 的发送失败, 不影响其它 socket 与暂存。
        }
      }

      const lock = await this.ctx.storage.get<LoginInFlight>("loginInFlight");
      if (!lock) {
        // 无在途登录 = 用户手动登录触发的码, 已送达上方实时面板。不再算丢码。
        console.info(
          `[CquSession] login_2fa code arrived with no login in flight → broadcast to user live panel`
        );
        return true;
      }
      const userId = this.state?.userId;
      if (!userId) {
        // 退化态: 有在途登录锁却无 session 状态, 节点路径走不通。码已广播无害, 但节点收码失败。
        console.warn(
          `[CquSession] login_2fa code arrived but no session state, ignoring`
        );
        return false;
      }
      try {
        // Phase 2: 2FA 码经 Workers VPC binding 推到国内登录节点 POST /code(凭 session=lock.token
        // 路由到在途 /run, 契约同容器, body 不变)。原 getLoginContainer(userId).fetch("https://c/code") 已弃用。
        const res = await this.env.LOGIN_NODE.fetch(
          new Request(`${LOGIN_NODE_BASE}/code`, {
            method: "POST",
            body: JSON.stringify({ session: lock.token, code }),
          })
        );
        if (!res.ok) {
          console.error(
            `[CquSession] LOGIN_NODE /code returned non-ok status=${res.status}`
          );
          return false;
        }
        return true;
      } catch (e) {
        console.error(
          `[CquSession] failed to push login_2fa code to LOGIN_NODE: ${errMsg(e)}`
        );
        return false;
      }
    }

    if (kind === "bind_confirm") {
      // 暂存: 浏览器若连接略晚(WS 还没建好), 仍能事后读到(Task 6.2 加读路径)。
      const ts = Date.now();
      const pending: PendingCode = {
        code,
        kind,
        ts,
        expiresAt: ts + PENDING_CODE_TTL_MS,
      };
      await this.ctx.storage.put("pendingCode", pending);
      // 秒推所有已连接的浏览器(hibernatable WS)。send 失败(连接已断/正在关闭)忽略,
      // pendingCode 兜底。
      const message = JSON.stringify(buildCodeMessage(kind, code, ts));
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(message);
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
    // 刻意直写 setStatus("revoked") 而非走 nextStatus 状态机: 撤销要从任意状态(含空/
    // unbound 的 DO, admin 端点对未初始化的 DO 也会发 revoke)强制置位; 状态机表里
    // unbound 无 REVOKE 转移, 走表会停在 unbound 而漏置墓碑。勿"修回"成走表。
    await this.setStatus("revoked");
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.delete("loginInFlight");
  }

  /**
   * 解除吊销(恢复): revoke 的逆操作 —— 把被吊销的会话拉回保活循环。
   *   ① status → expired: alarm() 对 revoked/unbound 早退, 但对 expired 不早退,
   *      会照常跑保活探针 —— 旧 cookie 还活就探回 active, 真过期则用保留的 credentials
   *      容器重登铸新 TGT。置成 expired 而非直接 active, 是因为吊销期间 TGT 可能已自然失效,
   *      让 alarm 的探针去判定实际状态, 而不是谎报 active。
   *   ② setAlarm(now): 立即触发一次 alarm, 不等下个 keepalive 周期才恢复。
   * 不 deleteAll、不清 credentials/state —— 恢复正要靠这些保留的容器凭证与会话快照。
   * 复用现有 alarm/relogin 路径, 不改其逻辑。
   */
  private async unrevoke(): Promise<void> {
    // 刻意直写 setStatus("expired") 而非走 nextStatus 状态机: 解除吊销要从任意状态(含
    // 空/unbound 的 DO)强制置位让 alarm 探针接管; 状态机表里没有从 revoked/unbound 出发的
    // UNREVOKE 转移, 走表会停在原态而无法恢复保活循环。勿"修回"成走表。
    await this.setStatus("expired");
    await this.ctx.storage.setAlarm(Date.now());
  }

  async alarm(): Promise<void> {
    await this.loadState();
    if (!this.state) return;
    const status = await this.getStatus();
    // 已撤销/未绑定的会话不再保活。
    if (
      status === "revoked" ||
      status === "unbound" ||
      status === "needs_reauth"
    )
      return;

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
      // 熔断: relogin 若落 needs_reauth(连续凭据失败), 停止保活、不再重排(等用户重绑)。
      if ((await this.getStatus()) === "needs_reauth") {
        console.error(
          `[CquSession] ${this.state.studentId}: keepalive halted — needs_reauth`
        );
        return;
      }
      // relogin 内部已更新状态; 重新排 alarm 继续保活循环。
      await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_INTERVAL_MS);
      return;
    }

    const outcome = await this.runKeepAlive();

    if (outcome === "active") {
      await this.setStatus("active");
      this.state.lastKeepAlive = Date.now();
      this.state.consecutiveFailures = 0;
      // #6 落盘前体量守卫(此处可能携 keepalive 刚回写的刷新 state, localStorage 体量不受控)。
      await this.putStateGuarded(this.state);
      // 探针自愈回 active 也打断「连续重登失败」链, 避免遗留的 reloginFailures
      // 误触告警; 同时清零熔断的「连续凭据失败」计数(会话已证实健康)。
      await this.ctx.storage.put("reloginFailures", 0);
      await this.ctx.storage.put("credentialFailures", 0);
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
      await this.putStateGuarded(this.state);
      // 熔断: relogin 若落 needs_reauth(连续凭据失败), 停止保活、不再重排(等用户重绑)。
      if ((await this.getStatus()) === "needs_reauth") {
        console.error(
          `[CquSession] ${this.state.studentId}: keepalive halted — needs_reauth`
        );
        return;
      }
      await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_INTERVAL_MS);
      return;
    }

    // outcome === "transient": 够不到 CQU SSO。CAS 会话服务端几乎肯定还有效,
    // 保留 cookies/status 不动, 快重试而非误判重登。连续失败时指数退避(封顶 6h),
    // 止住刷屏 + 降瑞数风控, 但仍会自愈(可达即回 active)。
    this.state.consecutiveFailures = (this.state.consecutiveFailures ?? 0) + 1;
    const delay = nextKeepaliveDelayMs(this.state.consecutiveFailures, {
      fastRetries: MAX_FAST_RETRIES,
      fastMs: RETRY_INTERVAL_MS,
      baseMs: KEEPALIVE_INTERVAL_MS,
      capMs: KEEPALIVE_MAX_BACKOFF_MS,
    });
    console.warn(
      `[CquSession] ${this.state.studentId}: keepalive unreachable (attempt #${this.state.consecutiveFailures}), keeping session, retrying in ${delay}ms`
    );
    await this.putStateGuarded(this.state);
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
    // 旧会话迁移守卫:改造前只存 3 cookie(无完整 storageState)。报 expired 让 alarm 触发重登,
    // 铸一套新的完整 storageState 自愈;绝不把 null state 发给节点(否则 400 → 永远退避不重登)。
    if (!state.storageState) {
      console.warn(
        `[CquSession] ${state.studentId}: no storageState (legacy session), forcing relogin`
      );
      return "expired";
    }
    // 探活经 Workers VPC binding 发到国内节点 POST /keepalive(节点本地经青果探测 CQU 会话)。
    // 节点恒返回 200 {ok, status: alive|expired|unreachable}, 映射回三态:
    //   alive→active / expired→expired / unreachable→transient。
    // 够不到节点本身(VPC/网络抛错、非 JSON、非 ok)或未知 status = 探不通 → transient
    // (保 cookies/status 不动、退避重试), 绝不误判过期触发容器重登。
    let res: Response;
    try {
      res = await this.env.LOGIN_NODE.fetch(
        new Request(`${LOGIN_NODE_BASE}/keepalive`, {
          method: "POST",
          body: JSON.stringify({ state: state.storageState }),
          // 出站 deadline(同取票路径, 90s 略大于节点最坏 ~80s): 探活也在节点侧排队持槽,
          // 无超时则节点 backlog 时阻塞 DO 单线程。超时/AbortError 归 transient(退避不误判过期)。
          signal: AbortSignal.timeout(NODE_DEADLINE_MS),
        })
      );
    } catch (e) {
      console.warn(
        `[CquSession] ${state.studentId}: probe unreachable (node fetch failed): ${errMsg(e)}`
      );
      return "transient";
    }
    let body: { ok?: boolean; status?: string; detail?: string; state?: CquStorageState };
    try {
      body = await res.json();
    } catch {
      console.warn(
        `[CquSession] ${state.studentId}: probe unreachable (node non-JSON status=${res.status})`
      );
      return "transient";
    }
    if (!res.ok || !body.ok) {
      console.warn(
        `[CquSession] ${state.studentId}: probe unreachable (node not ok status=${res.status} detail=${sanitizeNodeDetail(body.detail)})`
      );
      return "transient";
    }
    if (body.status === "alive") {
      // #1 探针在节点侧 navigate /login?service=PROBE 真铸了一张 ST(再丢弃) —— 把这次出票
      // 记入 st_mint 审计 + 限流窗口(记账但豁免拒绝, 见 recordKeepaliveMint)。await 落盘后才回写,
      // 顺序无关(两者各写不同 storage key)。
      await this.recordKeepaliveMint();
      // #2 回写校验: 仅当节点刷新后的 state 含非空 SOURCEID_TGC(TGT)才覆盖, 否则保留旧 state。
      // 节点导出的 refreshed state 可能半截/退化(如 {cookies:[],origins:[]} 空但 truthy), 无 TGT
      // 顶替好 state 会让下轮取票 storageState 非 null 却无 TGT → 落登录页 409 → 误判过期重登。
      // 因 state===this.state, alarm() 的 active 分支会 ctx.storage.put("state", this.state) 落盘
      // (落盘前由 putStateGuarded 做 128KiB 体量守卫, 见 alarm)。
      if (body.state) {
        if (hasValidTgt(body.state)) {
          state.storageState = body.state;
        } else {
          console.warn(
            `[CquSession] ${state.studentId}: probe alive but refreshed state lacks SOURCEID_TGC, keeping old storageState`
          );
        }
      }
      return "active";
    }
    if (body.status === "expired") {
      console.warn(
        `[CquSession] ${state.studentId}: probe says expired: ${sanitizeNodeDetail(body.detail)}`
      );
      return "expired";
    }
    // "unreachable" 或未知 status → 保会话退避。
    console.warn(
      `[CquSession] ${state.studentId}: probe unreachable: status=${body.status ?? "(none)"} detail=${sanitizeNodeDetail(body.detail)}`
    );
    return "transient";
  }

  /**
   * #1 keepalive 铸票纳审计+限流(记账但豁免拒绝)。
   *
   * 探针在节点侧 navigate /login?service=PROBE 真在 CAS 铸一张可用 ST(再丢弃), 是新增的真实
   * 出票动作 —— 故与 getServiceTicket 一致打一条 st_mint 风格审计日志(source:"keepalive"),
   * 并把这次铸票计入 per-user 限流窗口(StMintRecord 落 stMintLog), 让审计/限流统计涵盖
   * keepalive 的出票量(~24/账号/天)。
   *
   * 关键: keepalive 是后台系统探活, **记账但豁免拒绝** —— 只追加 StMintRecord(不调 stMintThrottled,
   * 被限流挡掉会破坏会话保鲜)。clientId 用专属哨兵 "__keepalive__" 自成桶, 不挤占用户/插件的
   * per-client 配额; host 取 PROBE 目标 host; broad=false(符号路径探针, 不计入 distinct-broad 告警)。
   * 绝不记录 ticket / cookies / state。
   */
  private async recordKeepaliveMint(): Promise<void> {
    const st = this.state;
    if (!st) return;
    const now = Date.now();
    const host = new URL(DUMMY_SERVICE).hostname;
    const stored =
      (await this.ctx.storage.get<StMintRecord[]>("stMintLog")) ?? [];
    const pruned = pruneStMintLog(stored, now, ST_MINT_RATE_WINDOW_MS);
    // 记账但豁免拒绝: 直接追加, 不调 stMintThrottled。哨兵 clientId 自成桶, 不挤占真实配额。
    pruned.push({ ts: now, clientId: "__keepalive__", host, broad: false });
    await this.ctx.storage.put("stMintLog", pruned);
    // 审计(结构化, 与取票同 schema; source:"keepalive")。绝不含 ticket/cookies/密码。
    console.log(
      JSON.stringify({
        evt: "st_mint",
        userId: st.userId,
        clientId: "__keepalive__",
        host,
        broad: false,
        source: "keepalive",
        ts: now,
      })
    );
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
      const reason = this.lastLoginFailReason;
      console.error(`[CquSession] ${studentId}: relogin failed (reason=${reason})`);
      // 连续重登失败计数自增 + 持久化(通用告警, 不分原因)。
      const failures =
        ((await this.ctx.storage.get<number>("reloginFailures")) ?? 0) + 1;
      await this.ctx.storage.put("reloginFailures", failures);

      // 熔断(混合): 仅「凭据」失败累计 —— 达阈值落 needs_reauth 终态(凭据真死, 停保活,
      // 等用户重绑)。「瑞数/瞬态」失败不累计, 交 keepalive 退避自愈, 绝不误杀。
      if (reason === "credential") {
        const credFails =
          ((await this.ctx.storage.get<number>("credentialFailures")) ?? 0) + 1;
        await this.ctx.storage.put("credentialFailures", credFails);
        if (shouldRequireReauth(credFails)) {
          const status = await this.getStatus();
          await this.setStatus(nextStatus(status, "REAUTH_REQUIRED"));
          console.error(
            `[CquSession] ${studentId}: ALERT circuit broken — ${credFails} consecutive CREDENTIAL failures → needs_reauth (疑似改密, 需用户重绑)`
          );
          return;
        }
      }

      if (failures >= CONSECUTIVE_RELOGIN_FAIL_ALERT) {
        console.error(
          `[CquSession] ${studentId}: ALERT ${failures} consecutive relogin failures — session likely broken (密码改了/转发断了/瑞数变更)`
        );
      }
      return;
    }
    // outcome === "ok": 重登成功, 新 TGT 已铸 —— 重置连续失败 + 连续凭据失败计数。warn 级
    // 以便在 observability 可见(info 级实测在当前配置下不可见; 重登成功此前无任何日志, 是观测盲区)。
    await this.ctx.storage.put("reloginFailures", 0);
    await this.ctx.storage.put("credentialFailures", 0);
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
      // Phase 2: 经 Workers VPC binding 发到国内登录节点 POST /run(契约同容器, body 不变 ——
      // 青果提取在节点本地)。原 getLoginContainer(...).fetch("https://c/run") 已弃用。
      const res = await this.env.LOGIN_NODE.fetch(
        new Request(`${LOGIN_NODE_BASE}/run`, {
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
      if (!res.ok || !result.ok || !result.state) {
        console.warn(
          `[CquSession] ${state.studentId}: container /run not ok — httpStatus=${res.status} ok=${result.ok} hasState=${!!result.state} error=${result.error ?? "(none)"}`
        );
        // 熔断: 把失败归类(凭据真死 vs 瑞数/瞬态)暂存, 供 relogin 决定是否落 needs_reauth。
        this.lastLoginFailReason = classifyLoginFailure(result.error);
        await this.failLogin(failEvent);
        return "failed";
      }

      // I2: /run 阻塞期间(可达 ~5min)其它请求(如 getServiceTicket)可能已更新过
      // state.lastRequestedAt 并落盘。不要用 await 之前抓取的快照整盘覆盖, 而是
      // 重读最新 state 后只改 cookie/loginAt/lastKeepAlive 这几个本次登录拥有的字段。
      const latest =
        (await this.ctx.storage.get<SessionState>("state")) ?? state;
      const now = Date.now();
      // #5 按当前 SessionState 接口显式重建干净对象, 不携带任何已废弃字段(3-cookie 时代的
      // `tgt`/`cookies` 等残留键)—— 旧重登只覆盖 storageState、漏清 legacy `tgt`, 会留脏数据落盘。
      // 仅本次登录拥有的字段(storageState/loginAt/lastKeepAlive)取新值, 其余沿用最新落盘态。
      const fresh: SessionState = {
        userId: latest.userId,
        studentId: latest.studentId,
        storageState: result.state,
        objectId: latest.objectId,
        tgt: "", // 已废弃: 改造后 TGT 在 storageState.cookies 内, 顶层字段恒清空。
        loginAt: now,
        lastKeepAlive: now,
        lastRequestedAt: latest.lastRequestedAt,
        consecutiveFailures: latest.consecutiveFailures ?? 0,
      };
      this.state = fresh;
      // 诊断: 尽力解出新 TGT(SOURCEID_TGC, JWT) 的 exp, 观测其服务端寿命, 排查
      // 会话疑似「定点过期」(按固定时刻而非固定时长)。绝不记录 token 本身, 只记
      // exp 时刻与剩余分钟数。decodeJwtExp 纯函数不抛, 再用 try/catch 兜底, 确保
      // 诊断绝不影响登录。
      try {
        const exp = decodeJwtExp(tgtFromState(result.state));
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
      await this.putStateGuarded(fresh);
      const status = await this.getStatus();
      await this.setStatus(nextStatus(status, okEvent));
      await this.ctx.storage.delete("loginInFlight");
      return "ok";
    } catch (e) {
      console.error(
        `[CquSession] ${state.studentId}: container login error: ${errMsg(e)}`
      );
      // 容器/网络层异常 = 瞬态, 不当凭据死(不累计熔断)。
      this.lastLoginFailReason = "transient";
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

  // Phase 2 后已无调用方(2FA 投码已改走 LOGIN_NODE 国内节点 /code);仅作回滚窗口保留 ——
  // 它是 CQU_LOGIN 容器 binding 的访问器, 随容器在 Phase 4 一并移除。
  /** 取该用户的浏览器登录器容器实例(寻址镜像 CQU_SESSION: idFromName → get)。 */
  private getLoginContainer(userId: string): DurableObjectStub {
    const id = this.env.CQU_LOGIN.idFromName(userId);
    return this.env.CQU_LOGIN.get(id);
  }
}

function errMsg(e: unknown): string {
  if (e instanceof CquSsoError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

// storageState 落盘体量守卫阈值。DO 单个 storage value 硬上限 128KiB; 完整 storageState
// (12 cookie + 2 origin localStorage)体量不受控, localStorage 膨胀越过上限 → ctx.storage.put
// 抛 → 会话静默卡死。100KiB 留 ~28KiB 余量, 超阈值打告警(不含 state 内容)。
const STORAGE_STATE_WARN_BYTES = 100 * 1024;
