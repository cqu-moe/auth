import { CquSsoError } from "./cqu-sso";

export type BrowserBackend = "node" | "cloudflare";

export interface BrowserRoute {
  version: 1;
  backend: BrowserBackend;
  userId: string;
  /** Cloudflare 登录准备成功后必填;node 不填。 */
  bootId?: string;
}

export interface LoginRouteRecord {
  token: string;
  kind: "cas" | "atrust";
  route: BrowserRoute;
  createdAt: number;
  expiresAt: number;
}

type BrowserEnv = Pick<import("../types").Env, "LOGIN_NODE" | "CQU_LOGIN">;

/**
 * 解析全局后端配置。缺失/空串按旧部署兼容为 node;非法非空值受控报错,
 * 不能误开 Cloudflare,也不存在用户白名单。
 */
export function selectBrowserBackend(value?: string): BrowserBackend {
  if (value === undefined || value === "" || value === "node") return "node";
  if (value === "cloudflare") return "cloudflare";
  throw new CquSsoError(
    "INVALID_BROWSER_CONFIG",
    `Invalid CQU_BROWSER_BACKEND: ${value.trim() === "" ? "whitespace" : "unexpected value"}`
  );
}

/** 本项目 JSON 协议里可透传的稳定错误码(设计第 7.1 节)。 */
const STABLE_PROTOCOL_ERRORS = new Set([
  "BROWSER_BUSY",
  "BROWSER_INSTANCE_REPLACED",
  "BROWSER_DEADLINE",
  "ATRUST_SESSION_EXPIRED",
  "ATRUST_NEEDS_REAUTH",
]);

/**
 * 集中浏览器 transport:node 走 LOGIN_NODE;cloudflare 按用户固定容器 ID。
 *
 * 容量类状态(429/503)先识别本项目 JSON 协议中的稳定错误并保留 code
 * (尤其不能把 BROWSER_DEADLINE 改成 BUSY);平台非 JSON 或不符合协议的响应
 * 清理响应流后归 BROWSER_BUSY,只记状态码,不回显正文。其余状态(如 409 boot
 * mismatch)原样返回,由调用点分类,不能把所有 409 当过期。
 */
export async function fetchBrowser(
  env: BrowserEnv,
  route: BrowserRoute,
  request: Request
): Promise<Response> {
  if (route.backend === "node") return env.LOGIN_NODE.fetch(request);
  const id = env.CQU_LOGIN.idFromName(route.userId);
  const response = await env.CQU_LOGIN.get(id).fetch(request);
  if (response.status === 429 || response.status === 503) {
    const protocolError = await readProtocolError(response);
    if (protocolError && STABLE_PROTOCOL_ERRORS.has(protocolError)) {
      throw new CquSsoError(protocolError, `Browser backend reported ${protocolError}`);
    }
    // json() 成功时 body 已被消费,cancel 会抛 Invalid state;清理尽力而为即可。
    try {
      await response.body?.cancel();
    } catch {
      // body 已消费或已关闭,无需清理。
    }
    throw new CquSsoError(
      "BROWSER_BUSY",
      `Browser capacity unavailable (HTTP ${response.status})`
    );
  }
  return response;
}

async function readProtocolError(response: Response): Promise<string | null> {
  try {
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) return null;
    const body: unknown = await response.json();
    if (
      typeof body === "object" &&
      body !== null &&
      (body as { ok?: unknown }).ok === false &&
      typeof (body as { error?: unknown }).error === "string"
    ) {
      return (body as { error: string }).error;
    }
    return null;
  } catch {
    return null;
  }
}
