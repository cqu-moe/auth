export const REDIRECT_QUERY_PARAM = "redirect";

/**
 * RFC 3986 strict encoding. Unlike encodeURIComponent this also escapes
 * ! ' ( ) * ~ so the value stays inside better-auth's relative-callbackURL
 * allowlist (its query charset is [\w\-.+/=&%@]).
 */
function encodeQueryValueStrict(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*~]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function isAllowedRedirectHost(hostname: string): boolean {
  if (hostname === "cqu.moe" || hostname.endsWith(".cqu.moe")) return true;
  // Local dev frontends (e.g. schedule's vite server) still round-trip
  // through the deployed auth service.
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * Only same-app relative paths and http(s) URLs on cqu.moe (or loopback for
 * development) may be used as post-login targets. Everything else — including
 * protocol-relative and credential-prefixed URLs — is rejected to prevent
 * open redirects.
 */
export function sanitizePostLoginRedirect(
  candidate: string | null | undefined
): string | null {
  if (!candidate) return null;

  if (candidate.startsWith("/")) {
    if (candidate.startsWith("//") || candidate.startsWith("/\\")) return null;
    return candidate;
  }

  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return isAllowedRedirectHost(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
}

export function postLoginRedirectFromSearch(search: string): string | null {
  return sanitizePostLoginRedirect(
    new URLSearchParams(search).get(REDIRECT_QUERY_PARAM)
  );
}

export function withRedirectParam(
  path: string,
  redirectTarget: string | null | undefined
): string {
  if (!redirectTarget) return path;
  const joiner = path.includes("?") ? "&" : "?";
  return `${path}${joiner}${REDIRECT_QUERY_PARAM}=${encodeQueryValueStrict(redirectTarget)}`;
}

export function isExternalHttpTarget(target: string): boolean {
  return target.startsWith("http://") || target.startsWith("https://");
}
