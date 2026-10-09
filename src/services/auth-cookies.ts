import { isCquMoeHost } from "../utils/cookie-domain";

export function isolatedAuthCookies(baseURL: string) {
  const secure = new URL(baseURL).protocol === "https:";
  return {
    // Native automatic prefixing would turn __Host- into __Secure-__Host-.
    useSecureCookies: false,
    cookiePrefix: secure ? "__Host-auth-v2" : "auth-v2",
    defaultCookieAttributes: { secure, httpOnly: true, path: "/", sameSite: "lax" as const },
    crossSubDomainCookies: { enabled: false },
  };
}

const legacyNames = new Set(["session_token", "session_data", "account_data", "dont_remember", "two_factor", "trust_device", "oauth_state", "admin_session", "better-auth-passkey"]);
export function expireLegacyAuthCookies(headers: Headers, cookie: string | undefined, baseURL: string) {
  // Finite known names plus bounded cache chunks; never echo arbitrary input.
  const names = new Set<string>();
  for (const entry of (cookie ?? "").split(";")) {
    const name = entry.trim().split("=", 1)[0];
    const match = /^(?:__Secure-)?better-auth\.([a-z_-]+)(?:\.(\d{1,2}))?$/.exec(name);
    if (!match || !legacyNames.has(match[1])) continue;
    if (match[2] && (!["session_data", "account_data"].includes(match[1]) || Number(match[2]) > 31)) continue;
    names.add(name);
  }
  for (const name of names) {
    const attributes = `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${new URL(baseURL).protocol === "https:" ? "; Secure" : ""}`;
    headers.append("Set-Cookie", attributes);
    if (isCquMoeHost(baseURL)) headers.append("Set-Cookie", `${attributes}; Domain=cqu.moe`);
  }
}
