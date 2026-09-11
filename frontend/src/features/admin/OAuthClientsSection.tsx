import { useState, useEffect, useCallback } from "react";
import { adminFetch } from "../../lib/api/admin";
import { CopyButton, FieldLabel, Modal, StringListInput, Toggle, inputClass } from "./ui";


interface ClientConfig {
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

// Body sent to POST/PATCH /admin/oauth-clients (snake_case, flat).
// Optional fields are omitted entirely when empty rather than sent as null/[]:
// the create endpoint's zod schema rejects null on optional strings/enums and
// rejects [] on .min(1) arrays, so empty values must not appear in the payload.
interface ClientPayload {
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

const ALL_CQU_SCOPES = [
  { key: "cqu:ticket:jwxt", label: "教务系统 (jwxt)" },
  { key: "cqu:ticket:jxpj", label: "教学评价 (jxpj)" },
  { key: "cqu:ticket:library", label: "图书馆 (library)" },
  { key: "cqu:ticket:card", label: "校园卡 (card)" },
];
const CQU_SCOPE_KEYS = new Set(ALL_CQU_SCOPES.map((s) => s.key));

const GRANT_TYPE_OPTIONS = [
  { value: "authorization_code", label: "授权码 (authorization_code)" },
  { value: "client_credentials", label: "客户端凭据 (client_credentials)" },
  { value: "refresh_token", label: "刷新令牌 (refresh_token)" },
];

const CLIENT_TYPE_OPTIONS = [
  { value: "web", label: "Web 应用 (web)" },
  { value: "native", label: "原生应用 (native)" },
  { value: "user-agent-based", label: "纯前端应用 (user-agent-based)" },
];

const AUTH_METHOD_OPTIONS = [
  { value: "none", label: "无 (none)" },
  { value: "client_secret_basic", label: "Basic (client_secret_basic)" },
  { value: "client_secret_post", label: "Post (client_secret_post)" },
];


// Read the message from a non-2xx response. The backend's errorResponse shape is
// { detail: { error: { code, message } } }, so read that path (not body.error).
async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as {
      detail?: { error?: { message?: string } };
    };
    return body?.detail?.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

function CredentialModal({
  title,
  clientId,
  clientSecret,
  onClose,
}: {
  title: string;
  clientId?: string;
  clientSecret: string;
  onClose: () => void;
}) {
  return (
    <Modal onClose={onClose} maxWidth="max-w-lg">
      <div className="p-6">
        <h3 className="text-base font-semibold text-gray-900 mb-1">{title}</h3>
        <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
          密钥仅显示一次，请立即妥善保存。关闭后将无法再次查看。
        </div>

        {clientId && (
          <div className="mb-3">
            <FieldLabel>Client ID</FieldLabel>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs font-mono bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 break-all">
                {clientId}
              </code>
              <CopyButton value={clientId} />
            </div>
          </div>
        )}

        <div className="mb-5">
          <FieldLabel>Client Secret</FieldLabel>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs font-mono bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 break-all">
              {clientSecret}
            </code>
            <CopyButton value={clientSecret} />
          </div>
        </div>

        <div className="flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors"
          >
            我已保存
          </button>
        </div>
      </div>
    </Modal>
  );
}

// --- Delete confirmation ---
function DeleteConfirmModal({
  clientName,
  loading,
  onConfirm,
  onCancel,
}: {
  clientName: string;
  loading: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal onClose={onCancel} maxWidth="max-w-md">
      <div className="p-6">
        <h3 className="text-base font-semibold text-gray-900 mb-2">删除 OAuth 客户端</h3>
        <p className="text-sm text-gray-600 mb-5">
          确定要删除客户端 <span className="font-medium text-gray-900">{clientName}</span> 吗？此操作不可撤销，相关的 CQU 服务权限也会一并清除。
        </p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={loading}
            className="px-4 py-2 text-sm font-medium rounded-lg border border-gray-200 hover:bg-gray-50 disabled:opacity-50 transition-colors"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-red-600 hover:bg-red-700 text-white disabled:bg-red-400 flex items-center gap-1.5 transition-colors"
          >
            {loading && <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />}
            删除
          </button>
        </div>
      </div>
    </Modal>
  );
}

// --- Editor form state ---
interface EditorState {
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

function emptyEditorState(): EditorState {
  return {
    client_name: "",
    redirect_uris: [""],
    scope: "openid profile email",
    grant_types: ["authorization_code"],
    type: "web",
    skip_consent: false,
    client_uri: "",
    logo_uri: "",
    tos_uri: "",
    policy_uri: "",
    contacts: [],
    post_logout_redirect_uris: [],
    require_pkce: true,
    token_endpoint_auth_method: "client_secret_basic",
    response_types: ["code"],
    enable_end_session: false,
    metadata: "",
    cqu_scopes: [],
  };
}

function stateFromClient(client: ClientConfig, cquScopes: string[]): EditorState {
  return {
    client_name: client.client_name ?? "",
    redirect_uris: client.redirect_uris.length ? client.redirect_uris : [""],
    // CQU scopes live in their own checkbox section; keep them out of the text
    // field so the two don't duplicate (buildPayload re-merges them on save).
    scope: (client.scope ?? "")
      .split(" ")
      .filter((s) => s && !CQU_SCOPE_KEYS.has(s))
      .join(" "),
    grant_types: client.grant_types.length ? client.grant_types : ["authorization_code"],
    type: client.type ?? "web",
    skip_consent: client.skip_consent,
    client_uri: client.client_uri ?? "",
    logo_uri: client.logo_uri ?? "",
    tos_uri: client.tos_uri ?? "",
    policy_uri: client.policy_uri ?? "",
    contacts: client.contacts,
    post_logout_redirect_uris: client.post_logout_redirect_uris,
    require_pkce: client.require_pkce,
    token_endpoint_auth_method: client.token_endpoint_auth_method ?? "client_secret_basic",
    response_types: client.response_types.length ? client.response_types : ["code"],
    enable_end_session: client.enable_end_session,
    metadata:
      client.metadata == null
        ? ""
        : typeof client.metadata === "string"
          ? client.metadata
          : JSON.stringify(client.metadata, null, 2),
    cqu_scopes: cquScopes,
  };
}

// Drop empty strings and trim entries from a string list.
function cleanList(list: string[]): string[] {
  return list.map((s) => s.trim()).filter((s) => s.length > 0);
}

// --- OAuth client editor (create + edit) ---
function OAuthClientEditor({
  client,
  onClose,
  onSaved,
  onCreated,
}: {
  client: ClientConfig | null; // null = create mode
  onClose: () => void;
  onSaved: () => void;
  // Called in create mode with the one-time secret so the parent can display it.
  onCreated: (s: { clientId: string; clientSecret: string }) => void;
}) {
  const isEdit = client !== null;
  const [state, setState] = useState<EditorState>(emptyEditorState);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [loading, setLoading] = useState(false);
  const [initLoading, setInitLoading] = useState(isEdit);
  const [error, setError] = useState("");
  const [rotating, setRotating] = useState(false);
  const [rotatedSecret, setRotatedSecret] = useState<string | null>(null);
  // Set once a create succeeds: the editor then targets that client (PATCH), so
  // retrying after a failed CQU-scope save updates it instead of re-creating.
  const [createdId, setCreatedId] = useState<string | null>(null);

  // In edit mode, hydrate form (and fetch CQU scopes) once.
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    const load = async () => {
      setInitLoading(true);
      let scopes: string[] = [];
      try {
        const res = await adminFetch(`/admin/oauth-clients/${client.id}/scopes`);
        if (res.ok) {
          const data = (await res.json()) as { scopes: string[] };
          scopes = data.scopes ?? [];
        }
      } catch {
        // Non-fatal: fall back to empty CQU scopes; editing other fields still works.
      }
      if (!cancelled) {
        setState(stateFromClient(client, scopes));
        setInitLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [client]);

  const patch = <K extends keyof EditorState>(key: K, value: EditorState[K]) =>
    setState((prev) => ({ ...prev, [key]: value }));

  const toggleGrant = (value: string) => {
    setState((prev) => ({
      ...prev,
      grant_types: prev.grant_types.includes(value)
        ? prev.grant_types.filter((g) => g !== value)
        : [...prev.grant_types, value],
    }));
  };

  const toggleCquScope = (key: string) => {
    setState((prev) => ({
      ...prev,
      cqu_scopes: prev.cqu_scopes.includes(key)
        ? prev.cqu_scopes.filter((s) => s !== key)
        : [...prev.cqu_scopes, key],
    }));
  };

  // Build the snake_case payload; returns null + sets error on validation failure.
  // Empty optional fields are omitted (never sent as null/empty-string/[]): the
  // create endpoint's zod schema rejects those. On edit (adapter direct write),
  // an omitted field simply means "leave unchanged" — v1 has no way to clear a
  // field back to empty, which is an accepted limitation.
  const buildPayload = (): ClientPayload | null => {
    const redirectUris = cleanList(state.redirect_uris);
    if (redirectUris.length === 0) {
      setError("至少需要一条回调 URI");
      return null;
    }
    if (state.grant_types.length === 0) {
      setError("至少需要选择一种授权类型");
      return null;
    }

    let metadata: unknown = undefined;
    if (state.metadata.trim()) {
      try {
        metadata = JSON.parse(state.metadata);
      } catch {
        setError("metadata 不是合法的 JSON");
        return null;
      }
    }

    // Always-valid required/boolean fields.
    const payload: ClientPayload = {
      redirect_uris: redirectUris,
      grant_types: state.grant_types,
      response_types: state.response_types.length ? state.response_types : ["code"],
      skip_consent: state.skip_consent,
      require_pkce: state.require_pkce,
      enable_end_session: state.enable_end_session,
    };

    // Optional strings: include only when non-empty after trimming.
    const clientName = state.client_name.trim();
    if (clientName) payload.client_name = clientName;
    // The client's OAuth scopes must include the selected CQU scopes, or the
    // provider rejects cqu:ticket:* with invalid_scope before the ticket
    // middleware ever consults oauth_client_cqu_scopes. Merge them (deduped).
    const scope = [
      ...new Set([
        ...state.scope.split(" ").filter(Boolean),
        ...state.cqu_scopes,
      ]),
    ].join(" ");
    if (scope) payload.scope = scope;
    const clientUri = state.client_uri.trim();
    if (clientUri) payload.client_uri = clientUri;
    const logoUri = state.logo_uri.trim();
    if (logoUri) payload.logo_uri = logoUri;
    const tosUri = state.tos_uri.trim();
    if (tosUri) payload.tos_uri = tosUri;
    const policyUri = state.policy_uri.trim();
    if (policyUri) payload.policy_uri = policyUri;

    // Optional enums: include only when truthy.
    if (state.type) payload.type = state.type;
    if (state.token_endpoint_auth_method) {
      payload.token_endpoint_auth_method = state.token_endpoint_auth_method;
    }

    // Optional .min(1) arrays: include only when non-empty after cleaning.
    const contacts = cleanList(state.contacts);
    if (contacts.length) payload.contacts = contacts;
    const postLogoutUris = cleanList(state.post_logout_redirect_uris);
    if (postLogoutUris.length) payload.post_logout_redirect_uris = postLogoutUris;

    if (metadata !== undefined) payload.metadata = metadata;
    return payload;
  };

  // Persist CQU scopes via PUT .../scopes. Returns false on failure (caller surfaces).
  const saveCquScopes = async (clientId: string): Promise<boolean> => {
    try {
      const res = await adminFetch(`/admin/oauth-clients/${clientId}/scopes`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scopes: state.cqu_scopes }),
      });
      if (!res.ok) {
        setError(await readErrorMessage(res, "保存 CQU 服务权限失败"));
        return false;
      }
      return true;
    } catch {
      setError("网络错误，保存 CQU 服务权限失败");
      return false;
    }
  };

