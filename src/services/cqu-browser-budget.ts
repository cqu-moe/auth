import { CquSsoError } from "./cqu-sso";

/** 单次浏览器 invocation 的端到端时间预算(Queue consumer/alarm 平台上限 15 分钟)。 */
export const BROWSER_INVOCATION_BUDGET_MS = 13 * 60_000;

/** 单个容器浏览器操作(冷启动+排队+执行+清理)的单阶段保护上限。 */
export const CONTAINER_BROWSER_DEADLINE_MS = 210_000;

/** DO 在截止时间前预留的处理/清理余量。 */
export const BROWSER_CLEANUP_MARGIN_MS = 20_000;

/** 开始新浏览器操作前必须保留的最小剩余时间。 */
const MIN_REMAINING_BROWSER_MS = 30_000;

/**
 * 归一化外部传入的浏览器截止时间。
 *
 * 调用顺序是先 resolve、再 remaining;不能直接信任外部传入 NaN/Infinity/字符串。
 * 学校/应用等待计时不依赖客户端本地时钟:服务端始终把上限钳制到当前时间 + 预算。
 */
export function resolveBrowserDeadline(value: unknown, now: number): number {
  if (value === undefined) return now + BROWSER_INVOCATION_BUDGET_MS;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new CquSsoError("INVALID_BROWSER_DEADLINE", "Invalid browser deadline");
  }
  if (value <= now) {
    throw new CquSsoError("BROWSER_DEADLINE", "Browser deadline elapsed");
  }
  return Math.min(value, now + BROWSER_INVOCATION_BUDGET_MS);
}

/** 剩余预算不足 30 秒时直接受控失败,不启动注定做不完的浏览器操作。 */
export function remainingBrowserBudget(deadlineAt: number, now: number): number {
  const ms = deadlineAt - now;
  if (ms < MIN_REMAINING_BROWSER_MS) {
    throw new CquSsoError("BROWSER_DEADLINE", "Insufficient browser time");
  }
  return ms;
}
