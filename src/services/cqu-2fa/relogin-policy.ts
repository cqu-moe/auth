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
