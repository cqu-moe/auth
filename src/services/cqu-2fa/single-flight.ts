// 锁 TTL 必须 > 容器单次登录上限：container/server.py 的 RUN_TOTAL_TIMEOUT(540s)
// 再加 DO→容器往返余量。否则一份「合法在途」的登录会被误判为 stale，放第二个并发
// 登录进来——后者会覆盖锁 token、对账户二次发码、并与前者抢着写 cookies(竞态)。
// 600s 同时也压在 2FA 验证码 600s 有效期上限附近：到这一刻容器的那次登录要么已成功、
// 要么验证码已过期，再放一份新登录进来才是合理的。改 RUN_TOTAL_TIMEOUT 时必须同步上调本值。
export const LOGIN_LOCK_TTL_MS = 600 * 1000; // 600s > 容器 RUN_TOTAL_TIMEOUT(540s) + DO 跳数余量

export function shouldStartLogin(lock: { token: string; startedAt: number } | null, now: number): boolean {
  if (!lock) return true;
  return now - lock.startedAt > LOGIN_LOCK_TTL_MS;
}
