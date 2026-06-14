/**
 * True iff baseURL's hostname is exactly "cqu.moe" or a subdomain of it
 * (e.g. "auth.cqu.moe", "calendar.cqu.moe"). False for localhost / loopback /
 * malformed URLs / look-alike hosts (the suffix check matches on a ".cqu.moe"
 * dot boundary, so "evil-cqu.moe.attacker.com" → hostname "attacker.com" → false,
 * and "cqu.moe.attacker.com" → false).
 *
 * Gates the cross-subdomain cookie Domain attribute: setting Domain=cqu.moe on a
 * non-cqu.moe response (e.g. the localhost dev server BETTER_AUTH_URL=
 * http://localhost:8787) makes the browser REJECT the cookie, breaking dev login.
 */
export function isCquMoeHost(baseURL: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(baseURL).hostname;
  } catch {
    return false;
  }
  return hostname === "cqu.moe" || hostname.endsWith(".cqu.moe");
}
