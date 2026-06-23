// 国内登录节点(container/server.py)出站协议的纯函数判定层 —— 无 `cloudflare:*`/DO 依赖,
// 只 import 类型, 故可在 vitest 的 Node pool 直接 import 单测(DO 本体因 `cloudflare:workers`
// import 在 Node pool 测不了, 把可判定逻辑下沉到此)。镜像 cqu-2fa/relogin-policy 的分工:
// 纯判定集中在本文件, DO 只负责 storage 读写 + 出站 fetch + 调用这些纯函数。
import { CquSsoError, type CquStorageState, type CasCookies } from "./cqu-sso";
import type { CquStatus } from "./cqu-2fa/state-machine";

// DO 侧 LOGIN_NODE.fetch 的出站 deadline。节点单请求最坏总时长 ≈ QUEUE_WAIT(排队 35s)+
// overall_timeout(持槽 45s)≈ 80s(见 container/cqu_ticket_browser.py 顶部注释)。取 90s 略大于
// 80s 留余量, 让节点能先返回自己的 409/502 语义而非被 DO 中途 abort; 仍兜住「节点 backlog 时
// DO 被无限拖住」(DO 单线程串行, 长 fetch 阻塞该用户后续请求)。**不套在 /run 上**(登录含
// 2FA 邮件往返可达数分钟, 见 containerLogin)。
export const NODE_DEADLINE_MS = 90_000;

/**
 * 从完整 storageState 取 TGT(SOURCEID_TGC cookie 值)。
 * 缺失 / 值空 / state=null 一律返回 ""(**不抛**), 供诊断(decodeJwtExp)与水化判定共用。
 */
export function tgtFromState(state: CquStorageState | null): string {
  return state?.cookies.find((c) => c.name === "SOURCEID_TGC")?.value ?? "";
}

// CAS 会话关键 cookie 三件套(对齐 cqu-sso.ts 的 CasCookies/formatCasCookies 契约)。
// 取票热路径必须同时凭这三个 cookie 才能换 ST; 缺任一 state 即半残。
const REQUIRED_CAS_COOKIES = [
  "SOURCEID_TGC",
  "SESSION",
  "rg_objectid",
] as const satisfies readonly (keyof CasCookies)[];

/**
 * 回写完整性校验: state 的 cookies 里 CAS 三件套(SOURCEID_TGC + SESSION + rg_objectid)
 * 是否都存在且非空。
 * keepalive 回写「节点刷新后的 state」前用它把关 —— 节点导出的 refreshed state 可能半截/退化
 * (如 {cookies:[],origins:[]} 空但 truthy), 半残 state 顶替好 state 会让下轮取票
 * storageState 非 null 却缺关键 cookie → 落登录页 409 → 误判过期重登。仅当此函数为 true 才允许覆盖。
 *
 * M5 纵深加固: 由「仅 SOURCEID_TGC 非空」升级为「三件套齐」, 对齐既有 3-cookie 契约。
 * 不强制 origins/localStorage 非空(哪些 localStorage load-bearing 需真节点实测, 不在静态层硬编码)。
 */
export function hasValidTgt(state: CquStorageState | null): boolean {
  if (!state) return false;
  return REQUIRED_CAS_COOKIES.every((name) =>
    state.cookies.some((c) => c.name === name && c.value.length > 0)
  );
}

// 节点 /service-ticket 响应分类结果。DO 据此映射回既有 CquSsoError 语义(对调用方无感):
//   - "ok":        200 {ok:true, ticket} → 返回 ticket
//   - "expired":   409 → TGT_EXPIRED(真过期, 交重登, 不重试)
//   - "transient": 502 / 非 JSON / 缺 ticket / 其它非 ok → WAF_CHALLENGE(瞬态, 重试已在节点端做尽)
export type NodeTicketKind = "ok" | "expired" | "transient";

export interface NodeTicketClassification {
  kind: NodeTicketKind;
  // kind==="ok" 时为票面; 否则携带一句脱敏诊断(绝不含 ticket/cookies/state 原文)。
  ticket?: string;
  detail?: string;
}

// 节点 /service-ticket 的 JSON body 契约(字段全可选, 防御性解析)。
export interface NodeTicketBody {
  ok?: boolean;
  ticket?: string;
  error?: string;
}

/**
 * 把节点 /service-ticket 的 (status, body) 映射为 {kind, ticket?, detail?}。
 * body 传 null 表示「响应非 JSON / 解析失败」—— 归 transient。
 * 判定顺序: 409 优先(语义最明确) → 非 JSON(null body) → ok+ticket → 其余 transient。
 *
 * H5 纵深脱敏: detail 会经 CquSsoError.message 透传 route → 客户端/日志, 故**绝不**把节点回的
 * raw `body.error` 原样拼进 detail(节点回的字符串可能含 cookie/state 片段)。detail 只保留
 * 由我方控制的稳定锚点(status / 路径名), 节点 raw 串一律不入。
 */
