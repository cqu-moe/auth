import type { BrowserRoute } from "../cqu-browser-routing";

export function quickloginContainerKey(
  userId: string,
  deviceId: string
): string {
  if (!userId || !deviceId || deviceId.includes(":")) {
    throw new Error("INVALID_REQUEST");
  }
  return `quicklogin:${userId}:${deviceId}`;
}

export function quickloginBrowserRoute(
  userId: string,
  deviceId: string
): BrowserRoute {
  return {
    version: 1,
    backend: "cloudflare",
    userId,
    containerKey: quickloginContainerKey(userId, deviceId),
  };
}
