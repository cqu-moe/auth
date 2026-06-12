// 锁 TTL 必须 > 容器单次登录上限：container/server.py 的 RUN_TOTAL_TIMEOUT(660s)
// 再加 DO→容器往返余量。否则一份「合法在途」的登录会被误判为 stale，放第二个并发
// 登录进来——后者会覆盖锁 token、对账户二次发码、并与前者抢着写 cookies(竞态)。
// 不变式：LOGIN_LOCK_TTL_MS(720s) > RUN_TOTAL_TIMEOUT(660s) > CODE_WAIT_TIMEOUT(570s)，
// 且 CODE_WAIT_TIMEOUT(570s) < 2FA 码有效期(600s)并留提交余量。RUN_TOTAL(660s) 覆盖
// 第一因素 + 570s 等码 + 提交/开销；TTL 必须超过 RUN_TOTAL，合法在途的登录才不会被误判为 stale。
// 改 RUN_TOTAL_TIMEOUT 时必须同步上调本值。
export const LOGIN_LOCK_TTL_MS = 720 * 1000; // 720s > 容器 RUN_TOTAL_TIMEOUT(660s) + DO 跳数余量

export function shouldStartLogin(lock: { token: string; startedAt: number } | null, now: number): boolean {
  if (!lock) return true;
  return now - lock.startedAt > LOGIN_LOCK_TTL_MS;
}
