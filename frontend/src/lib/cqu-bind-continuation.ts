import { sanitizePostLoginRedirect, withRedirectParam } from "./post-login-redirect";

const authPages = new Set(["/login", "/register", "/two-factor", "/verify-email"]);

export function protectedLoginUrl(pathname: string, search: string): string {
  return withRedirectParam("/login", sanitizePostLoginRedirect(pathname + search));
}

export function verificationContinuation(pathname: string, search: string): string | null {
  if (authPages.has(pathname)) {
    return sanitizePostLoginRedirect(new URLSearchParams(search).get("redirect"));
  }
  return sanitizePostLoginRedirect(pathname + search);
}

export function bindingReturnTarget(candidate: string | null, authOrigin: string): string | null {
  if (!candidate || /[\u0000-\u0020\\]/.test(candidate)) return null;
  const safe = sanitizePostLoginRedirect(candidate);
  if (!safe || safe.startsWith("/")) return null;
  const url = new URL(safe);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.origin === authOrigin) return null;
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
  return url.toString();
}
