import { useState, useEffect } from "react";
import type { ClientConfig, ClientPayload, EditorState } from "../types";
import {
  ALL_CQU_SCOPES,
  GRANT_TYPE_OPTIONS,
  CLIENT_TYPE_OPTIONS,
  AUTH_METHOD_OPTIONS,
  readErrorMessage,
} from "../constants";
import { emptyEditorState, stateFromClient, cleanList } from "./payload";
import { CredentialModal } from "./CredentialModal";
import { Modal, Toggle, FieldLabel, StringListInput, inputClass } from "../../../components/ui";

// --- OAuth client editor (create + edit) ---
export function OAuthClientEditor({
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
        const res = await fetch(`/api/admin/oauth-clients/${client.id}/scopes`);
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
      const res = await fetch(`/api/admin/oauth-clients/${clientId}/scopes`, {
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
        const res = await fetch(`/api/admin/oauth-clients/${targetId}`, {
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
        const res = await fetch(`/api/admin/oauth-clients`, {
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
      const res = await fetch(`/api/admin/oauth-clients/${client.id}/rotate-secret`, {
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
