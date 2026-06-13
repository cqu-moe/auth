const SSO_BASE = "https://sso.cqu.edu.cn";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 10_000;

/**
 * fetch wrapper with a hard timeout. A hung connection to CQU (common when
 * Cloudflare's edge can't reach the campus network) would otherwise stall the
 * caller until the platform's ~180s wall-clock limit. Any network-level
 * failure is normalized to CquSsoError("NETWORK_ERROR") so callers can tell a
 * transient outage apart from a genuine auth rejection.
 */
async function ssoFetch(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    throw new CquSsoError(
      "NETWORK_ERROR",
      `CQU SSO unreachable: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

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

export function parseLoginPage(html: string): LoginPageParams {
  const execution = extractValue(html, "login-page-flowkey");
  const croypto = extractValue(html, "login-croypto");
  const captchaId = extractText(html, "captchaId");

  if (!execution || !croypto) {
    const isServiceError = html.includes("noDocking") || html.includes("canot-access-code");
    throw new CquSsoError(
      "PARSE_ERROR",
      isServiceError
        ? "SSO service URL not registered (服务未对接)"
        : "Failed to parse SSO login page"
    );
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

/**
 * 纯 fetch CQU SSO 客户端。
 *
 * 历史的密码登录 `login()`(纯 fetch 重放表单)已退役 —— CQU 2026-06 上线
 * 「增强登录」(密码 + 密保邮箱 2FA + 瑞数 WAF)后, 纯 fetch 发码必被瑞数判 412、
 * Angular-XHR 第一因素判 400, 整条密码登录链路走不通。首登/重登一律改走
 * CF Containers 里的 patchright 浏览器登录器(见 cqu-login-container / container/)。
 *
 * 本客户端只保留对瑞数豁免的「热路径」: 凭已有 `SOURCEID_TGC` 等 3 个 cookie 换
 * service ticket(`getServiceTicket`)、在线探活(`checkOnline`)。
 */
export class CquSsoClient {
  async getServiceTicket(
    cookies: CasCookies,
    serviceUrl: string
  ): Promise<string> {
    const resp = await ssoFetch(
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
      // 诊断: 非 302 时读 body 做页面分类, 区分「真 CAS 登录页(真过期)」与
      // 「瑞数挑战页(误判)」。只读 body 做分类, 绝不记录 body 原文; 分类结果随
      // 错误消息上抛, 供 keepalive 日志观测。302 成功路径不受影响(此处仅失败分支)。
      const body = await resp.text().catch(() => "");
      const cls = classifyNon302Body(body);
      throw new CquSsoError(
        "TGT_EXPIRED",
        "CAS session expired, got status " + resp.status + " page=" + cls
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
    const resp = await ssoFetch(`${SSO_BASE}/onlineCheck`, {
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

/**
 * 诊断: 把 getServiceTicket 非 302 返回的页面 body 粗分类, 用于区分热路径取 ST
 * 失败到底是「真过期」还是「瑞数误判」。**只看特征字符串做分类, 不记录 body 原文。**
 *
 * - "cas-login":     含 CAS 登录页特征(login-croypto / login-page-flowkey) → 真过期。
 * - "waf-challenge": 含瑞数特征(CtLgrmkSWHBZ / botgate / debugger) 且无 CAS 标记 → 疑似误判。
 * - "other":         两者都不命中 → 未知页面。
 *
 * 注意: 先判 CAS 标记 —— 瑞数挑战脚本也可能混进 CAS 登录页, 真登录页应优先认定为真过期。
 */
function classifyNon302Body(body: string): "cas-login" | "waf-challenge" | "other" {
  const hasCasMarker =
    body.includes("login-croypto") || body.includes("login-page-flowkey");
  if (hasCasMarker) return "cas-login";
  const hasWafMarker =
    body.includes("CtLgrmkSWHBZ") ||
    body.includes("botgate") ||
    body.includes("debugger");
  if (hasWafMarker) return "waf-challenge";
  return "other";
}
