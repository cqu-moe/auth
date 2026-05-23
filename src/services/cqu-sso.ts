import { encryptAesEcb } from "./crypto";

const SSO_BASE = "https://sso.cqu.edu.cn";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export class CquSsoError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
    this.name = "CquSsoError";
  }
}

export interface LoginPageParams {
  execution: string;
  croypto: string;
  captchaId: string | null;
}

export interface CasCookies {
  SOURCEID_TGC: string;
  SESSION: string;
  rg_objectid: string;
}

export interface LoginResult {
  cookies: CasCookies;
  serviceTicket: string;
}

export function parseLoginPage(html: string): LoginPageParams {
  const execution = extractValue(html, "login-page-flowkey");
  const croypto = extractValue(html, "login-croypto");
  const captchaId = extractText(html, "captchaId");

  if (!execution || !croypto) {
    throw new CquSsoError("PARSE_ERROR", "Failed to parse SSO login page");
  }
  return { execution, croypto, captchaId };
}

function extractValue(html: string, id: string): string | null {
  // Match both value="..." attribute and >text< content
  const regex = new RegExp(
    `id=["']${id}["'][^>]*(?:value=["']([^"']+)["']|>([^<]+)<)`,
    "s"
  );
  const match = html.match(regex);
  return match?.[1] ?? match?.[2] ?? null;
}

function extractText(html: string, id: string): string | null {
  const regex = new RegExp(`id=["']${id}["'][^>]*>([^<]*)`, "s");
  const match = html.match(regex);
  return match?.[1]?.trim() || null;
}

export class CquSsoClient {
  async login(
    username: string,
    password: string,
    serviceUrl: string = "https://sso.cqu.edu.cn/onlineCheck"
  ): Promise<LoginResult> {
    // Step 1: Get login page
    const pageResp = await fetch(
      `${SSO_BASE}/login?service=${encodeURIComponent(serviceUrl)}`,
      {
        headers: { "User-Agent": BROWSER_UA },
        redirect: "manual",
      }
    );
    const html = await pageResp.text();
    const params = parseLoginPage(html);
    const sessionCookies = parseCookies(pageResp.headers);

    // Step 2: Encrypt password with croypto key
    const encryptedPassword = encryptAesEcb(password, params.croypto);
    const captchaPayload = encryptAesEcb("{}", params.croypto);

    // Step 3: Submit login form
    const form = new URLSearchParams({
      username,
      password: encryptedPassword,
      type: "UsernamePassword",
      execution: params.execution,
      _eventId: "submit",
      croypto: params.croypto,
      captcha_payload: captchaPayload,
      geolocation: "",
    });

    const loginResp = await fetch(
      `${SSO_BASE}/login?service=${encodeURIComponent(serviceUrl)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": BROWSER_UA,
          Cookie: formatCookies(sessionCookies),
        },
        redirect: "manual",
        body: form.toString(),
      }
    );

    if (loginResp.status !== 302) {
      throw new CquSsoError(
        "LOGIN_FAILED",
        "CAS login failed: expected 302, got " + loginResp.status
      );
    }

    const location = loginResp.headers.get("Location") ?? "";
    const ticketMatch = location.match(/ticket=(ST-[^&]+)/);
    if (!ticketMatch) {
      throw new CquSsoError(
        "NO_TICKET",
        "No service ticket in redirect location"
      );
    }

    const allCookies = { ...sessionCookies, ...parseCookies(loginResp.headers) };

    return {
      cookies: {
        SOURCEID_TGC: allCookies["SOURCEID_TGC"] ?? "",
        SESSION: allCookies["SESSION"] ?? "",
        rg_objectid: allCookies["rg_objectid"] ?? "",
      },
      serviceTicket: ticketMatch[1],
    };
  }

  async getServiceTicket(
    cookies: CasCookies,
    serviceUrl: string
  ): Promise<string> {
    const resp = await fetch(
      `${SSO_BASE}/login?service=${encodeURIComponent(serviceUrl)}`,
      {
        headers: {
          "User-Agent": BROWSER_UA,
          Cookie: formatCasCookies(cookies),
        },
        redirect: "manual",
      }
    );

    if (resp.status !== 302) {
      throw new CquSsoError(
        "TGT_EXPIRED",
        "CAS session expired, got status " + resp.status
      );
    }

    const location = resp.headers.get("Location") ?? "";
    const match = location.match(/ticket=(ST-[^&]+)/);
    if (!match) {
      throw new CquSsoError("NO_TICKET", "No ticket in redirect");
    }
    return match[1];
  }

  async checkOnline(cookies: CasCookies): Promise<boolean> {
    const resp = await fetch(`${SSO_BASE}/onlineCheck`, {
      headers: {
        "User-Agent": BROWSER_UA,
        Cookie: formatCasCookies(cookies),
      },
    });
    return resp.status === 200;
  }
}

function formatCasCookies(cookies: CasCookies): string {
  return `SOURCEID_TGC=${cookies.SOURCEID_TGC}; SESSION=${cookies.SESSION}; rg_objectid=${cookies.rg_objectid}`;
}

function parseCookies(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  // Workers runtime supports getSetCookie()
  const setCookies =
    (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  for (const cookie of setCookies) {
    const [nameValue] = cookie.split(";");
    const eqIdx = nameValue.indexOf("=");
    if (eqIdx > 0) {
      result[nameValue.substring(0, eqIdx).trim()] = nameValue
        .substring(eqIdx + 1)
        .trim();
    }
  }
  return result;
}

function formatCookies(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}
