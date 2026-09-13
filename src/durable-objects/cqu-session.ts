import { DurableObject } from "cloudflare:workers";
import { CquSsoClient, type CasCookies, type CquStorageState, CquSsoError } from "../services/cqu-sso";
import { decrypt } from "../services/crypto";
import { validateCquServiceUrl } from "../services/service-url";
import {
  validateCquHarvestRecipeHosts,
  validateCquHarvestUrl,
} from "../services/harvest-url";
import {
  nextStatus,
  type CquStatus,
  type CquEvent,
} from "../services/cqu-2fa/state-machine";
import {
  LOGIN_LOCK_TTL_MS,
  shouldStartLogin,
} from "../services/cqu-2fa/single-flight";
import {
  type BrowserRoute,
  type LoginRouteRecord,
} from "../services/cqu-browser-routing";
import {
  acquireCodeLease,
  pruneCodeLease,
  resolveControlRoute,
  releaseCodeLease,
  type CodeLease,
  type LoginKind,
} from "../services/cqu-2fa/code-lease";
import { fetchBrowser } from "../services/cqu-browser-routing";
import {
  BROWSER_CLEANUP_MARGIN_MS,
  CONTAINER_BROWSER_DEADLINE_MS,
  remainingBrowserBudget,
  resolveBrowserDeadline,
} from "../services/cqu-browser-budget";
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
  serializedStateBytes,
  stateExceedsHardLimit,
  STORAGE_STATE_WARN_BYTES,
  STATE_HARD_LIMIT_BYTES,
  shouldAbandonKeepaliveWriteback,
  buildStMintAudit,
  classifyNodeHarvestResponse,
  type NodeTicketBody,
  type NodeHarvestBody,
  type HarvestCapture,
  type HarvestFetch,
} from "../services/cqu-node-protocol";
import type { Env } from "../types";
import type {
  DeviceLoginRequest,
  DeviceLoginResult,
} from "../services/quicklogin/contracts";
import { quickloginBrowserRoute } from "../services/quicklogin/browser-routing";
import { QuickloginAccountClient } from "../services/quicklogin/account-client";
import { quickloginDeviceModeEnabled } from "../services/quicklogin/mode";

// keepalive 每个探针经国内节点提取 1 个青果 IP(连 CQU 出站经青果)。频率直接决定青果消耗:
// 15min→96 个/天, 60min→24 个/天 —— 取 60min 省青果(单账号够用)。代价: 会话若在两次探针
// 间意外失效, 最长 ~60min 后才被探到并重登(期间 on-demand 取票会 TGT_EXPIRED)。TGT 绝对
// 寿命 ~8h 且 7h 处已主动重铸, 故 60min 足以兜住「正常过期」; 仅罕见「定点过期」窗口变长。
const KEEPALIVE_INTERVAL_MS = 60 * 60 * 1000;
const RETRY_INTERVAL_MS = 60 * 1000;
const MAX_FAST_RETRIES = 5;
// keepalive 探活铸票的审计/限流身份: 专属哨兵 clientId 自成桶(不挤占真实 per-client 配额), source 标 keepalive。
// 限流桶 key 与审计 key 共用同一常量, 杜绝改一处漏一处导致桶/审计错配。
const KEEPALIVE_CLIENT_ID = "__keepalive__";
const KEEPALIVE_SOURCE = "keepalive";
const QUICKLOGIN_MINT_RECEIPTS_KEY = "quickloginMintReceipts";
const QUICKLOGIN_MINT_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_QUICKLOGIN_MINT_RECEIPTS = 64;
// 熔断: transient(瑞数/网络)连续失败时 keepalive 退避封顶(从 KEEPALIVE_INTERVAL_MS 指数涨到 6h)。
const KEEPALIVE_MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
// TGT 绝对寿命 ~8h；在 7h 处主动重铸, 留 ~1h 余量给重登流程(容器点火 + 发码 + 邮件到达 + 提交)。
const PROACTIVE_RELOGIN_MS = 7 * 60 * 60 * 1000;
const DUMMY_SERVICE = "https://my.cqu.edu.cn/authserver/authentication/cas";

// CF 容器 stub 的占位 host。所有浏览器出站(/run /service-ticket /keepalive /code
// /data-harvest)经 DO 容器 stub fetch 转发,host 内容不被校验,
// 仅作构造合法 Request 的占位(http:// scheme 仅为 URL 合法所需; 真实目标由
// env.CQU_LOGIN.get(id).fetch 覆盖)。腾讯云节点绑定已随 2026-09-09 清理移除。
const BROWSER_BASE = "http://cqu-login.internal";
// Cloudflare 登录路由预热预算:容器冷启动 + health 就绪,最多 30s。
const LOGIN_ROUTE_PREPARE_BUDGET_MS = 30_000;
// 单次 health 请求超时(冷启动握手交给 SDK,这里只防单次请求悬挂)。
const LOGIN_ROUTE_HEALTH_TIMEOUT_MS = 10_000;

// 集中 transport 抛出的稳定浏览器错误码:必须原样透传,不得包装成 WAF_CHALLENGE。
const STABLE_BROWSER_CODES = new Set([
  "BROWSER_BUSY",
  "BROWSER_INSTANCE_REPLACED",
  "BROWSER_DEADLINE",
]);

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
  /** 新格式:该锁与 browserRoute:<token> 持久记录成对出现(部署前旧锁无此字段)。 */
  browserRouteVersion?: 1;
}

interface QuickloginLoginInFlight extends LoginInFlight {
  deviceId: string;
  generation: number;
  bindingEpoch: number;
}

interface QuickloginCachedLoginResult {
  result: Extract<DeviceLoginResult, { kind: "success" }>;
  expiresAt: number;
}

interface QuickloginMintReceipt {
  operationId: string;
  expiresAt: number;
}

