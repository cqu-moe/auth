// 锁覆盖完整请求生命周期：FIFO permit 阶段最多 780s，成为 owner 后再有 660s
// 登录预算。合法排队者不能在轮到自己前被当 stale，故留 60s VPC/清理余量。
// 改 server.py 的 PERMIT_PHASE_TIMEOUT/RUN_TOTAL_TIMEOUT 时必须同步本值。
export const LOGIN_LOCK_TTL_MS = 1500 * 1000;

export function shouldStartLogin(lock: { token: string; startedAt: number } | null, now: number): boolean {
  if (!lock) return true;
  return now - lock.startedAt > LOGIN_LOCK_TTL_MS;
}
