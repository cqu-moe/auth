import type { SsoCookie } from "./contracts";

const SSO_DOMAINS = new Set(["sso.cqu.edu.cn", ".sso.cqu.edu.cn"]);
const SAME_SITE_VALUES = new Set(["Strict", "Lax", "None"]);
const MAX_COOKIE_COUNT = 64;
const MAX_COOKIE_BYTES = 256 * 1_024;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function invalidRequest(): never {
  throw new Error("INVALID_REQUEST");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasPartitionMetadata(value: Record<string, unknown>): boolean {
  return Object.keys(value).some((key) => key.toLowerCase().includes("partition"));
}

function parseCookie(value: unknown): SsoCookie {
  if (!isRecord(value)) invalidRequest();
  if (hasPartitionMetadata(value)) throw new Error("PROTOCOL_UNSUPPORTED");

  const { name, domain, path, sameSite, expires } = value;
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    CONTROL_CHARACTERS.test(name) ||
    typeof value.value !== "string" ||
    typeof domain !== "string" ||
    !SSO_DOMAINS.has(domain) ||
    typeof path !== "string" ||
    !path.startsWith("/") ||
    CONTROL_CHARACTERS.test(path) ||
    typeof value.secure !== "boolean" ||
    typeof value.httpOnly !== "boolean" ||
    typeof sameSite !== "string" ||
    !SAME_SITE_VALUES.has(sameSite) ||
    typeof expires !== "number" ||
    !Number.isFinite(expires) ||
    (expires < 0 && expires !== -1)
  ) {
    invalidRequest();
  }

  return {
    name,
    value: value.value,
    domain: domain as SsoCookie["domain"],
    path,
    secure: value.secure,
    httpOnly: value.httpOnly,
    sameSite: sameSite as SsoCookie["sameSite"],
    expires,
  };
}

export function validateSsoCookies(value: unknown, now: number): SsoCookie[] {
  if (!Number.isFinite(now) || !Array.isArray(value)) invalidRequest();
  if (value.length > MAX_COOKIE_COUNT) invalidRequest();

  const nowSeconds = now / 1_000;
  const cookies = value
    .map(parseCookie)
    .filter((cookie) => cookie.expires === -1 || cookie.expires > nowSeconds);
  const keys = new Set<string>();

  for (const cookie of cookies) {
    const key = `${cookie.domain}\u0000${cookie.path}\u0000${cookie.name}`;
    if (keys.has(key)) invalidRequest();
    keys.add(key);
  }

  if (
    !cookies.some(
      (cookie) => cookie.name === "SOURCEID_TGC" && cookie.value.length > 0
    )
  ) {
    invalidRequest();
  }

  if (
    new TextEncoder().encode(JSON.stringify(cookies)).length > MAX_COOKIE_BYTES
  ) {
    invalidRequest();
  }

  return cookies;
}

export function extractSsoCookies(
  storageState: string,
  now: number
): SsoCookie[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(storageState);
  } catch {
    invalidRequest();
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.cookies)) invalidRequest();

  const ssoCookies = parsed.cookies.filter((value) => {
    if (!isRecord(value) || typeof value.domain !== "string") invalidRequest();
    return SSO_DOMAINS.has(value.domain);
  });

  return validateSsoCookies(ssoCookies, now);
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export async function digestSsoCookies(cookies: SsoCookie[]): Promise<string> {
  const canonical = cookies
    .slice()
    .sort(
      (left, right) =>
        compareText(left.domain, right.domain) ||
        compareText(left.path, right.path) ||
        compareText(left.name, right.name)
    )
    .map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      expires: cookie.expires,
    }));
  const input = new TextEncoder().encode(JSON.stringify(canonical));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
}
