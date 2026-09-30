// 锁覆盖排队请求完整生命周期：接棒最坏在 owner 恢复围栏(1500s)后，再走
// 780s permit phase + 660s 登录预算，另留恢复/清理余量(#27 对齐后无独立
// queued 档；容器侧预算恒被 DO 的 13min 调用截止钳制)。
// 改 server.py 的 PERMIT_PHASE_TIMEOUT/RUN_TOTAL_TIMEOUT 时必须同步本值。
export const LOGIN_LOCK_TTL_MS = 2340 * 1000;

export function shouldStartLogin(lock: { token: string; startedAt: number } | null, now: number): boolean {
  if (!lock) return true;
  return now - lock.startedAt > LOGIN_LOCK_TTL_MS;
}
