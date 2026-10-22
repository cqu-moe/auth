import { useState, useEffect, useCallback } from "react";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import {
  ActionButton,
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Checkbox,
  Input,
  PageState,
  Textarea,
} from "@cqu-moe/ui";
import { adminFetch } from "../../lib/api/admin";
import MenuSelect from "../../components/MenuSelect";
import { OAuthClientEditorSkeleton, OAuthClientsSkeleton } from "./AdminSkeletons";
import { CopyButton, FieldLabel, Modal, StringListInput, Toggle } from "./ui";

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
  { key: "cqu:ticket:friends", label: "第二课堂 (friends)" },
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
    <Modal
      onClose={onClose}
      title={title}
      description="密钥仅显示一次，请立即妥善保存。"
      maxWidth="max-w-lg"
      footer={
        <Button onClick={onClose}>我已保存</Button>
      }
    >
      <div className="space-y-4">
        <Alert variant="destructive">
          <AlertTitle>仅显示一次</AlertTitle>
          <AlertDescription>密钥仅显示一次，请立即妥善保存。关闭后将无法再次查看。</AlertDescription>
        </Alert>

        {clientId && (
          <div>
            <FieldLabel>Client ID</FieldLabel>
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all rounded-lg border border-border bg-muted px-3 py-2 font-mono text-xs text-foreground">
                {clientId}
              </code>
              <CopyButton value={clientId} />
            </div>
          </div>
        )}

        <div>
          <FieldLabel>Client Secret</FieldLabel>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all rounded-lg border border-border bg-muted px-3 py-2 font-mono text-xs text-foreground">
              {clientSecret}
            </code>
            <CopyButton value={clientSecret} />
          </div>
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
    <Modal
      onClose={onCancel}
      title="删除 OAuth 客户端"
      description="此操作不可撤销，相关的 CQU 服务权限也会一并清除。"
      maxWidth="max-w-md"
      footer={
        <>
          <Button variant="outline" onClick={onCancel} disabled={loading}>
            取消
          </Button>
          <ActionButton
            type="button"
            variant="destructive"
            onClick={onConfirm}
            state={loading ? "loading" : "idle"}
            labels={{
              idle: "删除",
              loading: "删除中…",
              success: "已删除",
              error: "重试删除",
            }}
          />
        </>
      }
    >
      <p className="text-sm text-muted-foreground">
        确定要删除客户端 <span className="font-medium text-foreground">{clientName}</span> 吗？此操作不可撤销，相关的 CQU 服务权限也会一并清除。
      </p>
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
  const [initError, setInitError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
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
      setInitError(false);
      try {
        const res = await adminFetch(`/admin/oauth-clients/${client.id}/scopes`);
        if (!res.ok) throw new Error("无法读取客户端权限");
        const data = (await res.json()) as { scopes: string[] };
        if (!cancelled) setState(stateFromClient(client, data.scopes ?? []));
      } catch {
        if (!cancelled) setInitError(true);
      } finally {
        if (!cancelled) setInitLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [client, loadAttempt]);

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
      require_pkce: true,
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
    <Modal
      onClose={onClose}
      title={isEdit ? "编辑 OAuth 客户端" : "新建 OAuth 客户端"}
      description={isEdit && client ? `Client ID：${client.client_id}` : "配置回调、授权类型与 CQU 服务权限。"}
      footer={
        <>
            <Button variant="outline" onClick={onClose} disabled={loading}>
              取消
            </Button>
            <ActionButton
              type="button"
              onClick={handleSave}
              disabled={initLoading || initError}
              state={loading ? "loading" : "idle"}
              labels={
                isEdit
                  ? {
                      idle: "保存",
                      loading: "正在保存…",
                      success: "已保存",
                      error: "重试保存",
                    }
                  : {
                      idle: "创建",
                      loading: "正在创建…",
                      success: "已创建",
                      error: "重试创建",
                    }
              }
            />
          </>
      }
    >
      <div className="space-y-5">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {initLoading ? (
          <OAuthClientEditorSkeleton isEdit={isEdit} />
        ) : initError ? (
          <PageState state="error" title="无法读取客户端权限" description="请重试后再编辑，以免覆盖尚未读取的权限。" action={<Button type="button" onClick={() => setLoadAttempt(attempt => attempt + 1)}>重试</Button>} />
        ) : (
          <>
            {isEdit && client && (
              <div>
                <FieldLabel>Client ID</FieldLabel>
                <code className="block break-all rounded-lg border border-border bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">
                  {client.client_id}
                </code>
              </div>
            )}

            <div>
              <FieldLabel htmlFor="oauth-client-name">名称</FieldLabel>
              <Input
                id="oauth-client-name"
                type="text"
                value={state.client_name}
                onChange={(e) => patch("client_name", e.target.value)}
                placeholder="我的应用"
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
              <FieldLabel htmlFor="oauth-client-scope" hint="空格分隔">允许的 scope</FieldLabel>
              <Input
                id="oauth-client-scope"
                type="text"
                value={state.scope}
                onChange={(e) => patch("scope", e.target.value)}
                placeholder="openid profile email"
                className="font-mono"
              />
            </div>

            <fieldset>
              <legend className="mb-1.5 text-xs font-medium text-foreground">授权类型 (grant_types)</legend>
              <div className="space-y-1.5">
                {GRANT_TYPE_OPTIONS.map((opt) => (
                  <label
                    key={opt.value}
                    className="flex cursor-pointer items-center gap-3 rounded-lg p-2 hover:bg-muted"
                  >
                    <Checkbox
                      checked={state.grant_types.includes(opt.value)}
                      onCheckedChange={() => toggleGrant(opt.value)}
                    />
                    <span className="text-sm text-foreground">{opt.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="space-y-1.5">
              <FieldLabel>客户端类型 (type)</FieldLabel>
              <MenuSelect
                value={state.type}
                onChange={(v) => patch("type", v)}
                options={CLIENT_TYPE_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label }))}
                aria-label="客户端类型"
              />
            </div>

            <Toggle
              checked={state.skip_consent}
              onChange={(v) => patch("skip_consent", v)}
              label="跳过同意页"
              hint="授权时不向用户展示同意页面"
            />

            <div className="border-t border-border pt-4">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setShowAdvanced((v) => !v)}
                aria-expanded={showAdvanced}
              >
                {showAdvanced ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                {showAdvanced ? "收起完整配置" : "展开完整配置"}
              </Button>
            </div>

            {showAdvanced && (
              <div className="space-y-5">
                <div>
                  <FieldLabel htmlFor="oauth-client-uri">应用主页 (client_uri)</FieldLabel>
                  <Input id="oauth-client-uri" type="text" value={state.client_uri} onChange={(e) => patch("client_uri", e.target.value)} placeholder="https://example.com" />
                </div>
                <div>
                  <FieldLabel htmlFor="oauth-logo-uri">Logo URL (logo_uri)</FieldLabel>
                  <Input id="oauth-logo-uri" type="text" value={state.logo_uri} onChange={(e) => patch("logo_uri", e.target.value)} placeholder="https://example.com/logo.png" />
                </div>
                <div>
                  <FieldLabel htmlFor="oauth-tos-uri">服务条款 (tos_uri)</FieldLabel>
                  <Input id="oauth-tos-uri" type="text" value={state.tos_uri} onChange={(e) => patch("tos_uri", e.target.value)} placeholder="https://example.com/tos" />
                </div>
                <div>
                  <FieldLabel htmlFor="oauth-policy-uri">隐私政策 (policy_uri)</FieldLabel>
                  <Input id="oauth-policy-uri" type="text" value={state.policy_uri} onChange={(e) => patch("policy_uri", e.target.value)} placeholder="https://example.com/privacy" />
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
                <p className="text-sm text-muted-foreground">授权码流程强制使用 S256 PKCE。</p>
                <div className="space-y-1.5">
                  <FieldLabel>令牌端点认证方式 (token_endpoint_auth_method)</FieldLabel>
                  <MenuSelect
                    value={state.token_endpoint_auth_method}
                    onChange={(v) => patch("token_endpoint_auth_method", v)}
                    options={AUTH_METHOD_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label }))}
                    aria-label="令牌端点认证方式"
                  />
                </div>
                <div>
                  <FieldLabel htmlFor="oauth-response-types" hint="固定为 code">响应类型 (response_types)</FieldLabel>
                  <Input
                    id="oauth-response-types"
                    type="text"
                    value={state.response_types.join(" ")}
                    readOnly
                    className="bg-muted font-mono text-muted-foreground"
                  />
                </div>
                <Toggle
                  checked={state.enable_end_session}
                  onChange={(v) => patch("enable_end_session", v)}
                  label="启用结束会话端点"
                  hint="允许通过 end_session 端点登出"
                />
                <div>
                  <FieldLabel htmlFor="oauth-metadata" hint="提交前解析 JSON">metadata</FieldLabel>
                  <Textarea
                    id="oauth-metadata"
                    value={state.metadata}
                    onChange={(e) => patch("metadata", e.target.value)}
                    placeholder='{"key": "value"}'
                    rows={4}
                    className="resize-y font-mono"
                  />
                </div>
              </div>
            )}

            <fieldset className="border-t border-border pt-4">
              <legend className="mb-2 text-xs font-medium text-foreground">CQU 服务权限</legend>
              <div className="space-y-1">
                {ALL_CQU_SCOPES.map((scope) => (
                  <label
                    key={scope.key}
                    className="flex cursor-pointer items-center gap-3 rounded-lg p-2 hover:bg-muted"
                  >
                    <Checkbox
                      checked={state.cqu_scopes.includes(scope.key)}
                      onCheckedChange={() => toggleCquScope(scope.key)}
                    />
                    <span className="text-sm text-foreground">{scope.label}</span>
                    <span className="ml-auto font-mono text-xs text-muted-foreground">{scope.key}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            {isEdit && state.token_endpoint_auth_method !== "none" && (
              <div className="border-t border-border pt-4">
                <p className="mb-2 text-xs font-medium text-foreground">客户端密钥</p>
                <p className="mb-3 text-xs text-muted-foreground">出于安全考虑，现有密钥不会显示。重新生成后旧密钥立即失效。</p>
                <ActionButton
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleRotate}
                  state={rotating ? "loading" : "idle"}
                  labels={{
                    idle: "重新生成密钥",
                    loading: "正在重新生成…",
                    success: "已重新生成",
                    error: "重试重新生成",
                  }}
                />
              </div>
            )}
          </>
        )}
      </div>

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
  const [hasLoaded, setHasLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  // editor: undefined = closed, null = create, ClientConfig = edit
  const [editor, setEditor] = useState<ClientConfig | null | undefined>(undefined);
  const [deleteTarget, setDeleteTarget] = useState<ClientConfig | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [createdSecret, setCreatedSecret] = useState<{ clientId: string; clientSecret: string } | null>(null);

  const fetchClients = useCallback(async () => {
    setRefreshing(true);
    setError("");
    try {
      const res = await adminFetch("/admin/oauth-clients");
      if (res.ok) {
        const data = (await res.json()) as { data: ClientConfig[] };
        setClients(data.data ?? []);
        setHasLoaded(true);
      } else {
        setError(await readErrorMessage(res, "加载 OAuth 客户端失败"));
      }
    } catch {
      setError("网络错误，请稍后重试");
    } finally {
      setLoading(false);
      setRefreshing(false);
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
      <OAuthClientsSkeleton />
    );
  }

  if (error && !hasLoaded) {
    return (
      <PageState
        state="error"
        title="加载 OAuth 客户端失败"
        description={error}
        action={
          <Button
            disabled={refreshing}
            onClick={() => {
              setLoading(true);
              void fetchClients();
            }}
          >
            重试
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-4" aria-busy={refreshing}>
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">共 {clients.length} 个客户端</p>
        <Button size="sm" onClick={() => setEditor(null)} disabled={refreshing}>
          <Plus aria-hidden="true" size={16} />
          新建客户端
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {clients.length === 0 && (
        <PageState state="empty" title="暂无 OAuth 客户端" description="新建客户端后，第三方应用可通过 OAuth 接入。" />
      )}

      {clients.map((client) => (
        <div key={client.id} className="flex flex-col gap-4 border-b border-border py-5 first:pt-0 last:border-b-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h4 className="truncate text-sm font-semibold text-foreground">
                {client.client_name || client.client_id}
              </h4>
              {client.disabled && (
                <span className="badge badge-muted">已停用</span>
              )}
            </div>
            <p className="mt-0.5 break-all font-mono text-xs text-muted-foreground">{client.client_id}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2 sm:ml-4">
            <Button
              variant="outline"
              size="sm"
              disabled={refreshing}
              onClick={() => setEditor(client)}
            >
              编辑
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive"
              disabled={refreshing}
              onClick={() => setDeleteTarget(client)}
            >
              删除
            </Button>
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
