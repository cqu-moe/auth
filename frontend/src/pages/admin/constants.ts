import { PRESETS } from "../../../src/capabilities";

// 子系统中文名(展示用;键来自 CAPABILITIES,缺省回退键名本身)。
export const SUBSYSTEM_LABELS: Record<string, string> = {
  calendar: "日历",
  eval: "评教",
  cqu: "CQU 服务",
};

export const PRESET_NAMES = Object.keys(PRESETS);

export const ALL_CQU_SCOPES = [
  { key: "cqu:ticket:jwxt", label: "教务系统 (jwxt)" },
  { key: "cqu:ticket:jxpj", label: "教学评价 (jxpj)" },
  { key: "cqu:ticket:library", label: "图书馆 (library)" },
  { key: "cqu:ticket:card", label: "校园卡 (card)" },
];
export const CQU_SCOPE_KEYS = new Set(ALL_CQU_SCOPES.map((s) => s.key));

export const GRANT_TYPE_OPTIONS = [
  { value: "authorization_code", label: "授权码 (authorization_code)" },
  { value: "client_credentials", label: "客户端凭据 (client_credentials)" },
  { value: "refresh_token", label: "刷新令牌 (refresh_token)" },
];

export const CLIENT_TYPE_OPTIONS = [
  { value: "web", label: "Web 应用 (web)" },
  { value: "native", label: "原生应用 (native)" },
  { value: "user-agent-based", label: "纯前端应用 (user-agent-based)" },
];

export const AUTH_METHOD_OPTIONS = [
  { value: "none", label: "无 (none)" },
  { value: "client_secret_basic", label: "Basic (client_secret_basic)" },
  { value: "client_secret_post", label: "Post (client_secret_post)" },
];

export const ROLE_OPTIONS = [
  { value: "user", label: "普通用户" },
  { value: "admin", label: "管理员" },
];

// Read the message from a non-2xx response. The backend's errorResponse shape is
// { detail: { error: { code, message } } }, so read that path (not body.error).
export async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as {
      detail?: { error?: { message?: string } };
    };
    return body?.detail?.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}
