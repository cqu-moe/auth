export const LOGIN_LOCK_TTL_MS = 3 * 60 * 1000; // 3min：超时视为崩溃，允许重抢

export function shouldStartLogin(lock: { token: string; startedAt: number } | null, now: number): boolean {
  if (!lock) return true;
  return now - lock.startedAt > LOGIN_LOCK_TTL_MS;
}
