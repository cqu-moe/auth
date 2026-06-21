// 国内登录节点(container/server.py)出站协议的纯函数判定层 —— 无 `cloudflare:*`/DO 依赖,
// 只 import 类型, 故可在 vitest 的 Node pool 直接 import 单测(DO 本体因 `cloudflare:workers`
// import 在 Node pool 测不了, 把可判定逻辑下沉到此)。镜像 cqu-2fa/relogin-policy 的分工:
// 纯判定集中在本文件, DO 只负责 storage 读写 + 出站 fetch + 调用这些纯函数。
import { CquSsoError, type CquStorageState } from "./cqu-sso";

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

/**
 * 回写完整性校验: state 的 cookies 里是否存在非空 SOURCEID_TGC(TGT)。
 * keepalive 回写「节点刷新后的 state」前用它把关 —— 节点导出的 refreshed state 可能半截/退化
 * (如 {cookies:[],origins:[]} 空但 truthy), 无 TGT 的 state 顶替好 state 会让下轮取票
 * storageState 非 null 却无 TGT → 落登录页 409 → 误判过期重登。仅当此函数为 true 才允许覆盖。
 */
export function hasValidTgt(state: CquStorageState | null): boolean {
  return tgtFromState(state).length > 0;
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
  return {
    kind: "transient",
    detail: `not ok (status=${status} error=${body.error ?? "(none)"})`,
  };
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