export function classifyNodeTicketResponse(
  status: number,
  body: NodeTicketBody | null
): NodeTicketClassification {
  if (status === 409) {
    return { kind: "expired", detail: `node /service-ticket 409` };
  }
  if (body === null) {
    return { kind: "transient", detail: `non-JSON (status=${status})` };
  }
  const httpOk = status >= 200 && status < 300;
  if (httpOk && body.ok && body.ticket) {
    return { kind: "ok", ticket: body.ticket };
  }
  // body.error 刻意不回显(见上 H5 注释): 只记 status 作诊断锚点。
  return {
    kind: "transient",
    detail: `not ok (status=${status})`,
  };
}

// ── data-harvest 节点出站协议(organic harvest) ─────────────────────────────
// 单条 capture/fetch 结果(对齐 container/cqu_data_harvest.harvest 返回结构)。
export interface HarvestCapture {
  url: string;
  status: number;
  contentType: string;
  body: string;
}
export interface HarvestFetch {
  url: string;
  status: number;
  body: string;
}

// 节点 /data-harvest 的 JSON body 契约(字段全可选, 防御性解析)。
export interface NodeHarvestBody {
  ok?: boolean;
  captures?: HarvestCapture[];
  fetches?: HarvestFetch[];
  error?: string;
}

export interface NodeHarvestClassification {
  kind: NodeTicketKind; // 复用 "ok" | "expired" | "transient"
  captures?: HarvestCapture[];
  fetches?: HarvestFetch[];
  detail?: string;
}

/**
 * 把节点 /data-harvest 的 (status, body) 映射为 {kind, captures?, fetches?, detail?}。
 * 判定顺序: 409 优先(会话失效, 交 needs_reauth/重登) → 非 JSON(null body)→ ok → 其余 transient。
 * 脱敏: detail 只保留 status 锚点, 绝不回显节点 raw error(可能含 state/cookie 片段)。
 */
export function classifyNodeHarvestResponse(
  status: number,
  body: NodeHarvestBody | null
): NodeHarvestClassification {
  if (status === 409) {
    return { kind: "expired", detail: "node /data-harvest 409" };
  }
  if (body === null) {
    return { kind: "transient", detail: `non-JSON (status=${status})` };
  }
  const httpOk = status >= 200 && status < 300;
  if (httpOk && body.ok) {
    return {
      kind: "ok",
      captures: body.captures ?? [],
      fetches: body.fetches ?? [],
    };
  }
  return { kind: "transient", detail: `not ok (status=${status})` };
}

/**
 * 把分类结果落成 DO 既有语义: ok → 返回 ticket; expired → CquSsoError("TGT_EXPIRED");
 * transient → CquSsoError("WAF_CHALLENGE")。统一在此抛, 让 mintServiceTicketViaNode 只调一处。
 */
export function ticketFromClassification(c: NodeTicketClassification): string {
  if (c.kind === "ok") {
    // 防御: 分类器已保证 ok 时 ticket 存在, 但显式兜底避免返回 undefined。
    if (c.ticket) return c.ticket;
    throw new CquSsoError("WAF_CHALLENGE", "LOGIN_NODE /service-ticket ok but no ticket");
  }
  if (c.kind === "expired") {
    throw new CquSsoError(
      "TGT_EXPIRED",
      `CQU session expired (${c.detail ?? "node /service-ticket"})`
    );
  }
  throw new CquSsoError(
    "WAF_CHALLENGE",
    `LOGIN_NODE /service-ticket ${c.detail ?? "transient"}`
  );
}

// runKeepAlive transient 分支把节点 body.detail 入 console 前的脱敏白名单截断(纵深防御)。
// 节点 T2 已改为只回类型名(如 "TimeoutException: ..."), DO 侧再截断长度 + 只保留首段,
// 防 state 片段意外入 CF observability。
const MAX_DETAIL_LEN = 120;

/**
 * 截断 + 收窄节点回传的 detail 字段供日志使用。非字符串 → "(none)"; 否则取首行、压空白、
 * 截到 MAX_DETAIL_LEN。绝不保证语义完整, 只为「短且无 state 片段」的诊断锚点。
 */
export function sanitizeNodeDetail(detail: unknown): string {
  if (typeof detail !== "string" || detail.length === 0) return "(none)";
  const firstLine = detail.split("\n", 1)[0].replace(/\s+/g, " ").trim();
  if (firstLine.length === 0) return "(none)";
  return firstLine.length > MAX_DETAIL_LEN
    ? `${firstLine.slice(0, MAX_DETAIL_LEN)}…`
    : firstLine;
}

// ── H2: state 落盘体量守卫(告警阈值 / 硬上限分离) ──────────────────────────
// DO 单个 storage value 物理硬上限 128KiB。完整 storageState(cookie + 2 origin
// localStorage)体量不受控, 越过上限 → ctx.storage.put 抛 → 若发生在 alarm 内会被 CF
// 自动重试 → 重走 active 分支(keepalive 又真铸 ST + 又记账)→ 重复铸票环 + state 永远
// 写不进。故把判定下沉为纯函数, DO put 前据此分流:
//   · > WARN(100KiB) 且 ≤ HARD       → 照常 put, 仅告警(approaching limit)
//   · > HARD(120KiB, 留 ~8KiB 余量) → 不 put(超限会抛), 降级保留旧 state, alarm 永不抛穿
//
// 度量说明: serializedStateBytes 用 JSON.stringify 的 UTF-8 字节数, 这是 DO structured-clone
// 实际落盘体量的**保守近似代理**(两者不是同一度量: structured-clone 可能更省也可能更费 —— 字符串
// 用 UTF-16/紧凑表示、布尔/数字非文本化, 但带类型标签/对齐开销)。故余量不能贴着物理上限取, 按经验
// 放宽到 ~8KiB, 吸收 structured-clone 偏大时的差额。DO value 物理上限 128KiB。

