// 容器重登的频率/告警策略 —— 纯函数, 无副作用, 便于单测。
// DO 侧只负责从 storage 读写「近期重登发起时刻」并调用这里的判定; 阈值与理由集中在本文件。
//
// 设计依据: docs/plans/2026-06-12-cqu-2fa-email-rebind-design.md §10「限频/告警」。
// 范围说明: §10 的「发码上限」在 v1 通过「重登限频」间接达成(重登少 → CQU 发码少);
// 显式的「每绑定收码上限」放在 email handler 风险高(可能误丢合法码), v1 不做, 记为 deferred。

import type { CquStatus } from "./state-machine";

// 重登限频窗口: 1h。配合 MAX_RELOGINS_PER_WINDOW 构成滑动窗口闸。
export const RELOGIN_RATE_WINDOW_MS = 60 * 60 * 1000; // 1h

// 窗口内最大重登次数。正常节律是 TGT ~8h 硬顶 → 每 7-8h 一次重登(~1 次/8h);
// 6 次/小时远高于正常上限, 是 runaway 后备闸, 永不挡正常运行 —— 只在异常自激
// (如「重登成功但 TGT ~4.8h 早夭」导致的重登过密, 或调度撞车自激循环)时熔断,
// 防止把容器烧穿、把账户对 CQU/瑞数 暴露成可疑高频行为。
export const MAX_RELOGINS_PER_WINDOW = 6;

// 连续重登失败到此阈值即告警: 多半是会话真坏了(密码改了 / 邮件转发断了 / 瑞数变更),
// 单纯重试已无意义, 需要人介入。3 次给瞬时网络抖动留了容错, 又不至于沉默太久。
export const CONSECUTIVE_RELOGIN_FAIL_ALERT = 3;

/**
 * 是否应主动(proactive)重登: 当前 active、已有有效 loginAt、且 TGT 年龄达到阈值。
 *
 * 把原 alarm() 里的内联条件抽成纯函数, 行为完全一致(`>=` 边界含等于):
 *   status === "active" && loginAt > 0 && now - loginAt >= thresholdMs
 *
 * loginAt === 0 表示尚无成功登录(首登占位 state), 不触发; 非 active 状态(binding/
 * relogging/expired/...)也不在此路径主动重登。
 */
export function shouldProactiveRelogin(
  status: CquStatus,
  loginAt: number,
  now: number,
  thresholdMs: number
): boolean {
  return status === "active" && loginAt > 0 && now - loginAt >= thresholdMs;
}

/**
 * 把近期重登时刻裁到窗口内: 保留 now - windowMs <= t <= now 的时刻(含两端边界)。
 * 丢弃过旧(滑出窗口)与未来(时钟漂移)异常时刻。返回新数组, 不改入参。
 */
export function pruneAttempts(
  recentAttempts: number[],
  now: number,
  windowMs: number
): number[] {
  const lowerBound = now - windowMs;
  return recentAttempts.filter((t) => t >= lowerBound && t <= now);
}

/**
 * 是否应限流(熔断本次重登): 把近期时刻裁到窗口后, 数量已达上限。
 * 调用方应先 pruneAttempts 再传入(或传未裁剪数组——这里会自己裁), 二者等价。
 */
export function shouldThrottleRelogin(
  recentAttempts: number[],
  now: number,
  windowMs: number,
  maxInWindow: number
): boolean {
  return pruneAttempts(recentAttempts, now, windowMs).length >= maxInWindow;
}

// ── 熔断(混合): 凭据真死 → needs_reauth; 瑞数/网络瞬态 → 退避自愈 ──────────────
// 连续「凭据」失败到此阈值即落终态 needs_reauth(停 alarm、等用户重绑)。2 次:
// 给偶发误分类留 1 次容错; 又因瑞数间歇(成功即清零), 自愈会话几乎到不了 2 连。
export const MAX_CREDENTIAL_FAILS = 2;

/**
 * 把容器登录失败原因(do_first_factor 的 verdict 字符串)归类为:
 * - "credential": CQU 明确的账密/账号错误码(密码错/用户名或密码/账号锁定冻结)→ 真死, 该重绑。
 * - "transient":  瑞数挑战/限流/未判定/未渲染/网络超时, 以及歧义的『回到登录页(密码错误/
 *                 瑞数软重挑战)』兜底 → 不证明凭据坏, 退避自愈。
 *
 * 关键: **先判 transient/歧义/瑞数标记**, 命中即 transient —— 宁可不终止也不误杀一个
 * 会自愈的瑞数会话(误终止会逼用户重绑, 而重绑同样会被瑞数挡, 徒增挫败)。只有干净的
 * CQU 凭据错误码(不带『回到登录页』包装)才判 credential。空/未知默认 transient。
 */
export function classifyLoginFailure(
  error: string | null | undefined
): "credential" | "transient" {
  const s = error ?? "";
  if (s === "PASSWORD_REJECTED") return "credential";
  if (s.includes("credential_rejected:")) return "credential";
  if (s.includes("transient:")) return "transient";
  const transientMarkers = [
    "BROWSER_BUSY",
    "BROWSER_INSTANCE_REPLACED",
    "BROWSER_DEADLINE",
    "回到登录页",
    "未判定",
    "登录页未渲染",
    "瑞数",
    "限流",
    "超时",
    "timeout",
    "网络",
    "Network",
    "NETWORK",
    "发码",
  ];
  if (transientMarkers.some((m) => s.includes(m))) return "transient";
  const credentialMarkers = [
    "用户名或密码",
    "密码错误",
    "账号",
    "帐号",
    "锁定",
    "冻结",
  ];
  if (credentialMarkers.some((m) => s.includes(m))) return "credential";
  return "transient";
}

/** 连续「凭据」失败计数是否已达到熔断阈值(应落 needs_reauth 终态)。 */
export function shouldRequireReauth(credentialFailures: number): boolean {
  return credentialFailures >= MAX_CREDENTIAL_FAILS;
}

/** Persist the next retry once per failed attempt; polling never resets this cooldown. */
export function recoveryRetryDelayMs(failures: number): number {
  return [60_000, 120_000, 300_000, 600_000][Math.max(0, failures - 1)] ?? 900_000;
}

/**
 * keepalive 探针「瞬态(transient)」失败后下一次 alarm 的延迟(纯函数, 便于单测)。
 * - consecutiveFailures <= fastRetries: 快重试(fastMs), 抓瑞数间歇的放行窗口;
 * - 超过后: 从 baseMs 指数退避, 封顶 capMs —— 止住刷屏 + 降瑞数风控, 但仍会自愈。
 */
export function nextKeepaliveDelayMs(
  consecutiveFailures: number,
  opts: { fastRetries: number; fastMs: number; baseMs: number; capMs: number }
): number {
  if (consecutiveFailures <= opts.fastRetries) return opts.fastMs;
  const steps = consecutiveFailures - opts.fastRetries - 1;
  return Math.min(opts.baseMs * 2 ** steps, opts.capMs);
}
