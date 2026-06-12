// 锁 TTL 必须 > 容器单次登录上限：container/server.py 的 RUN_TOTAL_TIMEOUT(300s)
// 再加 DO→容器往返余量。否则一份「合法在途」的登录会被误判为 stale，放第二个并发
// 登录进来——后者会覆盖锁 token、对账户二次发码、并与前者抢着写 cookies(竞态)。
export const LOGIN_LOCK_TTL_MS = 330 * 1000; // 330s > 容器 RUN_TOTAL_TIMEOUT(300s) + DO 跳数余量

export function shouldStartLogin(lock: { token: string; startedAt: number } | null, now: number): boolean {
  if (!lock) return true;
  return now - lock.startedAt > LOGIN_LOCK_TTL_MS;
}
