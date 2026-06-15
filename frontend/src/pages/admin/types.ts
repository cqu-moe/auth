export interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  banned: boolean;
  createdAt: string;
}

// 一行 entitlement:GET /api/admin/users/:id/entitlements 返回的原始记录。
export interface EntitlementRow {
  userId: string;
  subsystem: string;
  capability: string;
  value: string;
  updatedAt?: string | number;
}

export interface UsersResponse {
  data: User[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// Full OAuth client config as returned by GET /api/admin/oauth-clients (snake_case).
export interface ClientConfig {
  id: string;
  client_id: string;
  client_name: string | null;
  client_uri: string | null;
  logo_uri: string | null;
  tos_uri: string | null;
  policy_uri: string | null;
  contacts: string[];
  redirect_uris: string[];
  post_logout_redirect_uris: string[];
  token_endpoint_auth_method: string | null;
  grant_types: string[];
  response_types: string[];
  scope: string;
  type: string | null;
  require_pkce: boolean;
  skip_consent: boolean;
  enable_end_session: boolean;
  subject_type: string | null;
  disabled: boolean;
  metadata: unknown;
  // Legacy compat fields (may also be present): clientId, name
}

// Body sent to POST/PATCH /api/admin/oauth-clients (snake_case, flat).
// Optional fields are omitted entirely when empty rather than sent as null/[]:
// the create endpoint's zod schema rejects null on optional strings/enums and
// rejects [] on .min(1) arrays, so empty values must not appear in the payload.
export interface ClientPayload {
  client_name?: string;
  client_uri?: string;
  logo_uri?: string;
  tos_uri?: string;
  policy_uri?: string;
  contacts?: string[];
  redirect_uris: string[];
  post_logout_redirect_uris?: string[];
  token_endpoint_auth_method?: string;
  grant_types: string[];
  response_types: string[];
  scope?: string;
  type?: string;
  require_pkce: boolean;
  skip_consent: boolean;
  enable_end_session: boolean;
  metadata?: unknown;
}

// --- Editor form state ---
export interface EditorState {
  client_name: string;
  redirect_uris: string[];
  scope: string;
  grant_types: string[];
  type: string;
  skip_consent: boolean;
  // advanced
  client_uri: string;
  logo_uri: string;
  tos_uri: string;
  policy_uri: string;
  contacts: string[];
  post_logout_redirect_uris: string[];
  require_pkce: boolean;
  token_endpoint_auth_method: string;
  response_types: string[];
  enable_end_session: boolean;
  metadata: string;
  // CQU scopes
  cqu_scopes: string[];
}

// 表单态:flag → boolean(勾选=授权);quota → 字符串(空=无限,否则数字串)。
// key = `${subsystem}.${capability}`。Save 为整组替换(full replace):
// 仅把勾选的 flag(value "1")与非空 quota(value 数字串)发给 PUT,
// 未勾/空缺省即「false / 无限」。
export type EntitlementForm = Record<string, { flag?: boolean; quota?: string }>;

export type Tab = "users" | "oauth";
