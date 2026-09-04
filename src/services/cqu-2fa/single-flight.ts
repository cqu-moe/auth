// 锁覆盖排队请求完整生命周期：最多 1620s queued permit phase，成为 owner 后
// 再有 660s 登录预算，另留 60s VPC/清理余量。
// 改 server.py 的 PERMIT_PHASE_TIMEOUT/RUN_TOTAL_TIMEOUT 时必须同步本值。
export const LOGIN_LOCK_TTL_MS = 2340 * 1000;

export function shouldStartLogin(lock: { token: string; startedAt: number } | null, now: number): boolean {
  if (!lock) return true;
  return now - lock.startedAt > LOGIN_LOCK_TTL_MS;
}