  const handleSave = async () => {
    setError("");
    const payload = buildPayload();
    if (!payload) return;

    setLoading(true);
    try {
      // Target an existing client, or one we already created in this session
      // (after a create that failed only at the CQU-scope step).
      const targetId = client?.id ?? createdId;
      if (targetId) {
        const res = await adminFetch(`/admin/oauth-clients/${targetId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          setError(await readErrorMessage(res, "保存失败，请稍后重试"));
          return;
        }
        // Switching a public client to confidential mints a new secret, returned
        // once — surface it like create/rotate.
        const patchBody = (await res.json()) as {
          data?: { client_secret?: string };
        };
        const ok = await saveCquScopes(targetId);
        if (!ok) return;
        if (patchBody.data?.client_secret) {
          onCreated({ clientId: targetId, clientSecret: patchBody.data.client_secret });
        }
        onSaved();
      } else {
        const res = await adminFetch(`/admin/oauth-clients`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          setError(await readErrorMessage(res, "创建失败，请稍后重试"));
          return;
        }
        const data = (await res.json()) as {
          data: { client_id: string; client_secret?: string };
        };
        const newClientId = data.data.client_id;
        // The client now exists; bind the editor to it so a retry PATCHes
        // instead of creating a duplicate.
        setCreatedId(newClientId);
        // Public clients (token_endpoint_auth_method: "none") have no secret, so
        // only surface the one-time credential modal when a secret was issued.
        if (data.data.client_secret) {
          onCreated({ clientId: newClientId, clientSecret: data.data.client_secret });
        }
        // Persist CQU scopes. If this fails the client exists but is missing
        // scopes, so keep the editor open with the error (saveCquScopes set it)
        // rather than silently closing as success — the admin can retry.
        const scopesOk =
          state.cqu_scopes.length === 0
            ? true
            : await saveCquScopes(newClientId);
        if (!scopesOk) return;
        onSaved();
      }
    } catch {
      setError("网络错误，请稍后重试");
    } finally {
      setLoading(false);
    }
  };

  const handleRotate = async () => {
    if (!client) return;
    setError("");
    setRotating(true);
    try {
      const res = await adminFetch(`/admin/oauth-clients/${client.id}/rotate-secret`, {
        method: "POST",
      });
      if (!res.ok) {
        setError(await readErrorMessage(res, "重新生成密钥失败"));
        return;
      }
      const data = (await res.json()) as {
        data: { client_id: string; client_secret: string };
      };
      setRotatedSecret(data.data.client_secret);
    } catch {
      setError("网络错误，请稍后重试");
    } finally {
      setRotating(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <h3 className="text-base font-semibold text-gray-900">
          {isEdit ? "编辑 OAuth 客户端" : "新建 OAuth 客户端"}
        </h3>
        <button
          onClick={onClose}
          className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
          aria-label="关闭"
        >
          ×
        </button>
      </div>

      <div className="p-6 space-y-5">
        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {error}
            <button onClick={() => setError("")} className="ml-2 underline">关闭</button>
          </div>
        )}

        {initLoading ? (
          <div className="flex items-center gap-2 text-gray-400 text-sm py-8">
            <div className="w-5 h-5 border-2 border-gray-300 border-t-transparent rounded-full animate-spin" />
            加载中...
          </div>
        ) : (
          <>
            {isEdit && client && (
              <div>
                <FieldLabel>Client ID</FieldLabel>
                <code className="block text-xs font-mono bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 break-all text-gray-600">
                  {client.client_id}
                </code>
              </div>
            )}

            {/* --- Essentials --- */}
            <div>
              <FieldLabel>名称</FieldLabel>
              <input
                type="text"
                value={state.client_name}
                onChange={(e) => patch("client_name", e.target.value)}
                placeholder="我的应用"
                className={inputClass}
              />
            </div>

            <div>
              <FieldLabel hint="至少一条">回调 URI (redirect_uris)</FieldLabel>
              <StringListInput
                values={state.redirect_uris}
                onChange={(v) => patch("redirect_uris", v)}
                placeholder="https://example.com/callback"
                addLabel="添加回调 URI"
              />
            </div>

            <div>
              <FieldLabel hint="空格分隔">允许的 scope</FieldLabel>
              <input
                type="text"
                value={state.scope}
                onChange={(e) => patch("scope", e.target.value)}
                placeholder="openid profile email"
                className={`${inputClass} font-mono`}
              />
            </div>

            <div>
              <FieldLabel>授权类型 (grant_types)</FieldLabel>
              <div className="space-y-1.5">
                {GRANT_TYPE_OPTIONS.map((opt) => (
                  <label
                    key={opt.value}
                    className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-50 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={state.grant_types.includes(opt.value)}
                      onChange={() => toggleGrant(opt.value)}
                      className="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                    />
                    <span className="text-sm text-gray-700">{opt.label}</span>
                  </label>
                ))}
              </div>
            </div>

            <div>
              <FieldLabel>客户端类型 (type)</FieldLabel>
              <select
                value={state.type}
                onChange={(e) => patch("type", e.target.value)}
                className={inputClass}
              >
                {CLIENT_TYPE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>

            <Toggle
              checked={state.skip_consent}
              onChange={(v) => patch("skip_consent", v)}
              label="跳过同意页"
              hint="授权时不向用户展示同意页面"
            />

            {/* --- Advanced --- */}
            <div className="border-t border-gray-100 pt-4">
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className="text-sm font-medium text-blue-600 hover:text-blue-700"
              >
                {showAdvanced ? "▾ 收起完整配置" : "▸ 展开完整配置"}
              </button>
            </div>

            {showAdvanced && (
              <div className="space-y-5">
                <div>
                  <FieldLabel>应用主页 (client_uri)</FieldLabel>
                  <input type="text" value={state.client_uri} onChange={(e) => patch("client_uri", e.target.value)} placeholder="https://example.com" className={inputClass} />
                </div>
                <div>
                  <FieldLabel>Logo URL (logo_uri)</FieldLabel>
                  <input type="text" value={state.logo_uri} onChange={(e) => patch("logo_uri", e.target.value)} placeholder="https://example.com/logo.png" className={inputClass} />
                </div>
                <div>
                  <FieldLabel>服务条款 (tos_uri)</FieldLabel>
                  <input type="text" value={state.tos_uri} onChange={(e) => patch("tos_uri", e.target.value)} placeholder="https://example.com/tos" className={inputClass} />
                </div>
                <div>
                  <FieldLabel>隐私政策 (policy_uri)</FieldLabel>
                  <input type="text" value={state.policy_uri} onChange={(e) => patch("policy_uri", e.target.value)} placeholder="https://example.com/privacy" className={inputClass} />
                </div>
                <div>
                  <FieldLabel>联系人 (contacts)</FieldLabel>
                  <StringListInput
                    values={state.contacts}
                    onChange={(v) => patch("contacts", v)}
                    placeholder="admin@example.com"
                    addLabel="添加联系人"
                  />
                </div>
                <div>
                  <FieldLabel>登出回调 URI (post_logout_redirect_uris)</FieldLabel>
                  <StringListInput
                    values={state.post_logout_redirect_uris}
                    onChange={(v) => patch("post_logout_redirect_uris", v)}
                    placeholder="https://example.com/logout"
                    addLabel="添加登出回调 URI"
                  />
                </div>
                <Toggle
                  checked={state.require_pkce}
                  onChange={(v) => patch("require_pkce", v)}
                  label="要求 PKCE"
                  hint="授权码流程强制使用 PKCE"
                />
                <div>
                  <FieldLabel>令牌端点认证方式 (token_endpoint_auth_method)</FieldLabel>
                  <select
                    value={state.token_endpoint_auth_method}
                    onChange={(e) => patch("token_endpoint_auth_method", e.target.value)}
                    className={inputClass}
                  >
                    {AUTH_METHOD_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <FieldLabel hint="固定为 code">响应类型 (response_types)</FieldLabel>
                  <input
                    type="text"
                    value={state.response_types.join(" ")}
                    readOnly
                    className={`${inputClass} font-mono bg-gray-50 text-gray-500`}
                  />
                </div>
                <Toggle
                  checked={state.enable_end_session}
                  onChange={(v) => patch("enable_end_session", v)}
                  label="启用结束会话端点"
                  hint="允许通过 end_session 端点登出"
                />
                <div>
                  <FieldLabel hint="提交前解析 JSON">metadata</FieldLabel>
                  <textarea
                    value={state.metadata}
                    onChange={(e) => patch("metadata", e.target.value)}
                    placeholder='{"key": "value"}'
                    rows={4}
                    className={`${inputClass} font-mono resize-y`}
                  />
                </div>
              </div>
            )}

            {/* --- CQU service scopes --- */}
            <div className="border-t border-gray-100 pt-4">
              <p className="text-xs font-medium text-gray-700 mb-2">CQU 服务权限</p>
              <div className="space-y-1">
                {ALL_CQU_SCOPES.map((scope) => (
                  <label
                    key={scope.key}
                    className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-50 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={state.cqu_scopes.includes(scope.key)}
                      onChange={() => toggleCquScope(scope.key)}
                      className="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                    />
                    <span className="text-sm text-gray-700">{scope.label}</span>
                    <span className="text-xs text-gray-400 font-mono ml-auto">{scope.key}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* --- Secret (edit mode only) --- */}
            {isEdit && state.token_endpoint_auth_method !== "none" && (
              <div className="border-t border-gray-100 pt-4">
                <p className="text-xs font-medium text-gray-700 mb-2">客户端密钥</p>
                <p className="text-xs text-gray-400 mb-3">出于安全考虑，现有密钥不会显示。重新生成后旧密钥立即失效。</p>
                <button
                  type="button"
                  onClick={handleRotate}
                  disabled={rotating}
                  className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 hover:bg-gray-50 disabled:opacity-50 flex items-center gap-1.5 transition-colors"
                >
                  {rotating && <span className="w-3 h-3 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />}
                  重新生成密钥
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {!initLoading && (
        <div className="sticky bottom-0 bg-white border-t border-gray-200 px-6 py-4 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            disabled={loading}
            className="px-4 py-2 text-sm font-medium rounded-lg border border-gray-200 hover:bg-gray-50 disabled:opacity-50 transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={loading}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:bg-blue-400 flex items-center gap-1.5 transition-colors"
          >
            {loading && <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />}
            {isEdit ? "保存" : "创建"}
          </button>
        </div>
      )}

      {rotatedSecret && (
        <CredentialModal
          title="新的客户端密钥"
          clientSecret={rotatedSecret}
          onClose={() => setRotatedSecret(null)}
        />
      )}
    </Modal>
  );
}

// --- OAuth Clients Section ---
export function OAuthClientsSection() {
  const [clients, setClients] = useState<ClientConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // editor: undefined = closed, null = create, ClientConfig = edit
  const [editor, setEditor] = useState<ClientConfig | null | undefined>(undefined);
  const [deleteTarget, setDeleteTarget] = useState<ClientConfig | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [createdSecret, setCreatedSecret] = useState<{ clientId: string; clientSecret: string } | null>(null);

  const fetchClients = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminFetch("/admin/oauth-clients");
      if (res.ok) {
        const data = (await res.json()) as { data: ClientConfig[] };
        setClients(data.data ?? []);
      } else {
        setError(await readErrorMessage(res, "加载 OAuth 客户端失败"));
      }
    } catch {
      setError("网络错误，请稍后重试");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchClients();
  }, [fetchClients]);

  const handleSaved = () => {
    setEditor(undefined);
    void fetchClients();
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await adminFetch(`/admin/oauth-clients/${deleteTarget.id}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setDeleteTarget(null);
        await fetchClients();
      } else {
        setError(await readErrorMessage(res, "删除失败，请稍后重试"));
      }
    } catch {
      setError("网络错误，请稍后重试");
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-gray-400 text-sm py-8">
        <div className="w-5 h-5 border-2 border-gray-300 border-t-transparent rounded-full animate-spin" />
        加载中...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">共 {clients.length} 个客户端</p>
        <button
          onClick={() => setEditor(null)}
          className="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors"
        >
          + 新建客户端
        </button>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
          <button onClick={() => setError("")} className="ml-2 underline">关闭</button>
        </div>
      )}

      {clients.length === 0 && (
        <p className="text-sm text-gray-400 py-4">暂无 OAuth 客户端</p>
      )}

      {clients.map((client) => (
        <div key={client.id} className="border border-gray-200 rounded-xl p-5 flex items-start justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h4 className="text-sm font-semibold text-gray-900 truncate">
                {client.client_name || client.client_id}
              </h4>
              {client.disabled && (
                <span className="inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">
                  已停用
                </span>
              )}
            </div>
            <p className="text-xs text-gray-400 mt-0.5 font-mono break-all">{client.client_id}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0 ml-4">
            <button
              onClick={() => setEditor(client)}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors"
            >
              编辑
            </button>
            <button
              onClick={() => setDeleteTarget(client)}
              className="px-3 py-1.5 text-xs font-medium rounded-lg text-red-600 hover:bg-red-50 transition-colors"
            >
              删除
            </button>
          </div>
        </div>
      ))}

      {editor !== undefined && (
        <OAuthClientEditor
          client={editor}
          onClose={() => setEditor(undefined)}
          onSaved={handleSaved}
          onCreated={(s) => setCreatedSecret(s)}
        />
      )}

      {deleteTarget && (
        <DeleteConfirmModal
          clientName={deleteTarget.client_name || deleteTarget.client_id}
          loading={deleting}
          onConfirm={confirmDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {createdSecret && (
        <CredentialModal
          title="客户端创建成功"
          clientId={createdSecret.clientId}
          clientSecret={createdSecret.clientSecret}
          onClose={() => setCreatedSecret(null)}
        />
      )}
    </div>
  );
}