// 告警阈值: 留 ~28KiB 余量预警。
export const STORAGE_STATE_WARN_BYTES = 100 * 1024;
// 硬上限: 取 120KiB(< DO 物理 128KiB, 留 ~8KiB 余量吸收 structured-clone 与 JSON 字节的度量差额
// + storage 框架开销/键名), 超此即拒 put。
export const STATE_HARD_LIMIT_BYTES = 120 * 1024;

/**
 * 序列化任意值并返回其 UTF-8 字节数。**不抛** —— 不可序列化(循环引用等)返回 Infinity,
 * 由 stateExceedsHardLimit 据此按「超限」处理(降级保旧态), 绝不让序列化异常冒泡到 alarm。
 */
export function serializedStateBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** state 序列化字节数是否越过 DO put 的硬上限(超此 put 必抛, 应降级不落盘)。 */
export function stateExceedsHardLimit(bytes: number): boolean {
  return bytes > STATE_HARD_LIMIT_BYTES;
}

// ── M7: keepalive/relogin 写回 active 前的防复活守卫 ───────────────────────
// runKeepAlive 的 LOGIN_NODE.fetch(最长 90s)await 期间 input gate 打开, admin
// revoke/unbind 可能把 status 改成撤销/解绑/需重登。fetch 返回 active 后若无条件
// setStatus("active")+putState+setAlarm 会**复活已撤销会话**。所有写回 active 的分支
// (alarm active / expired→relogin / proactive-relogin)在写回前重查 status, 命中下列
// 终态/撤销态即放弃本轮。
const ABANDON_WRITEBACK_STATUSES: ReadonlySet<CquStatus> = new Set<CquStatus>([
  "revoked",
  "unbound",
  "needs_reauth",
]);

/**
 * 写回前据当前 status 判定是否放弃本轮 keepalive/relogin 写回。
 * 返回 true(放弃)当 status ∈ {revoked, unbound, needs_reauth} —— 这些是 alarm 进入后
 * 被 admin/熔断改写的撤销/解绑/终态, 此时绝不能 setStatus("active") 把会话复活。
 */
export function shouldAbandonKeepaliveWriteback(
  currentStatus: CquStatus
): boolean {
  return ABANDON_WRITEBACK_STATUSES.has(currentStatus);
}

// ── I-1: st_mint 审计行构造(DRY, 杜绝三处手写导致 schema 漂移) ────────────────
// st_mint 审计 JSON 行原在三处手写: getServiceTicket 取票成功、recordKeepaliveMint 正常分支、
// recordKeepaliveMint 记账 put 失败的 catch 分支(后者多 recorded:false + err)。三处字段集合/顺序
// 必须一致, 改 schema 漏改一处会让审计字段错配。故下沉为本纯构造函数, 三处共用。
// 与既有 KEEPALIVE_CLIENT_ID/SOURCE 提常量「杜绝漏改」同一意图。
//
// 关键: 返回对象的字段插入顺序固定为 {evt,userId,clientId,host,broad,source,ts}, 与历史手写完全一致
// (JSON.stringify 按插入序序列化)。catch 分支需追加的 recorded/err 由调用方 spread 后置(留在 DO 侧,
// 因 err=errMsg(e) 是运行时副作用), 追加键序列化在末尾 → 与历史 catch 行逐字节等价。
// 绝不含 ticket / cookies / 密码 / state 原文。

/** st_mint 审计行字段(全部由我方控制的稳定锚点, 无敏感原文)。 */
export interface StMintAuditFields {
  userId: string;
  // route 路径 clientId 可空(自成限频桶); keepalive 用专属哨兵常量, 故 string | null。
  clientId: string | null;
  host: string;
  // broad = serviceUrl 广路径模式; 符号 key / keepalive 探针为 false。
  broad: boolean;
  // 取票入口标记: "route" / "keepalive" 等。
  source: string;
  ts: number;
}

/** st_mint 审计行(`evt:"st_mint"`)。字段顺序固定, 三处 emit 共用以杜绝 schema 漂移。 */
export function buildStMintAudit(fields: StMintAuditFields): {
  evt: "st_mint";
  userId: string;
  clientId: string | null;
  host: string;
  broad: boolean;
  source: string;
  ts: number;
} {
  return {
    evt: "st_mint",
    userId: fields.userId,
    clientId: fields.clientId,
    host: fields.host,
    broad: fields.broad,
    source: fields.source,
    ts: fields.ts,
  };
}
