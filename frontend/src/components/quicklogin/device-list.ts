export const QUICKLOGIN_REVOKE_WARNING =
  "退出后将停止此设备的快捷登录；已登录的学校系统可能仍保持登录。";

export function isDeviceOnline(lastSeenAt: number | null, now = Date.now()): boolean {
  return lastSeenAt !== null && now >= lastSeenAt && now - lastSeenAt <= 10 * 60_000;
}