// 绑定确认码暂存(kind=bind_confirm)。Phase 6 经 WS 推浏览器后清除。
interface PendingCode {
  code: string;
  kind: string;
  // permit 已送到节点但 DO 尚未提交 owner 时到达的邮件，定向缓冲给该 token。
  ownerToken?: string;
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

// 登录 token 的持久 route 记录键前缀:锁删除后投码/outbox 恢复仍按它寻址。
const BROWSER_ROUTE_PREFIX = "browserRoute:";

export class CquSessionDO extends DurableObject<Env> {
  private state: SessionState | null = null;
  // 熔断: containerLogin 把本次失败原因(credential/transient)暂存于此, 供同一
  // relogin 调用链读取。DO 单线程, 仅在一次 alarm→relogin→containerLogin 链内有效。
  private lastLoginFailReason: "credential" | "transient" = "transient";
  // 全部浏览器出站均经 CF 容器 stub;此直连客户端仅作历史回滚窗口保留。
  private ssoClient = new CquSsoClient();
  private quickloginFlights = new Map<string, Promise<DeviceLoginResult>>();
  private retiredAtrustCleanupComplete = false;
  private activationPermitRecoveryComplete = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      try {
        await this.removeRetiredAtrustState();
      } catch (error) {
        console.warn(
          `[CquSession] retired aTrust state cleanup deferred (${error instanceof Error ? error.name : "unknown"})`
        );
      }
      // `codePermitPending` is a durable outbox marker. Replaying the same token
      // is idempotent, so recovery can finish an acknowledgement without handing
      // the shared channel to a second owner.
      if (this.retiredAtrustCleanupComplete) {
        try {
          await this.recoverPendingCodePermit();
          this.activationPermitRecoveryComplete = true;
        } catch (error) {
          console.warn(
            `[CquSession] pending code permit recovery deferred (${error instanceof Error ? error.name : "unknown"})`
          );
        }
      }
    });
  }

  private async loadState(): Promise<void> {
    if (!this.state) {
      this.state = (await this.ctx.storage.get<SessionState>("state")) ?? null;
    }
  }

  /**
   * H2 真守卫: 体量校验后落 state, **绝不抛穿调用方**(尤其 alarm —— 抛 → CF 自动重试 →
   * 重走 active 分支 → keepalive 又真铸 ST + 又记账 → 重复铸票环 + state 永远写不进)。
   *
   * 告警阈值(STORAGE_STATE_WARN_BYTES=100KiB)与硬上限(STATE_HARD_LIMIT_BYTES=120KiB, <DO
   * 物理 128KiB)分离, 日志级别也随之分级:
   *   · 超告警阈值但未超硬上限 → 照常 put 成功, 仅打 **console.warn** approaching-limit 预警
   *     (可恢复, 不含 state 内容), 与下面真超限/抛错的 error 级区分;
   *   · 超硬上限(或不可序列化)→ **拒 put**(put 必抛), 打 **console.error** ALERT 并返回 false 让调用方降级
   *     (keepalive/relogin 回写: 丢弃刷新态、保留旧 state; 热路径取票: 不 500, 已 mint 的票照返);
   *   · put 本身意外抛(理论上不应)→ **console.error** + catch 吞掉 + 返回 false, 同样不冒泡。
   *
   * @returns true = state 已落盘; false = 因超限/异常未落盘(调用方应保留旧态并排下次 alarm)。
   */
  private async putStateGuarded(state: SessionState): Promise<boolean> {
    const bytes = serializedStateBytes(state);
    if (stateExceedsHardLimit(bytes)) {
      console.error(
        `[CquSession] ${state.studentId}: ALERT storageState size ${bytes}B exceeds DO hard limit (${STATE_HARD_LIMIT_BYTES}B); SKIPPING put, keeping previous on-disk state (cookies=${state.storageState?.cookies.length ?? 0} origins=${state.storageState?.origins.length ?? 0})`
      );
      return false;
    }
    if (bytes > STORAGE_STATE_WARN_BYTES) {
      // 预警级(WARN): 接近阈值但仍 ≤ 硬上限, 本次照常 put 成功 —— 用 console.warn 与真超限/抛错
      // (console.error/ALERT)区分日志级别, 避免可恢复的预警淹没在 error 流里。
      console.warn(
        `[CquSession] ${state.studentId}: WARN storageState size ${bytes}B > ${STORAGE_STATE_WARN_BYTES}B (approaching DO 128KiB value limit; cookies=${state.storageState?.cookies.length ?? 0} origins=${state.storageState?.origins.length ?? 0})`
      );
    }
    try {
      await this.ctx.storage.put("state", state);
      return true;
    } catch (e) {
      // put 仍抛(超出我方硬上限估算的平台限制/瞬态)→ 绝不冒泡到 alarm。降级保旧态。
      console.error(
        `[CquSession] ${state.studentId}: storage.put(state) failed, keeping previous on-disk state: ${errMsg(e)}`
      );
      return false;
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

    if (!this.retiredAtrustCleanupComplete) {
      try {
        await this.removeRetiredAtrustState();
      } catch (error) {
        console.warn(
          `[CquSession] retired aTrust state cleanup retry failed (${error instanceof Error ? error.name : "unknown"})`
        );
        return Response.json(
          { error: "Retired session state cleanup failed", code: "INTERNAL_ERROR" },
          { status: 503 }
        );
      }
    }
    if (
      this.retiredAtrustCleanupComplete &&
      !this.activationPermitRecoveryComplete
    ) {
      try {
        await this.recoverPendingCodePermit();
        this.activationPermitRecoveryComplete = true;
      } catch (error) {
        console.warn(
          `[CquSession] pending code permit retry recovery deferred (${error instanceof Error ? error.name : "unknown"})`
        );
      }
    }

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
          await this.bumpQuickloginBindingEpoch(body.userId);
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
        case "data-harvest": {
          const clientId = url.searchParams.get("clientId") || null;
          const rawSource = url.searchParams.get("source");
          const source =
            rawSource === "route" || rawSource === "rpc" ? rawSource : "unknown";
          const recipe = await request.json<{
            navUrl: string;
            capture: string[];
            fetch: { method?: string; url: string }[];
            deadlineAt?: number;
          }>();
          const result = await this.dataHarvest({
            recipe,
            clientId,
            source,
            deadlineAt: recipe.deadlineAt,
          });
          return Response.json(result);
        }
        case "quicklogin-login": {
          const body = await request.json<DeviceLoginRequest>();
          return Response.json(await this.quickloginLogin(body));
        }
        case "quicklogin-binding": {
          return Response.json(await this.getQuickloginBindingEpoch());
        }
        case "quicklogin-keepalive-mint": {
          const body = await request.json<{
            deviceId: string;
            operationId: string;
            mintedAt: number;
          }>();
          await this.recordQuickloginKeepaliveMint(body);
          return Response.json({ success: true });
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
    // 绝不向节点 POST null/undefined state(本就没发, 保持)。
    // M8 加速自愈: 抛 SESSION_INACTIVE 前顺手 setStatus("expired") + setAlarm(now)(复刻
    // unrevoke 的现成模式), 把退化窗口从「最坏 ≤1 keepalive 周期/退避 ~6h」压到下次 alarm tick
    // 立即触发容器重登铸完整 storageState。仍绝不把旧 3-cookie 当 storageState 发节点。
    if (!this.state.storageState) {
      await this.setStatus("expired");
      await this.ctx.storage.setAlarm(Date.now());
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
      const deviceMode = quickloginDeviceModeEnabled(this.env);
      const enabled = deviceMode
        ? await new QuickloginAccountClient(this.env)
          .getQuickloginTicketEligibility(this.state.userId)
          .then((policy) => policy.masterEnabled && policy.deviceLimit > 0)
        : await resolveCaps(this.env.DATABASE, this.state.userId, "cqu")
          .then((caps) =>
            caps.cqu?.quicklogin_access === true &&
            caps.cqu?.quicklogin === true
          );
      if (!enabled) {
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
    // H2 热路径降级: putStateGuarded 超限/抛错只返回 false(不 500); stMintLog put 失败也只
    // 告警吞掉(限频记账尽力而为, 失败不阻断本次取票)。两者都不让取票热路径因落盘失败而 500。
    this.state.lastRequestedAt = now;
    await this.putStateGuarded(this.state);
    const record: StMintRecord = { ts: now, clientId, host, broad };
    pruned.push(record);
    try {
      await this.ctx.storage.put("stMintLog", pruned);
    } catch (e) {
      console.error(
        `[CquSession] ${this.state.studentId}: stMintLog put failed (rate-limit accounting degraded, ticket still served): ${errMsg(e)}`
      );
    }

    // H4 快自愈: 铸票遇节点 409 → mintServiceTicketViaNode 抛 CquSsoError("TGT_EXPIRED")。
    // catch 它顺手 setAlarm(now) 把下轮 keepalive/relogin 提前(复用 relogin single-flight,
    // **绝不在热路径同步重登** —— 同步重登走容器含 2FA 邮件往返数分钟会阻塞 DO 单线程),
    // 然后 re-throw 让外层把 409(TGT_EXPIRED)原样回给调用方(语义不变, 只顺手排了快自愈)。
    // 刻意**不**在此 setStatus("expired"): 节点 409 是服务端权威过期, 异步 relogin 会翻 status;
    // 与 M8 legacy(本地 storageState===null 的已知坏态)主动标 expired 不同 —— 别为"对称"补 setStatus。
    let ticket: string;
    try {
      ticket = await this.mintServiceTicketViaBrowser(
        this.state.storageState,
        target
      );
    } catch (e) {
      if (e instanceof CquSsoError && e.code === "TGT_EXPIRED") {
        await this.ctx.storage.setAlarm(Date.now());
      }
      throw e;
    }

    // D6 审计(结构化; CF observability 抓 console)。绝不记录 ticket / cookies / 密码。
    // 审计行经 buildStMintAudit 构造(三处共用, 杜绝 schema 漂移, 见 cqu-node-protocol.ts)。
    console.log(
      JSON.stringify(
        buildStMintAudit({
          userId: this.state.userId,
          clientId,
          host,
          broad,
          source: arg.source ?? "route",
          ts: now,
        })
      )
    );
    return ticket;
  }

  /**
   * 闸后那一跳「换票」出站:集中 transport(node→国内节点;CF→该用户 APAC 容器)。
   * 取票四道闸仍在 getServiceTicket 上游, 这里只负责出站换票 + 把节点响应映射回
   * 既有 CquSsoError 语义, 让 route/RPC 调用方无感(与原 ssoClient.getServiceTicket 抛的码一致):
   *   · 200 {ok,ticket} → 返回 ticket
   *   · 409            → CquSsoError("TGT_EXPIRED")  真过期, 交重登(不重试)
   *   · 502 / 其它非 ok → CquSsoError("WAF_CHALLENGE") 瞬态(重试已在节点端做尽)
   */
  private async mintServiceTicketViaBrowser(
    state: CquStorageState | null,
    serviceUrl: string,
    deadlineAt?: number
  ): Promise<string> {
    const route = this.currentBrowserRoute();
    const budget = this.browserOperationBudget(deadlineAt ?? resolveBrowserDeadline(undefined, Date.now()));
    const requestBody: Record<string, unknown> = { serviceUrl, state };
    if (route.backend === "cloudflare" && budget.operationTimeoutMs) {
      requestBody.operationTimeoutMs = budget.operationTimeoutMs;
    }
    let res: Response;
    try {
      res = await fetchBrowser(
        this.env,
        route,
        new Request(`${BROWSER_BASE}/service-ticket`, {
          method: "POST",
          body: JSON.stringify(requestBody),
          // 出站 deadline:node 90s(略大于节点最坏 ~80s);CF 为 210s 单操作上限与
          // 剩余 invocation 时间的较小值。超时归 transient。
          signal: AbortSignal.timeout(budget.fetchTimeoutMs),
        })
      );
    } catch (e) {
      // 稳定浏览器错误(容量/实例替换/预算)原样透传,不包装成 WAF_CHALLENGE。
      if (e instanceof CquSsoError && STABLE_BROWSER_CODES.has(e.code)) {
        throw e;
      }
      // VPC/网络层异常 + AbortError(超时)= 瞬态(WAF_CHALLENGE), 让 DO 退避而非误判过期。
      throw new CquSsoError(
        "WAF_CHALLENGE",
        `browser /service-ticket fetch failed: ${errMsg(e)}`
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

  private async dataHarvest(arg: {
    recipe: { navUrl: string; capture: string[]; fetch: { method?: string; url: string }[] };
    clientId: string | null;
    source: string;
    deadlineAt?: number;
  }): Promise<{ captures: HarvestCapture[]; fetches: HarvestFetch[] }> {
    await this.loadState();
    // RPC 传入的绝对截止时间在此归一化(非法/已过期按 Task 02 受控失败);
    // 整个 harvest(含唯一一次恢复登录与重试)共用这一条预算。
    const deadlineAt = resolveBrowserDeadline(arg.deadlineAt, Date.now());
    const status = await this.getStatus();
    if (!this.state) {
      throw new CquSsoError("SESSION_INACTIVE", "CQU session not active");
    }
    const sessionState = this.state;

    // ① recipe SHAPE 红线(纵深, 镜像节点侧 parse_harvest_recipe): TS 类型只在编译期管用,
    // JS/RPC 调用方可绕过传入畸形 capture/fetch。畸形若漏到下面的记账块 → 白嫖限流槽 + 节点回
    // 400(→ harvestViaNode 归 transient WAF_CHALLENGE, 误导调用方重试)或抛 TypeError(→ 500
    // INTERNAL_ERROR, 伪装成服务器崩)。这些都是客户端契约错, 须在记账**之前**直拒 → 400, 不耗配额。
    //   · capture: 必须是 list[非空 string](URL 子串模式; 允许空 list)。
    //   · fetch:   必须是 list[object{ url:string, method?:string }](允许空 list; host/method 见下)。
    const capture = arg.recipe.capture;
    if (!Array.isArray(capture) || capture.some((p) => typeof p !== "string" || p.length === 0)) {
      throw new CquSsoError("INVALID_HARVEST_URL", "capture must be an array of non-empty strings");
    }
    const fetchList = arg.recipe.fetch;
    if (
      !Array.isArray(fetchList) ||
      fetchList.some((f) => typeof f !== "object" || f === null || typeof f.url !== "string")
    ) {
      throw new CquSsoError("INVALID_HARVEST_URL", "fetch must be an array of objects with a string url");
    }

    // ② host 红线(纵深): navUrl + 每个 fetch.url 必须属于同一个允许主机(capture 是响应过滤
    // 模式、不出站, 不构成 SSRF 面, 不校验)。任一不过 → INVALID_HARVEST_URL。
    // ★ validateCquHarvestUrl 返回 **canonical**(Workers URL parser 规范化, 见 harvest-url.ts
    //   "下游只用此返回值")。节点侧 parse_harvest_recipe 用 Python urlparse, 对百分号编码 host
    //   (`%6d%79.cqu.edu.cn`)/scheme-relative(`https:my.cqu.edu.cn/x`)等不做同等规范化 →
    //   若转发**原文**, 节点会把这些「Workers 判合法、Python 判越界」的 url 再拒成 400 →
    //   harvestViaNode 归 transient WAF_CHALLENGE(且已在记账之后, 白嫖一个槽)。故这里捕获每个
    //   canonical 返回值, 用 canonical navUrl + canonical fetch url 重建配方喂给节点 —— 节点收到的
    //   正是 DO 已校验放行的精确字符串, TS/Python 解析分歧被消弭。
    let navUrl: string;
    try {
      navUrl = validateCquHarvestUrl(arg.recipe.navUrl);
    } catch {
      throw new CquSsoError("INVALID_HARVEST_URL", "非法的 navUrl");
    }
    const canonicalFetch: { method: string; url: string }[] = [];
    for (const f of fetchList) {
      // method 红线(纵深, 对齐节点侧 parse_harvest_recipe): in-page fetch 公开契约只许 GET。
      // 缺省(undefined/null)→ GET; 出现则必须是 string —— 非字符串 method(JSON/RPC 传 42/true)
      // 会让 (f.method ?? "GET").toUpperCase() 抛 TypeError → 500 INTERNAL_ERROR(伪装成服务器崩)。
      // 这是客户端契约错, 先于 toUpperCase 直拒 → 400。
      if (f.method != null && typeof f.method !== "string") {
        throw new CquSsoError("INVALID_HARVEST_URL", "fetch method must be GET");
      }
      // 非 GET 在此早抛 400(客户端契约错), **先于**下面的限流记账 —— 否则非 GET 会白嫖一个
      // 限流槽, 再被节点拒成 400 → harvestViaNode 把 4xx(非 409)归 transient(WAF_CHALLENGE/500)
      // 让调用方误以为是瞬态而重试。GET-only 在入口直拒, 语义稳定且不消耗配额。
      if ((f.method ?? "GET").toUpperCase() !== "GET") {
        throw new CquSsoError("INVALID_HARVEST_URL", "fetch method must be GET");
      }
      let canonicalUrl: string;
      try {
        canonicalUrl = validateCquHarvestUrl(f.url);
      } catch {
        throw new CquSsoError("INVALID_HARVEST_URL", "非法的 fetch url");
      }
      canonicalFetch.push({ method: "GET", url: canonicalUrl });
    }

    // canonical 配方: navUrl/fetch.url 用 DO 已校验放行的规范化字符串, capture 原样(子串模式,
    // 不出站、不构成 SSRF 面, 节点侧也只做非空 string 校验)。仅此配方转发给节点, 不再转发 arg.recipe。
    const canonicalRecipe = { navUrl, capture, fetch: canonicalFetch };
    try {
      validateCquHarvestRecipeHosts(
        navUrl,
        canonicalFetch.map((entry) => entry.url)
      );
    } catch {
      throw new CquSsoError(
        "INVALID_HARVEST_URL",
        "harvest recipe URLs must use the same host"
      );
    }

    // Direct harvest reuses the ordinary CAS session and its lifecycle.
    const harvestRoute = this.currentBrowserRoute();
    if (status !== "active") {
      if (status === "needs_reauth") {
        throw new CquSsoError(
          "NEEDS_REAUTH",
          "CQU session needs re-auth (请重新绑定)"
        );
      }
      throw new CquSsoError("SESSION_INACTIVE", "CQU session not active");
    }
    if (!sessionState.storageState) {
      await this.setStatus("expired");
      await this.ctx.storage.setAlarm(Date.now());
      throw new CquSsoError(
        "SESSION_INACTIVE",
        "CQU session needs re-login (no storage state)"
      );
    }

    // ③ D6 限频(同取票, per-user + per-client; harvest 是真出数动作, 计入同一窗口)。
    const now = Date.now();
    const clientId = arg.clientId ?? null;
    const stored = (await this.ctx.storage.get<StMintRecord[]>("stMintLog")) ?? [];
    const pruned = pruneStMintLog(stored, now, ST_MINT_RATE_WINDOW_MS);
    if (stMintThrottled(pruned, clientId, MAX_ST_MINTS_PER_USER, MAX_ST_MINTS_PER_CLIENT)) {
      console.error(
        `[CquSession] ${sessionState.studentId}: ALERT harvest rate-limited (clientId=${clientId ?? "?"})`
      );
      throw new CquSsoError("RATE_LIMITED", "取数过于频繁,请稍后再试");
    }

    // ④ 记账(镜像取票: 铸前记录, 对失败死循环也鲁棒)。host 取 navUrl host, broad=false。
    const host = new URL(navUrl).hostname;
    sessionState.lastRequestedAt = now;
    await this.putStateGuarded(sessionState);
    pruned.push({ ts: now, clientId, host, broad: false });
    try {
      await this.ctx.storage.put("stMintLog", pruned);
    } catch (e) {
      console.error(
        `[CquSession] ${sessionState.studentId}: stMintLog put failed (harvest accounting degraded): ${errMsg(e)}`
      );
    }

    // ⑤ 出站 /data-harvest(套容器 deadline)。Direct 409 只排 alarm。
    let outcome = "INTERNAL_ERROR";
    try {
      let result: { captures: HarvestCapture[]; fetches: HarvestFetch[] };
      try {
        result = await this.harvestViaBrowser(
          sessionState.storageState,
          canonicalRecipe,
          harvestRoute,
          deadlineAt
        );
      } catch (error) {
        if (
          error instanceof CquSsoError &&
          error.code === "TGT_EXPIRED"
        ) {
          await this.ctx.storage.setAlarm(Date.now());
        }
        throw error;
      }
      outcome = "ok";
      return result;
    } catch (error) {
      outcome =
        error instanceof CquSsoError ? error.code : "INTERNAL_ERROR";
      throw error;
    } finally {
      // ⑥ 审计(与取票同 schema; source 入白名单)。绝不记录 captures/fetches 内容。
      console.log(
        JSON.stringify({
          ...buildStMintAudit({
            userId: sessionState.userId,
            clientId,
            host,
            broad: false,
            source: arg.source ?? "rpc",
            ts: now,
          }),
          outcome,
        })
      );
    }
  }

  private async harvestViaBrowser(
    state: CquStorageState | null,
    recipe: { navUrl: string; capture: string[]; fetch: { method?: string; url: string }[] },
    route: BrowserRoute,
    deadlineAt: number
  ): Promise<{ captures: HarvestCapture[]; fetches: HarvestFetch[] }> {
    const budget = this.browserOperationBudget(deadlineAt);
    const requestBody: Record<string, unknown> = { state, ...recipe };
    if (route.backend === "cloudflare" && budget.operationTimeoutMs) {
      requestBody.operationTimeoutMs = budget.operationTimeoutMs;
    }
    let res: Response;
    try {
      res = await fetchBrowser(
        this.env,
        route,
        new Request(`${BROWSER_BASE}/data-harvest`, {
          method: "POST",
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(budget.fetchTimeoutMs),
        })
      );
    } catch (e) {
      // 稳定浏览器错误(容量/实例替换/预算)原样透传,不包装成 WAF_CHALLENGE。
      if (e instanceof CquSsoError && STABLE_BROWSER_CODES.has(e.code)) {
        throw e;
      }
      throw new CquSsoError("WAF_CHALLENGE", `browser /data-harvest fetch failed: ${errMsg(e)}`);
    }
    let body: NodeHarvestBody | null;
    try {
      body = await res.json<NodeHarvestBody>();
    } catch {
      body = null;
    }
    const c = classifyNodeHarvestResponse(res.status, body);
    if (c.kind === "instance_replaced") {
      // 不能清 CAS 会话:这是浏览器进程替换的瞬态错误。
      throw new CquSsoError(
        "BROWSER_INSTANCE_REPLACED",
        "browser instance replaced during harvest"
      );
    }
    if (c.kind === "expired") {
      throw new CquSsoError("TGT_EXPIRED", `CQU session expired (${c.detail ?? "node /data-harvest"})`);
    }
    if (c.kind === "transient") {
      throw new CquSsoError("WAF_CHALLENGE", `browser /data-harvest ${c.detail ?? "transient"}`);
    }
    return { captures: c.captures ?? [], fetches: c.fetches ?? [] };
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
      const message = JSON.stringify(buildCodeMessage(kind, code, ts));
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(message);
        } catch {
          // 忽略单个 socket 的发送失败, 不影响其它 socket 与暂存。
        }
      }

      const storedLease =
        (await this.ctx.storage.get<CodeLease>("codeLease")) ?? null;
      const lease = pruneCodeLease(storedLease, ts);
      const ownerChanged =
        storedLease !== null &&
        storedLease.ownerToken !== lease?.ownerToken;

      // 该邮件属于已经过期的旧 owner。先原子推进权威 FIFO 并给新 owner 发 permit，
      // 但绝不把迟到旧码转发/暂存给新 owner；用户实时面板已收到上方广播。
      if (ownerChanged) {
        await this.ctx.storage.delete("pendingCode");
        await this.persistCodeLeaseTransition(storedLease, lease);
        console.info(
          `[CquSession] discarded code from stale login owner after FIFO promotion`
        );
        return true;
      }

      if (!lease) {
        await this.ctx.storage.put("pendingCode", pending);
        // 无在途登录 = 用户手动登录触发的码, 已送达上方实时面板。不再算丢码。
        console.info(
          `[CquSession] login_2fa code arrived with no login in flight → broadcast to user live panel`
        );
        return true;
      }
      const observedLease: CodeLease = {
        ...lease,
        ownerCodeReceivedAt: ts,
      };
      pending.ownerToken = observedLease.ownerToken;
      const permitPending =
        (await this.ctx.storage.get<string>("codePermitPending")) ?? null;
      if (permitPending === observedLease.ownerToken) {
        // A mail code can only exist after some login clicked send. That is
        // stronger proof than a lost HTTP response that this owner consumed its
        // permit. Publish separate proof; the in-flight grant/recovery path is
        // the only writer allowed to commit (clear) the durable outbox marker.
        await this.ctx.storage.put(
          "codePermitProven",
          observedLease.ownerToken
        );
      }
      await this.persistCodeLeaseTransition(storedLease, observedLease);
      await this.ctx.storage.put("pendingCode", pending);
      const userId = this.state?.userId;
      if (!userId) {
        // 退化态: 有在途登录锁却无 session 状态, 节点路径走不通。码已广播无害, 但节点收码失败。
        console.warn(
          `[CquSession] login_2fa code arrived but no session state, ignoring`
        );
        return false;
      }
      try {
        // 2FA 码按该 token 的持久 route 定向投递(新格式 CF 带 boot 头,旧格式兼容 node),
        // 不读全局开关,不向两个后端广播。
        const res = await this.fetchLoginControl(
          observedLease.ownerToken,
          new Request(`${BROWSER_BASE}/code`, {
            method: "POST",
            body: JSON.stringify({
              session: observedLease.ownerToken,
              code,
            }),
          })
        );
        if (!res.ok) {
          console.error(
            `[CquSession] browser /code returned non-ok status=${res.status}`
          );
          return false;
        }
        return true;
      } catch (e) {
        console.error(
          `[CquSession] failed to push login_2fa code to browser backend: ${errMsg(e)}`
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
    if (!this.state) {
      return { status };
    }
    return {
      status,
      studentId: this.state.studentId,
      loginAt: this.state.loginAt,
      lastKeepAlive: this.state.lastKeepAlive,
      lastRequestedAt: this.state.lastRequestedAt,
    };
  }
  private quickloginLockKey(deviceId: string): string {
    return `quickloginLogin:${deviceId}`;
  }

  private quickloginResultKey(deviceId: string, generation: number): string {
    return `quickloginResult:${deviceId}:${generation}`;
  }

  private async bumpQuickloginBindingEpoch(ownerUserId?: string): Promise<number> {
    const current =
      (await this.ctx.storage.get<number>("quickloginBindingEpoch")) ?? 0;
    const next =
      Number.isSafeInteger(current) && current >= 0
        ? Math.min(current + 1, Number.MAX_SAFE_INTEGER)
        : 1;
    const [locks, results] = await Promise.all([
      this.ctx.storage.list<QuickloginLoginInFlight>({
        prefix: "quickloginLogin:",
      }),
      this.ctx.storage.list<QuickloginCachedLoginResult>({
        prefix: "quickloginResult:",
      }),
    ]);
    const keys = [...locks.keys(), ...results.keys()];
    for (const lock of locks.values()) {
      keys.push(this.browserRouteKey(lock.token));
    }
    if (keys.length > 0) await this.ctx.storage.delete(keys);
    await this.ctx.storage.put("quickloginBindingEpoch", next);
    this.quickloginFlights.clear();
    try {
      await this.clearVerificationCodeLeasesByKind("quicklogin");
    } catch {
      // A live owner remains fenced until its normal finally/TTL path.
    }
    if (ownerUserId) {
      await new QuickloginAccountClient(this.env)
        .notifyBindingChanged(ownerUserId);
    }
    return next;
  }

  private async getQuickloginBindingEpoch(): Promise<{
    bound: boolean;
    epoch: number;
  }> {
    await this.loadState();
    const [storedEpoch, status, credentials] = await Promise.all([
      this.ctx.storage.get<number>("quickloginBindingEpoch"),
      this.getStatus(),
      this.ctx.storage.get<StoredCredentials>("credentials"),
    ]);
    const epoch =
      Number.isSafeInteger(storedEpoch) && (storedEpoch ?? -1) >= 0
        ? storedEpoch!
        : 0;
    return {
      bound:
        this.state !== null &&
        credentials !== undefined &&
        status !== "unbound" &&
        status !== "revoked",
      epoch,
    };
  }

  private async quickloginLogin(
    input: DeviceLoginRequest
  ): Promise<DeviceLoginResult> {
    if (
      !input.ownerUserId ||
      !input.deviceId ||
      input.deviceId.includes(":") ||
      !Number.isSafeInteger(input.generation) ||
      input.generation < 0
    ) {
      return { kind: "cancelled" };
    }
    const key = `${input.deviceId}:${input.generation}`;
    const resultKey = this.quickloginResultKey(
      input.deviceId,
      input.generation
    );
    const cached =
      (await this.ctx.storage.get<QuickloginCachedLoginResult>(resultKey)) ??
      null;
    if (cached?.expiresAt && cached.expiresAt > Date.now()) {
      return cached.result;
    }
    if (cached) await this.ctx.storage.delete(resultKey);
    const existing = this.quickloginFlights.get(key);
    if (existing) return existing;

    const flight = this.runQuickloginLogin(input);
    this.quickloginFlights.set(key, flight);
    try {
      const result = await flight;
      if (result.kind === "success") {
        await this.ctx.storage.put(resultKey, {
          result,
          expiresAt: Date.now() + 60_000,
        } satisfies QuickloginCachedLoginResult);
      }
      return result;
    } finally {
      if (this.quickloginFlights.get(key) === flight) {
        this.quickloginFlights.delete(key);
      }
    }
  }

  private async runQuickloginLogin(
    input: DeviceLoginRequest
  ): Promise<DeviceLoginResult> {
    await this.loadState();
    const binding = await this.getQuickloginBindingEpoch();
    const status = await this.getStatus();
    const credentials =
      (await this.ctx.storage.get<StoredCredentials>("credentials")) ?? null;
    if (
      !binding.bound ||
      !this.state ||
      this.state.userId !== input.ownerUserId ||
      !credentials ||
      status === "unbound" ||
      status === "revoked"
    ) {
      return { kind: "needs_reauth", reason: "unbound" };
    }

    const lockKey = this.quickloginLockKey(input.deviceId);
    const token = crypto.randomUUID();
    const route = quickloginBrowserRoute(input.ownerUserId, input.deviceId);
    const now = Date.now();
    let acquired = false;
    let staleGeneration = false;
    await this.ctx.storage.transaction(async (tx) => {
      const current =
        (await tx.get<QuickloginLoginInFlight>(lockKey)) ?? null;
      if (current && now - current.startedAt <= LOGIN_LOCK_TTL_MS) {
        if (current.generation > input.generation) staleGeneration = true;
        return;
      }
      if (current) await tx.delete(this.browserRouteKey(current.token));
      const lock: QuickloginLoginInFlight = {
        token,
        deviceId: input.deviceId,
        generation: input.generation,
        bindingEpoch: binding.epoch,
        startedAt: now,
        browserRouteVersion: 1,
      };
      const record: LoginRouteRecord = {
        token,
        kind: "quicklogin",
        route,
        createdAt: now,
        expiresAt: now + LOGIN_LOCK_TTL_MS + 60_000,
      };
      await tx.put({
        [lockKey]: lock,
        [this.browserRouteKey(token)]: record,
      });
      acquired = true;
    });
    await this.ctx.storage.sync();
    if (!acquired) {
      return staleGeneration
        ? { kind: "cancelled" }
        : { kind: "temporary_unavailable", retryAfterMs: 1_000 };
    }

    let leaseAcquired = false;
    let runAbort: AbortController | null = null;
    const recheck = async () => {
      const [latestState, latestStatus, latestEpoch, latestLock] =
        await Promise.all([
          this.ctx.storage.get<SessionState>("state"),
          this.getStatus(),
          this.ctx.storage.get<number>("quickloginBindingEpoch"),
          this.ctx.storage.get<QuickloginLoginInFlight>(lockKey),
        ]);
      if (
        !latestState ||
        latestState.userId !== input.ownerUserId ||
        latestStatus === "unbound" ||
        latestStatus === "revoked" ||
        (latestEpoch ?? 0) !== binding.epoch ||
        latestLock?.token !== token ||
        latestLock.generation !== input.generation
      ) {
        throw new CquSsoError(
          "LOGIN_BINDING_CHANGED",
          "quicklogin binding changed"
        );
      }
    };

    try {
      await recheck();
      const loginRoute = await this.prepareLoginRoute(
        token,
        route,
        lockKey,
        recheck
      );
      const password = await decrypt(
        credentials.encryptedPassword,
        credentials.iv,
        this.env.ENCRYPTION_KEY
      );
      const permitRole = await this.acquireVerificationCodeLease(
        token,
        "quicklogin"
      );
      leaseAcquired = true;
      const deadline = resolveBrowserDeadline(undefined, Date.now());
      const remainingMs = remainingBrowserBudget(deadline, Date.now());
      runAbort = new AbortController();
      const runBody: Record<string, unknown> = {
        studentId: this.state.studentId,
        password,
        service: DUMMY_SERVICE,
        method: "mail",
        session: token,
        queuedPermit: permitRole === "queued",
      };
      if (loginRoute.backend === "cloudflare") {
        runBody.operationTimeoutMs = Math.max(
          1,
          remainingMs - BROWSER_CLEANUP_MARGIN_MS
        );
      }
      const request = new Request(`${BROWSER_BASE}/run`, {
        method: "POST",
        signal: AbortSignal.any([
          runAbort.signal,
          AbortSignal.timeout(remainingMs),
        ]),
        body: JSON.stringify(runBody),
      });
      if (loginRoute.bootId) {
        request.headers.set("X-Cqu-Expected-Boot-Id", loginRoute.bootId);
      }
      const response = await fetchBrowser(this.env, loginRoute, request);
      const result = await response
        .json<ContainerRunResult>()
        .catch(() => null);
      await recheck();

      if (result?.error === "PASSWORD_REJECTED") {
        return {
          kind: "needs_reauth",
          reason: "credentials_rejected",
        };
      }
      if (
        !response.ok ||
        !result?.ok ||
        !result.state ||
        !hasValidTgt(result.state)
      ) {
        return { kind: "temporary_unavailable", retryAfterMs: 60_000 };
      }
      await this.clearConsumedLoginCode();
      return {
        kind: "success",
        storageState: JSON.stringify(result.state),
        loginAt: Date.now(),
        bindingEpoch: binding.epoch,
      };
    } catch (error) {
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : null;
      if (
        code === "LOGIN_BINDING_CHANGED" ||
        code === "CODE_OWNER_REPLACED" ||
        code === "CODE_ROUTE_UNAVAILABLE"
      ) {
        return { kind: "cancelled" };
      }
      return { kind: "temporary_unavailable", retryAfterMs: 60_000 };
    } finally {
      runAbort?.abort();
      try {
        await this.releaseVerificationCodeLease(token, leaseAcquired);
      } catch {
        // The persisted owner fence remains authoritative until its TTL.
      }
      const current =
        (await this.ctx.storage.get<QuickloginLoginInFlight>(lockKey)) ?? null;
      if (current?.token === token) {
        await this.ctx.storage.delete([
          lockKey,
          this.browserRouteKey(token),
        ]);
      }
    }
  }

  /**
   * Preserve only a still-live owner across destructive lifecycle changes.
   * Tokens are non-secret fencing metadata. Queue entries are discarded because
   * their login generations were invalidated and none has received a permit.
   */
  private async snapshotLiveCodeLeaseOwner(): Promise<{
    lease: CodeLease;
    pendingToken: string | null;
    provenToken: string | null;
  } | null> {
    const now = Date.now();
    const [lease, pendingToken, provenToken] = await Promise.all([
      this.ctx.storage.get<CodeLease>("codeLease"),
      this.ctx.storage.get<string>("codePermitPending"),
      this.ctx.storage.get<string>("codePermitProven"),
    ]);
    if (!lease || pruneCodeLease(lease, now)?.ownerToken !== lease.ownerToken) {
      return null;
    }
    return {
      lease: { ...lease, queue: [] },
      pendingToken:
        pendingToken === lease.ownerToken ? pendingToken : null,
      provenToken: provenToken === lease.ownerToken ? provenToken : null,
    };
  }

  private async restoreCodeLeaseOwnerFence(
    fence: Awaited<ReturnType<CquSessionDO["snapshotLiveCodeLeaseOwner"]>>
  ): Promise<void> {
    if (!fence) return;
    await this.ctx.storage.put("codeLease", fence.lease);
    if (fence.pendingToken) {
      await this.ctx.storage.put("codePermitPending", fence.pendingToken);
    }
    if (fence.provenToken) {
      await this.ctx.storage.put("codePermitProven", fence.provenToken);
    }
  }

  private async destroy(): Promise<void> {
    await this.loadState();
    const ownerUserId = this.state?.userId;
    const fence = await this.snapshotLiveCodeLeaseOwner();
    const previousEpoch =
      (await this.ctx.storage.get<number>("quickloginBindingEpoch")) ?? 0;
    const nextEpoch =
      Number.isSafeInteger(previousEpoch) && previousEpoch >= 0
        ? Math.min(previousEpoch + 1, Number.MAX_SAFE_INTEGER)
        : 1;
    await this.ctx.storage.deleteAll();
    this.state = null;
    this.quickloginFlights.clear();
    // deleteAll 已清掉 status/loginInFlight/pendingCode/state/credentials/reloginAttempts/reloginFailures;
    // 显式回到 unbound, 让后续 status 查询语义清晰(而非依赖默认值)。
    await this.ctx.storage.put({
      status: "unbound" satisfies CquStatus,
      quickloginBindingEpoch: nextEpoch,
    });
    await this.restoreCodeLeaseOwnerFence(fence);
    if (ownerUserId) {
      await new QuickloginAccountClient(this.env)
        .notifyBindingChanged(ownerUserId);
    }
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
    await this.loadState();
    const ownerUserId = this.state?.userId;
    const fence = await this.snapshotLiveCodeLeaseOwner();
    await this.bumpQuickloginBindingEpoch();
    // 刻意直写 setStatus("revoked") 而非走 nextStatus 状态机: 撤销要从任意状态(含空/
    // unbound 的 DO, admin 端点对未初始化的 DO 也会发 revoke)强制置位; 状态机表里
    // unbound 无 REVOKE 转移, 走表会停在 unbound 而漏置墓碑。勿"修回"成走表。
    await this.setStatus("revoked");
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.delete("loginInFlight");
    await this.ctx.storage.delete([
      "codeLease",
      "codePermitPending",
      "codePermitProven",
    ]);
    await this.restoreCodeLeaseOwnerFence(fence);
    if (ownerUserId) {
      try {
        await new QuickloginAccountClient(this.env)
          .notifyBindingChanged(ownerUserId);
      } catch {
        console.warn(JSON.stringify({
          event: "quicklogin.binding_change_notify_failed",
        }));
      }
    }
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
    if (!this.retiredAtrustCleanupComplete) {
      try {
        if (!(await this.removeRetiredAtrustState())) return;
      } catch (error) {
        console.warn(
          `[CquSession] retired aTrust state cleanup alarm retry failed (${error instanceof Error ? error.name : "unknown"})`
        );
        await this.ctx.storage.setAlarm(Date.now() + RETRY_INTERVAL_MS);
        return;
      }
    }
    if (!this.activationPermitRecoveryComplete) {
      try {
        await this.recoverPendingCodePermit();
        this.activationPermitRecoveryComplete = true;
      } catch (error) {
        console.warn(
          `[CquSession] pending code permit alarm recovery deferred (${error instanceof Error ? error.name : "unknown"})`
        );
        await this.ctx.storage.setAlarm(Date.now() + RETRY_INTERVAL_MS);
        return;
      }
    }
    await this.pruneQuickloginMintReceipts(Date.now());
    await this.loadState();
    if (!this.state) return;
    // alarm 的 13 分钟平台预算在入口建立一次,贯穿保活/主动重登;
    // 内部函数不得重新取得新的 13 分钟。
    const deadlineAt = resolveBrowserDeadline(undefined, Date.now());
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
      await this.relogin(deadlineAt);
      // M7 防复活 + 熔断早退: relogin 容器登录 await 期间 input gate 开, admin 可能 revoke/unbind;
      // relogin 也可能落 needs_reauth(连续凭据失败)。两者都收敛到 shouldAbandonKeepaliveWriteback
      // (revoked/unbound/needs_reauth)→ 放弃重排, 停止保活循环(撤销不复活 / 终态等用户重绑)。
      if (shouldAbandonKeepaliveWriteback(await this.getStatus())) {
        console.warn(
          `[CquSession] ${this.state.studentId}: status revoked/halted during proactive relogin, not re-arming alarm`
        );
        return;
      }
      // relogin 内部已更新状态; 重新排 alarm 继续保活循环。
      // 此处刻意不再 putStateGuarded: containerLogin 成功时内部已落 fresh state; proactive 跑在
      // 健康 active 会话上(consecutiveFailures 本就 0), 无需像 expired 分支那样为清零失败计数而重 put。
      await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_INTERVAL_MS);
      return;
    }

    const outcome = await this.runKeepAlive(deadlineAt);

    if (outcome === "active") {
      // M7 防复活: runKeepAlive 的浏览器出站(最长 90s)await 期间 input gate 打开,
      // 期间 admin revoke/unbind 可能把 status 改成撤销/解绑/需重登。此处写回 active 前重查
      // status, 命中撤销/终态即放弃本轮(不 setStatus active / 不 putState / 不 setAlarm),
      // 否则会把已撤销会话复活。
      if (shouldAbandonKeepaliveWriteback(await this.getStatus())) {
        console.warn(
          `[CquSession] ${this.state.studentId}: status changed during keepalive probe, abandoning active writeback (anti-resurrection)`
        );
        return;
      }
      await this.setStatus("active");
      this.state.lastKeepAlive = Date.now();
      this.state.consecutiveFailures = 0;
      // H2 落盘前体量守卫(此处可能携 keepalive 刚回写的刷新 state, localStorage 体量不受控);
      // putStateGuarded 超限/抛错均降级返回 false 而非抛穿 alarm。
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
      await this.relogin(deadlineAt);
      // M7 防复活: runKeepAlive 探活 + relogin 容器登录的 await 期间 input gate 都开过,
      // admin 可能已 revoke/unbind。relogin 经状态机推进(nextStatus 对 revoked 无 RELOGIN_OK
      // 转移, 不会复活 status), 但本分支仍可能重排 alarm 重启保活循环。写回前重查 status,
      // 命中撤销/终态(含 needs_reauth)即放弃: 不 putState、不 setAlarm。
      if (shouldAbandonKeepaliveWriteback(await this.getStatus())) {
        console.warn(
          `[CquSession] ${this.state.studentId}: status changed during expired-relogin, abandoning writeback (anti-resurrection / halt)`
        );
        return;
      }
      this.state.consecutiveFailures = 0;
      await this.putStateGuarded(this.state);
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
  private async runKeepAlive(
    deadlineAt?: number
  ): Promise<"active" | "expired" | "transient"> {
    const state = this.state!;
    // 旧会话迁移守卫:改造前只存 3 cookie(无完整 storageState)。报 expired 让 alarm 触发重登,
    // 铸一套新的完整 storageState 自愈;绝不把 null state 发给节点(否则 400 → 永远退避不重登)。
    if (!state.storageState) {
      console.warn(
        `[CquSession] ${state.studentId}: no storageState (legacy session), forcing relogin`
      );
      return "expired";
    }
    // 探活走集中 transport(node→国内节点;CF→该用户 APAC 容器)。
    // 节点恒返回 200 {ok, status: alive|expired|unreachable}, 映射回三态:
    //   alive→active / expired→expired / unreachable→transient。
    // 够不到节点本身(VPC/网络抛错、非 JSON、非 ok)或未知 status = 探不通 → transient
    // (保 cookies/status 不动、退避重试), 绝不误判过期触发容器重登。
    let res: Response;
    try {
      const route = this.currentBrowserRoute();
      const budget = this.browserOperationBudget(deadlineAt ?? resolveBrowserDeadline(undefined, Date.now()));
      const body: Record<string, unknown> = { state: state.storageState };
      if (route.backend === "cloudflare" && budget.operationTimeoutMs) {
        body.operationTimeoutMs = budget.operationTimeoutMs;
      }
      res = await fetchBrowser(
        this.env,
        route,
        new Request(`${BROWSER_BASE}/keepalive`, {
          method: "POST",
          body: JSON.stringify(body),
          // 出站 deadline(同取票路径):探活也在节点侧排队持槽,无超时则 backlog 时
          // 阻塞 DO 单线程。超时/AbortError/容量错误归 transient(退避不误判过期)。
          signal: AbortSignal.timeout(budget.fetchTimeoutMs),
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
      // #2 回写校验: 仅当节点刷新后的 state 含 CAS 三件套(hasValidTgt) **且** 并入后不超 DO
      // 硬上限时才覆盖, 否则保留旧 state。
      // 节点导出的 refreshed state 可能半截/退化(如 {cookies:[],origins:[]} 空但 truthy), 无 TGT
      // 顶替好 state 会让下轮取票 storageState 非 null 却无 TGT → 落登录页 409 → 误判过期重登。
      // H2 体量守卫: 刷新后的 state(含不受控的 localStorage)若超硬上限, 直接丢弃刷新态、保留旧
      // state —— 旧 state 已能取票, 刷新只续期, 不值得为续期而把 state 撑到落不下盘。因 state===
      // this.state, alarm() 的 active 分支随后 putStateGuarded(this.state) 落盘; 这里先剔掉超限的
      // 刷新态, 让那次 put 写的是仍在限内的旧 state(否则 putStateGuarded 会拒 put 整条 state)。
      if (body.state) {
        if (!hasValidTgt(body.state)) {
          console.warn(
            `[CquSession] ${state.studentId}: probe alive but refreshed state lacks required CAS cookies, keeping old storageState`
          );
        } else {
          const candidate: SessionState = {
            ...state,
            storageState: body.state,
          };
          if (stateExceedsHardLimit(serializedStateBytes(candidate))) {
            console.error(
              `[CquSession] ${state.studentId}: ALERT refreshed state exceeds DO hard limit, discarding refresh and keeping old storageState (session stays mintable)`
            );
          } else {
            state.storageState = body.state;
          }
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
  private async recordQuickloginKeepaliveMint(input: {
    deviceId: string;
    operationId: string;
    mintedAt: number;
  }): Promise<void> {
    if (
      !input.deviceId ||
      !input.operationId ||
      !Number.isSafeInteger(input.mintedAt) ||
      input.mintedAt < 0
    ) {
      throw new CquSsoError("INVALID_REQUEST", "invalid quicklogin mint");
    }
    const now = Date.now();
    const receipts = await this.pruneQuickloginMintReceipts(now);
    if (receipts.some((receipt) => receipt.operationId === input.operationId)) {
      return;
    }
    const next = [
      ...receipts.slice(-(MAX_QUICKLOGIN_MINT_RECEIPTS - 1)),
      {
        operationId: input.operationId,
        expiresAt: now + QUICKLOGIN_MINT_RECEIPT_TTL_MS,
      },
    ];
    await this.ctx.storage.put(QUICKLOGIN_MINT_RECEIPTS_KEY, next);
    try {
      await this.recordKeepaliveMint();
    } catch (error) {
      if (receipts.length === 0) {
        await this.ctx.storage.delete(QUICKLOGIN_MINT_RECEIPTS_KEY);
      } else {
        await this.ctx.storage.put(QUICKLOGIN_MINT_RECEIPTS_KEY, receipts);
      }
      throw error;
    }
  }

  private async pruneQuickloginMintReceipts(
    now: number
  ): Promise<QuickloginMintReceipt[]> {
    const stored =
      (await this.ctx.storage.get<QuickloginMintReceipt[]>(
        QUICKLOGIN_MINT_RECEIPTS_KEY
      )) ?? [];
    const receipts = stored
      .filter((receipt) =>
        typeof receipt?.operationId === "string" &&
        receipt.operationId.length > 0 &&
        Number.isSafeInteger(receipt.expiresAt) &&
        receipt.expiresAt > now
      )
      .slice(-MAX_QUICKLOGIN_MINT_RECEIPTS);
    const legacy = await this.ctx.storage.list({ prefix: "quickloginMint:" });
    if (legacy.size > 0) {
      await this.ctx.storage.delete([...legacy.keys()]);
    }
    if (receipts.length === 0) {
      await this.ctx.storage.delete(QUICKLOGIN_MINT_RECEIPTS_KEY);
    } else if (receipts.length !== stored.length) {
      await this.ctx.storage.put(QUICKLOGIN_MINT_RECEIPTS_KEY, receipts);
    }
    return receipts;
  }

  private async recordKeepaliveMint(): Promise<void> {
    const st = this.state;
    if (!st) return;
    const now = Date.now();
    const host = new URL(DUMMY_SERVICE).hostname;
    // M6 审计与记账解耦: ST 已在节点侧铸出(既成事实), **先无条件打审计**, 绝不让后面的
    // 记账(storage.put)失败连带丢掉审计。审计(结构化, 与取票同 schema; source:"keepalive")
    // 绝不含 ticket/cookies/密码。
    const auditFields = {
      userId: st.userId,
      clientId: KEEPALIVE_CLIENT_ID,
      host,
      broad: false,
      source: KEEPALIVE_SOURCE,
      ts: now,
    };
    console.log(JSON.stringify(buildStMintAudit(auditFields)));
    // 记账(计入 per-user 限流窗口): 记账但豁免拒绝 —— 直接追加, 不调 stMintThrottled。
    // 哨兵 clientId 自成桶, 不挤占真实配额。put 失败只补一条 recorded:false 告警**并吞掉异常**
    // (catch 后 return), 绝不向 runKeepAlive/alarm 冒泡(否则 alarm 抛 → CF 自动重试 → 再铸票)。
    // catch 只罩自身这一处 put, 不影响 runKeepAlive 其它需冒泡的异常。
    try {
      const stored =
        (await this.ctx.storage.get<StMintRecord[]>("stMintLog")) ?? [];
      const pruned = pruneStMintLog(stored, now, ST_MINT_RATE_WINDOW_MS);
      pruned.push({ ts: now, clientId: KEEPALIVE_CLIENT_ID, host, broad: false });
      await this.ctx.storage.put("stMintLog", pruned);
    } catch (e) {
      // catch 行 = 正常审计行 + 末尾追加 recorded:false + err(运行时副作用, 留 DO 侧 spread 后置)。
      // spread 在 buildStMintAudit 输出之后, 追加键序列化在末尾 → 与历史手写 catch 行逐字节等价。
      console.error(
        JSON.stringify({
          ...buildStMintAudit(auditFields),
          recorded: false,
          err: errMsg(e),
        })
      );
    }
  }

  /**
   * 容器驱动的重登。single-flight 保护已下沉到 containerLogin: 已有在途登录(锁未过期)时
   * containerLogin 返回 "in_flight", 不点火第二个容器、不重设锁。
   * 解密存储的密码 → 调容器 /run 铸新 TGT → 成功落 cookies + loginAt + RELOGIN_OK(→ active);
   * 失败落 RELOGIN_FAIL(→ expired)。锁无论成败都清掉。
   */
  private async relogin(deadlineAt?: number): Promise<void> {
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
      "RELOGIN_START",
      deadlineAt
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
   * 将验证码请求权授予指定登录会话。租约必须先落盘再调用本方法，
   * 这样 Email Routing 在任意时刻投码都只会看到一个权威 owner。
   */
  private async grantVerificationCodePermit(token: string): Promise<void> {
    let lastStatus = 0;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const lease =
        (await this.ctx.storage.get<CodeLease>("codeLease")) ?? null;
      if (lease?.ownerToken !== token) return;
      try {
        const response = await this.fetchLoginControl(
          token,
          new Request(`${BROWSER_BASE}/code-permit`, {
            method: "POST",
            body: JSON.stringify({ session: token }),
            signal: AbortSignal.timeout(10_000),
          })
        );
        lastStatus = response.status;
        if (response.ok) {
          return;
        }
        if (await this.isCodePermitProven(token)) return;
      } catch (error) {
        lastStatus = 0;
        if (await this.isCodePermitProven(token)) return;
        if (attempt === 3) {
          console.error(
            `[CquSession] browser /code-permit failed after ${attempt} attempts (${error instanceof Error ? error.name : "unknown"})`
          );
        }
      }
    }
    throw new Error(
      `browser /code-permit failed after 3 attempts (status=${lastStatus})`
    );
  }

  private async isCodePermitProven(token: string): Promise<boolean> {
    const [lease, pendingToken, provenToken] = await Promise.all([
      this.ctx.storage.get<CodeLease>("codeLease"),
      this.ctx.storage.get<string>("codePermitPending"),
      this.ctx.storage.get<string>("codePermitProven"),
    ]);
    return (
      lease?.ownerToken === token &&
      pendingToken === token &&
      provenToken === token
    );
  }

  /** 将 permit 窄竞态窗口内缓冲的新邮件码补投给已提交的 owner。 */
  private async deliverBufferedFreshCode(token: string): Promise<boolean> {
    const pending =
      (await this.ctx.storage.get<PendingCode>("pendingCode")) ?? null;
    if (
      !pending ||
      pending.kind !== "login_2fa" ||
      pending.ownerToken !== token ||
      Date.now() - pending.ts >= CODE_VALIDITY_MS
    ) {
      return false;
    }
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const lease =
        (await this.ctx.storage.get<CodeLease>("codeLease")) ?? null;
      if (lease?.ownerToken !== token) return true;
      try {
        const response = await this.fetchLoginControl(
          token,
          new Request(`${BROWSER_BASE}/code`, {
            method: "POST",
            body: JSON.stringify({ session: token, code: pending.code }),
          })
        );
        if (response.ok) return true;
      } catch {
        // 同 reusable 预载，最多三次；最终失败由节点自身 code wait 超时收敛。
      }
    }
    console.warn(
      `[CquSession] buffered fresh login code delivery failed after 3 attempts`
    );
    return true;
  }

  /** Finish the durable outbox entry only after the node acknowledged this owner. */
  private async commitAcknowledgedCodePermit(token: string): Promise<void> {
    const [latest, pendingToken] = await Promise.all([
      this.ctx.storage.get<CodeLease>("codeLease"),
      this.ctx.storage.get<string>("codePermitPending"),
    ]);
    if (latest?.ownerToken !== token || pendingToken !== token) return;
    await this.ctx.storage.delete([
      "codePermitPending",
      "codePermitProven",
    ]);
    const hadBufferedFresh = await this.deliverBufferedFreshCode(token);
    if (!hadBufferedFresh) {
      await this.offerPendingCodeForReuse(token);
    }
  }

  /** Replay an activation-surviving outbox marker to the exact same owner only. */
  private async recoverPendingCodePermit(): Promise<void> {
    const [lease, pendingToken] = await Promise.all([
      this.ctx.storage.get<CodeLease>("codeLease"),
      this.ctx.storage.get<string>("codePermitPending"),
    ]);
    if (!pendingToken) return;
    if (!lease || lease.ownerToken !== pendingToken) {
      await this.ctx.storage.delete([
        "codePermitPending",
        "codePermitProven",
      ]);
      return;
    }

    const pruned = pruneCodeLease(lease, Date.now());
    if (pruned?.ownerToken !== lease.ownerToken) {
      // The old node owner budget has certainly ended; only now may FIFO move.
      await this.persistCodeLeaseTransition(lease, pruned);
      return;
    }
    if (!(await this.isCodePermitProven(pendingToken))) {
      await this.grantVerificationCodePermit(pendingToken);
    }
    await this.commitAcknowledgedCodePermit(pendingToken);
  }

  /**
   * 唯一租约转换入口：先持久化 owner + pending tombstone，再发 permit；成功后
   * 提交 owner 并补投竞态窗口邮件。未收到确认时保留 owner + marker：请求可能
   * 已被节点消费，只有 owner TTL 到期才可安全推进 FIFO。
   */
  private async persistCodeLeaseTransition(
    current: CodeLease | null,
    next: CodeLease | null
  ): Promise<void> {
    const ownerChanged = current?.ownerToken !== next?.ownerToken;
    if (!next) {
      await this.ctx.storage.delete([
        "codeLease",
        "codePermitPending",
        "codePermitProven",
      ]);
      return;
    }
    if (!ownerChanged) {
      await this.ctx.storage.put("codeLease", next);
      return;
    }

    await this.ctx.storage.delete("codePermitProven");
    await this.ctx.storage.put({
      codeLease: next,
      codePermitPending: next.ownerToken,
    });
    await this.grantVerificationCodePermit(next.ownerToken);
    await this.commitAcknowledgedCodePermit(next.ownerToken);
  }

  /**
   * 将仍有效的账号级旧码预载到当前 owner 的独立 reusable 槽。节点只有在
   * CQU 发码接口明确返回 already_valid 时才会消费；若真发出新码(sent)，该槽
   * 永不参与，避免旧码抢先。owner 在读码和出站之间被轮换时直接放弃。
   */
  private async offerPendingCodeForReuse(token: string): Promise<void> {
    const [pending, lease] = await Promise.all([
      this.ctx.storage.get<PendingCode>("pendingCode"),
      this.ctx.storage.get<CodeLease>("codeLease"),
    ]);
    if (
      !pending ||
      pending.kind !== "login_2fa" ||
      pending.ownerToken !== undefined ||
      Date.now() - pending.ts >= CODE_VALIDITY_MS ||
      lease?.ownerToken !== token
    ) {
      return;
    }
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const currentLease =
        (await this.ctx.storage.get<CodeLease>("codeLease")) ?? null;
      if (currentLease?.ownerToken !== token) return;
      try {
        const response = await this.fetchLoginControl(
          token,
          new Request(`${BROWSER_BASE}/code`, {
            method: "POST",
            body: JSON.stringify({
              session: token,
              code: pending.code,
              reusable: true,
            }),
          })
        );
        if (response.ok) return;
        if (attempt === 3) {
          console.warn(
            `[CquSession] reusable login code preload failed after ${attempt} attempts (status=${response.status})`
          );
        }
      } catch (error) {
        if (attempt === 3) {
          console.warn(
            `[CquSession] reusable login code preload failed after ${attempt} attempts (${error instanceof Error ? error.name : "unknown"})`
          );
        }
      }
    }
  }

  private async clearConsumedLoginCode(): Promise<void> {
    const pending =
      (await this.ctx.storage.get<PendingCode>("pendingCode")) ?? null;
    if (pending?.kind === "login_2fa") {
      await this.ctx.storage.delete("pendingCode");
    }
  }

  /** Remove persisted state from the retired web-only aTrust login path. */
  private async removeRetiredAtrustState(): Promise<boolean> {
    const deferUntil = await this.ctx.storage.transaction(async (tx) => {
      const [lock, lease, pendingCode, routeRecords] = await Promise.all([
        tx.get<LoginInFlight>("atrustLoginInFlight"),
        tx.get<CodeLease>("codeLease"),
        tx.get<PendingCode>("pendingCode"),
        tx.list<LoginRouteRecord>({ prefix: BROWSER_ROUTE_PREFIX }),
      ]);
      const retiredTokens = new Set<string>();
      if (lock?.token) retiredTokens.add(lock.token);
      for (const entry of lease?.queue ?? []) {
        if (entry.kind === "atrust") retiredTokens.add(entry.token);
      }
      if (lease?.ownerKind === "atrust") retiredTokens.add(lease.ownerToken);
      const retiredRouteKeys: string[] = [];
      for (const [key, record] of routeRecords) {
        if (record.kind !== "atrust") continue;
        retiredTokens.add(record.token);
        retiredRouteKeys.push(key);
      }

      let nextLease = lease ?? null;
      let deferredOwnerUntil: number | null = null;
      if (nextLease) {
        nextLease = {
          ...nextLease,
          queue: nextLease.queue.filter((entry) => entry.kind !== "atrust"),
        };
        if (nextLease.ownerKind === "atrust") {
          const receivedAt = nextLease.ownerCodeReceivedAt;
          const now = Date.now();
          if (
            typeof receivedAt === "number" &&
            Number.isSafeInteger(receivedAt) &&
            receivedAt > 0 &&
            now - Math.min(receivedAt, now) < CODE_VALIDITY_MS
          ) {
            deferredOwnerUntil = Math.min(receivedAt, now) + CODE_VALIDITY_MS;
          } else {
            nextLease = releaseCodeLease(
              nextLease,
              nextLease.ownerToken,
              now
            );
          }
        }
      }

      const deleteKeys = new Set([
        "atrustSession",
        "atrustGeneration",
        "atrustLoginInFlight",
        ...retiredRouteKeys,
        ...[...retiredTokens].map((token) => this.browserRouteKey(token)),
      ]);
      if (pendingCode?.ownerToken && retiredTokens.has(pendingCode.ownerToken)) {
        deleteKeys.add("pendingCode");
      }
      if (deferredOwnerUntil !== null) {
        deleteKeys.add("codePermitPending");
        deleteKeys.add("codePermitProven");
      }
      await tx.delete([...deleteKeys]);

      if (!nextLease) {
        await tx.delete([
          "codeLease",
          "codePermitPending",
          "codePermitProven",
        ]);
        return null;
      }
      await tx.put("codeLease", nextLease);
      if (
        deferredOwnerUntil === null &&
        lease?.ownerToken !== nextLease.ownerToken
      ) {
        await tx.delete("codePermitProven");
        await tx.put("codePermitPending", nextLease.ownerToken);
      }
      return deferredOwnerUntil;
    });
    if (deferUntil !== null) {
      const currentAlarm = await this.ctx.storage.getAlarm();
      if (currentAlarm === null || currentAlarm > deferUntil) {
        await this.ctx.storage.setAlarm(deferUntil);
      }
      return false;
    }
    this.retiredAtrustCleanupComplete = true;
    return true;
  }

  /** 清理某类登录在 owner/队列中的所有租约，保留另一类登录的顺序。 */
  private async clearVerificationCodeLeasesByKind(
    kind: LoginKind
  ): Promise<void> {
    const now = Date.now();
    const current =
      (await this.ctx.storage.get<CodeLease>("codeLease")) ?? null;
    if (!current) {
      await this.ctx.storage.delete([
        "codePermitPending",
        "codePermitProven",
      ]);
      return;
    }

    const filtered: CodeLease = {
      ...current,
      queue: current.queue.filter((entry) => entry.kind !== kind),
    };
    const currentStillLive =
      pruneCodeLease(current, now)?.ownerToken === current.ownerToken;
    if (current.ownerKind === kind && currentStillLive) {
      // Reset invalidates the browser generation, not the external node's
      // already-issued permit. Keep the owner fence until its own finally or TTL.
      await this.ctx.storage.put("codeLease", filtered);
      return;
    }
    const next =
      current.ownerKind === kind
        ? releaseCodeLease(filtered, current.ownerToken, now)
        : pruneCodeLease(filtered, now);
    await this.persistCodeLeaseTransition(current, next);
  }

  /**
   * 按 FIFO 获取共享验证码通道。CAS 与 QuickLogin 的浏览器登录可以并行，
   * 但只有 owner 会被允许点击「获取验证码」。
   */
  private async acquireVerificationCodeLease(
    token: string,
    kind: LoginKind
  ): Promise<"owner" | "queued"> {
    const now = Date.now();
    const current =
      (await this.ctx.storage.get<CodeLease>("codeLease")) ?? null;
    const pendingToken =
      (await this.ctx.storage.get<string>("codePermitPending")) ?? null;
    if (
      current?.ownerToken === token &&
      pendingToken === token &&
      pruneCodeLease(current, now)?.ownerToken === token
    ) {
      await this.recoverPendingCodePermit();
      return "owner";
    }
    const next = acquireCodeLease(
      current,
      { token, kind, queuedAt: now, browserRouteVersion: 1 },
      now
    );
    await this.persistCodeLeaseTransition(current, next);
    return next.ownerToken === token ? "owner" : "queued";
  }

  /** 释放租约；owner 完成后原子推进 FIFO 队首，再向新 owner 发 permit。 */
  private async releaseVerificationCodeLease(
    token: string,
    ownerFinished = true
  ): Promise<void> {
    const now = Date.now();
    const current =
      (await this.ctx.storage.get<CodeLease>("codeLease")) ?? null;
    const pendingToken =
      (await this.ctx.storage.get<string>("codePermitPending")) ?? null;
    const pruned = pruneCodeLease(current, now);
    if (
      current?.ownerToken === token &&
      pendingToken === token &&
      pruned?.ownerToken === token
    ) {
      // A failed acknowledgement is not proof the node missed the permit.
      // Keep this owner fenced until its 1500s TTL outlives the node's full
      // 780s permit phase + 660s owner budget; immediate promotion could let
      // two browsers send.
      if (!ownerFinished) return;
      try {
        await this.recoverPendingCodePermit();
      } catch (error) {
        console.warn(
          `[CquSession] pending code permit release recovery deferred (${error instanceof Error ? error.name : "unknown"})`
        );
        return;
      }
      const remainingMarker =
        (await this.ctx.storage.get<string>("codePermitPending")) ?? null;
      if (remainingMarker === token) return;
    }
    const next = releaseCodeLease(current, token, now);
    await this.persistCodeLeaseTransition(current, next);
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
    startEvent?: CquEvent,
    deadlineAt?: number
  ): Promise<"in_flight" | "ok" | "failed"> {
    const state = this.state!;
    // deadline 只在操作链入口 resolve 一次:alarm 链由 alarm() 传入;首登(init)链
    // 在此 resolve。内部函数不得再次重新取得 13 分钟预算。
    const operationDeadline =
      deadlineAt ?? resolveBrowserDeadline(undefined, Date.now());

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

    // 原子写锁 + 持久 route:并发发起者只有一个能同时写入两者(无 route 不发 permit,
    // 无锁不点火第二个登录)。transaction 内无网络操作。
    const acquired = await this.acquireRoutedLoginLock("loginInFlight", "cas");
    if (!acquired) return "in_flight";
    const token = acquired.token;
    let runAbort: AbortController | null = null;
    let leaseAcquired = false;

    try {
      // 锁获取跨 await:再核对绑定与状态,撤销/解绑已落地时不点火、不复位状态机。
      // 注意首登(initSession)的占位 state 尚未落盘:storage 无 state 属正常,不据此拦截;
      // 只在已落盘且 userId 不匹配(换绑)或状态已 revoked 时受控退出。预热写回前还会再核对。
      const recheckBinding = async () => {
        const [storedState, currentStatus] = await Promise.all([
          this.ctx.storage.get<SessionState>("state"),
          this.getStatus(),
        ]);
        if (
          (storedState !== undefined && storedState.userId !== state.userId) ||
          currentStatus === "revoked"
        ) {
          throw new CquSsoError(
            "LOGIN_BINDING_CHANGED",
            "binding changed while login was in flight"
          );
        }
      };
      await recheckBinding();
      await this.cleanupExpiredBrowserRoutes();
      // Cloudflare route 先预热(health/bootId/能力)再进入验证码租约与登录;
      // node route 原样返回,不发送新 boot 头。预热结果(带 bootId)供 /run 使用。
      const loginRoute = await this.prepareLoginRoute(
        token,
        acquired.route,
        "loginInFlight",
        recheckBinding
      );
      const password = await decrypt(
        creds.encryptedPassword,
        creds.iv,
        this.env.ENCRYPTION_KEY
      );
      // /run 走集中 transport(按登录 route:CF→用户容器并带 boot 头)。
      // 先点火 /run，让 CAS 与 QuickLogin 可以并行完成密码一因子；节点会在
      // 真正请求验证码前等待 /code-permit。租约未授予时用 AbortSignal 中止在途请求，
      // 避免留下无人 await 的悬空 Promise。
      let permitRole: "owner" | "queued";
      try {
        permitRole = await this.acquireVerificationCodeLease(token, "cas");
        leaseAcquired = true;
      } catch (error) {
        throw error;
      }
      runAbort = new AbortController();
      // CF 预算:剩余 invocation 时间(登录含等码,受 13min 预算裁剪),减 20s 清理余量;
      // AbortSignal 同时覆盖外层 fetch,防止容器/传输悬挂拖住 DO。
      const remainingMs = remainingBrowserBudget(operationDeadline, Date.now());
      const runTimeoutMs = Math.max(1, remainingMs - BROWSER_CLEANUP_MARGIN_MS);
      const runSignal = AbortSignal.any([
        runAbort.signal,
        AbortSignal.timeout(remainingMs),
      ]);
      const runBody: Record<string, unknown> = {
        studentId: state.studentId,
        password,
        service: DUMMY_SERVICE,
        method: "mail",
        session: token,
        queuedPermit: permitRole === "queued",
      };
      if (loginRoute.backend === "cloudflare") {
        runBody.operationTimeoutMs = runTimeoutMs;
      }
      const runHttpRequest = new Request(`${BROWSER_BASE}/run`, {
        method: "POST",
        signal: runSignal,
        body: JSON.stringify(runBody),
      });
      if (loginRoute.backend === "cloudflare" && loginRoute.bootId) {
        runHttpRequest.headers.set("X-Cqu-Expected-Boot-Id", loginRoute.bootId);
      }
      const runRequest = fetchBrowser(
        this.env,
        loginRoute,
        runHttpRequest
      );
      const res = await runRequest;
      const result = await res.json<ContainerRunResult>();
      // M5 回写完整性校验: 除 res.ok/result.ok/result.state 兜空外, 再套 hasValidTgt(升级后的
      // CAS 三件套校验)。容器可能返回 ok 但 state 半残(缺 SESSION/rg_objectid 等), 这种半残态
      // 落盘后下轮取票 storageState 非 null 却缺关键 cookie → 落登录页 409 → 误判过期重登; 故按
      // 失败处理(不顶替旧态)。归类为 transient(半残多是瑞数/网络抖动致导出不全, 非凭据真死),
      // 交 keepalive 退避自愈, 绝不误累计熔断。
      if (!res.ok || !result.ok || !result.state || !hasValidTgt(result.state)) {
        const invalidState = !!result.state && !hasValidTgt(result.state);
        console.warn(
          `[CquSession] ${state.studentId}: container /run not ok — httpStatus=${res.status} ok=${result.ok} hasState=${!!result.state} validTgt=${!invalidState && !!result.state} error=${result.error ?? "(none)"}`
        );
        // 熔断: 把失败归类(凭据真死 vs 瑞数/瞬态)暂存, 供 relogin 决定是否落 needs_reauth。
        // 半残 state(invalidState)归 transient: 不是凭据问题, 不累计凭据熔断。
        this.lastLoginFailReason = invalidState
          ? "transient"
          : classifyLoginFailure(result.error);
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
      await this.clearConsumedLoginCode();
      return "ok";
    } catch (e) {
      console.error(
        `[CquSession] ${state.studentId}: container login error: ${errMsg(e)}`
      );
      // 容器/网络层异常 = 瞬态, 不当凭据死(不累计熔断)。
      this.lastLoginFailReason = "transient";
      await this.failLogin(failEvent);
      return "failed";
    } finally {
      runAbort?.abort();
      try {
        await this.releaseVerificationCodeLease(token, leaseAcquired);
      } catch (error) {
        // 当前登录的成败已确定，permit 轮转失败不应覆盖它；后续
        // 排队登录会按自身超时路径失败并释放租约。日志不包含 token。
        console.error(
          `[CquSession] failed to rotate verification-code permit: ${errMsg(error)}`
        );
      }
      // 只删自己的锁(route 记录保留:迟到邮件/outbox 恢复仍按 token 寻址,
      // 由 expiresAt 与引用清理兜底)。
      const latestLock =
        (await this.ctx.storage.get<LoginInFlight>("loginInFlight")) ?? null;
      if (latestLock?.token === token) {
        await this.ctx.storage.delete("loginInFlight");
      }
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

  /** 取该用户的浏览器登录器容器实例(寻址 CQU_LOGIN 容器 DO: idFromName → get)。 */
  private getLoginContainer(userId: string): DurableObjectStub {
    const id = this.env.CQU_LOGIN.idFromName(userId);
    return this.env.CQU_LOGIN.get(id);
  }

  private browserRouteKey(token: string): string {
    return `${BROWSER_ROUTE_PREFIX}${token}`;
  }

  /**
   * 非登录类浏览器操作(取票/保活/采集)的 route:固定 cloudflare + 当前绑定用户。
   * 这些操作不绑定登录 token(无 boot 头契约),但同样按用户固定容器 ID。
   */
  private currentBrowserRoute(): BrowserRoute {
    return {
      version: 1,
      backend: "cloudflare",
      userId: this.state?.userId ?? "",
    };
  }

  /**
   * 单阶段浏览器操作的出站预算:CF 取 210s 单操作上限与剩余 invocation 时间中
   * 较小者(减去 DO 清理余量后作为 Python operationTimeoutMs)。
   * 剩余不足 30s 时受控抛 BROWSER_DEADLINE,不启动注定做不完的操作。
   */
  private browserOperationBudget(
    deadlineAt: number
  ): { fetchTimeoutMs: number; operationTimeoutMs?: number } {
    const remaining = remainingBrowserBudget(deadlineAt, Date.now());
    const fetchTimeoutMs = Math.min(CONTAINER_BROWSER_DEADLINE_MS, remaining);
    return {
      fetchTimeoutMs,
      operationTimeoutMs: Math.max(
        1,
        fetchTimeoutMs - BROWSER_CLEANUP_MARGIN_MS
      ),
    };
  }

  /**
   * 验证码/permit 控制请求的唯一出口(设计 4.2 的解析顺序):
   *   ① 重新核对 lease.ownerToken 仍是本 token(被替换则停止投递,交调用点原语义);
   *   ② 读持久 browserRoute:<token>,存在则固定用该 route,不看当前全局开关;
   *   ③ 无 route 的旧格式锁/lease(部署前记录)→ 受控失败(腾讯云节点已停用,不外送);
   *   ④ 新格式(version 标记)缺 route / route 用户不匹配 / 缺 bootId → 受控失败,不猜后端;
   * Cloudflare 控制请求携带该 token 预热时的 bootId 头;绝不把同一验证码广播到两个后端。
   */
  private async fetchLoginControl(
    token: string,
    request: Request
  ): Promise<Response> {
    await this.loadState();
    const lease =
      (await this.ctx.storage.get<CodeLease>("codeLease")) ?? null;
    if (lease && lease.ownerToken !== token) {
      throw new CquSsoError(
        "CODE_OWNER_REPLACED",
        "verification code owner was replaced"
      );
    }
    const [record, casLock] = await Promise.all([
      this.ctx.storage.get<LoginRouteRecord>(this.browserRouteKey(token)),
      this.ctx.storage.get<LoginInFlight>("loginInFlight"),
    ]);
    const casLockIsToken = casLock?.token === token;
    const routeVersioned =
      (casLockIsToken && casLock?.browserRouteVersion === 1) ||
      (lease !== null && lease.ownerBrowserRouteVersion === 1);
    const resolution = resolveControlRoute({
      routeRecord: record ?? null,
      routeVersioned,
    });
    if (resolution.outcome === "reject") {
      throw new CquSsoError(
        "CODE_ROUTE_UNAVAILABLE",
        "verification code route unavailable"
      );
    }
    const boundUserId = this.state?.userId ?? null;
    if (!boundUserId || resolution.route.userId !== boundUserId) {
      throw new CquSsoError(
        "CODE_ROUTE_UNAVAILABLE",
        "verification code route user mismatch"
      );
    }
    if (resolution.route.backend === "cloudflare" && !resolution.route.bootId) {
      throw new CquSsoError(
        "CODE_ROUTE_UNAVAILABLE",
        "verification code route missing boot id"
      );
    }
    if (resolution.route.backend === "cloudflare") {
      request.headers.set("X-Cqu-Expected-Boot-Id", resolution.route.bootId!);
    }
    return fetchBrowser(this.env, resolution.route, request);
  }

  /**
   * Cloudflare 登录的路由准备:按用户容器 /health 预热(允许冷启动,30s 预算),
   * 校验 cloudflare profile 与 browser-route-v1/operation-deadline-v1 能力,
   * 成功后把 bootId 写回该 token 的 route(写回前核对 token 与绑定/generation 没变)。
   * node route 不做预热、不带 boot 头,保证准备发布时与原国内服务兼容。
   * 预热完成后调用方才 acquireCodeLease、发 permit、真正登录。
   */
  private async prepareLoginRoute(
    token: string,
    route: BrowserRoute,
    lockKey: string,
    recheck: () => Promise<void>,
    budgetMs: number = LOGIN_ROUTE_PREPARE_BUDGET_MS
  ): Promise<BrowserRoute> {
    if (route.backend !== "cloudflare") return route;
    const deadline = Date.now() + budgetMs;
    const stub = this.getLoginContainer(route.containerKey ?? route.userId);
    let bootId: string | null = null;
    for (;;) {
      try {
        const response = await stub.fetch(
          new Request(`${BROWSER_BASE}/health`, {
            signal: AbortSignal.timeout(LOGIN_ROUTE_HEALTH_TIMEOUT_MS),
          })
        );
        if (response.ok) {
          const payload = (await response.json()) as {
            bootId?: unknown;
            browserProfile?: unknown;
            capabilities?: unknown;
          };
          if (
            typeof payload.bootId === "string" &&
            payload.bootId.length > 0 &&
            payload.browserProfile === "cloudflare" &&
            Array.isArray(payload.capabilities) &&
            payload.capabilities.includes("browser-route-v1") &&
            payload.capabilities.includes("operation-deadline-v1")
          ) {
            bootId = payload.bootId;
            break;
          }
        } else {
          await response.body?.cancel();
        }
      } catch {
        // 冷启动/瞬时失败:在准备预算内重试。
      }
      const now = Date.now();
      if (now >= deadline) {
        throw new CquSsoError(
          "BROWSER_BUSY",
          "browser route preparation timed out"
        );
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(1_000, deadline - now))
      );
    }

    await recheck();
    const key = this.browserRouteKey(token);
    const [record, lock] = await Promise.all([
      this.ctx.storage.get<LoginRouteRecord>(key),
      this.ctx.storage.get<LoginInFlight>(lockKey),
    ]);
    if (record?.token !== token || lock?.token !== token) {
      throw new CquSsoError(
        "CODE_OWNER_REPLACED",
        "login token changed during route preparation"
      );
    }
    const updated: BrowserRoute = { ...route, bootId };
    await this.ctx.storage.put(key, { ...record, route: updated });
    return updated;
  }

  /**
   * 原子获取登录锁并写入该 token 的持久 route 记录(锁删除后投码/outbox 恢复仍可寻址)。
   *
   * transaction 内只做 storage 与纯函数:并发发起者只有一个能把活锁与 route 一起写入;
   * 解密、容器预热、浏览器调用等网络准备都在返回之后由调用方进行。
 * route 的 backend 固定为 cloudflare(腾讯云节点已停用),之后所有该 token 的
 * /run、/code、/code-permit 都固定用这条 route。
   */
  private async acquireRoutedLoginLock(
    lockKey: "loginInFlight",
    kind: "cas"
  ): Promise<{ token: string; route: BrowserRoute } | null> {
    const token = crypto.randomUUID();
    const now = Date.now();
    const route: BrowserRoute = {
      version: 1,
      backend: "cloudflare",
      userId: this.state?.userId ?? "",
    };
    const record: LoginRouteRecord = {
      token,
      kind,
      route,
      createdAt: now,
      expiresAt: now + LOGIN_LOCK_TTL_MS + 60_000,
    };
    let acquired = false;
    await this.ctx.storage.transaction(async (tx) => {
      const existing = await tx.get<LoginInFlight>(lockKey);
      if (!shouldStartLogin(existing ?? null, now)) return;
      await tx.put({
        [lockKey]: { token, startedAt: now, browserRouteVersion: 1 },
        [this.browserRouteKey(token)]: record,
      });
      acquired = true;
    });
    return acquired ? { token, route } : null;
  }

  /**
   * 小范围清理 browserRoute 记录:只删已过期,且不被任一活锁、codeLease owner/queue、
   * codePermitPending 引用的条目。不覆盖业务 alarm,不批量 deleteAll。
   */
  private async cleanupExpiredBrowserRoutes(): Promise<void> {
    const now = Date.now();
    const records = await this.ctx.storage.list<LoginRouteRecord>({
      prefix: BROWSER_ROUTE_PREFIX,
    });
    if (records.size === 0) return;
    const [casLock, lease, permitPending] = await Promise.all([
      this.ctx.storage.get<LoginInFlight>("loginInFlight"),
      this.ctx.storage.get<CodeLease>("codeLease"),
      this.ctx.storage.get<string>("codePermitPending"),
    ]);
    const referenced = new Set<string>();
    if (casLock && !shouldStartLogin(casLock, now)) {
      referenced.add(casLock.token);
    }
    if (lease) {
      referenced.add(lease.ownerToken);
      for (const entry of lease.queue) referenced.add(entry.token);
    }
    if (permitPending) referenced.add(permitPending);
    const doomed: string[] = [];
    for (const [key, record] of records) {
      if (record.expiresAt > now) continue;
      if (referenced.has(record.token)) continue;
      doomed.push(key);
    }
    if (doomed.length > 0) {
      await this.ctx.storage.delete(doomed);
    }
  }
}

function errMsg(e: unknown): string {
  if (e instanceof CquSsoError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}
