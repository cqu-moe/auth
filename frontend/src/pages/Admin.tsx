import { useState, useEffect, useCallback, type ReactNode } from "react";
import Layout from "../components/Layout";
import MenuSelect from "../components/MenuSelect";
import { EntitlementMatrix } from "../components/EntitlementFields";
import {
  buildItems,
  formFromItems,
  summarizeItems,
  type EntitlementForm,
  type EntitlementItem,
} from "../components/entitlement-form";
import { USER_ROLE_OPTIONS } from "../../../src/user-roles";
import { authClient } from "../lib/auth-client";
import QuotaEditor from "../components/quicklogin/QuotaEditor";

// --- Types ---
interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  banned: boolean;
  createdAt: string;
}

// 一个权益预设:GET /api/admin/entitlement-presets 的元素。
interface EntitlementPreset {
  name: string;
  items: EntitlementItem[];
  updatedAt?: string;
}

interface UsersResponse {
  data: User[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

type InvitationStatus = "active" | "in_use" | "expired" | "used" | "revoked";

interface RegistrationInvitation {
  code: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  claimedAt: string | null;
  claimedByEmail: string | null;
  usedAt: string | null;
  usedByUserId: string | null;
  revokedAt: string | null;
  preset: string | null;
  status: InvitationStatus;
}

interface CreatedRegistrationInvitation extends RegistrationInvitation {
  registrationUrl: string;
}

// Full OAuth client config as returned by GET /api/admin/oauth-clients (snake_case).
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

// Body sent to POST/PATCH /api/admin/oauth-clients (snake_case, flat).
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

// 角色的展示元数据:色点与权限说明。值与 src/user-roles.ts 的 USER_ROLE_OPTIONS 对齐。
const ROLE_META: Record<string, { dotClass: string; hint: string }> = {
  user: { dotClass: "bg-gray-400", hint: "普通使用,无管理入口" },
  admin: { dotClass: "bg-blue-500", hint: "可管理用户与邀请" },
  superAdmin: { dotClass: "bg-violet-500", hint: "含权益与客户端写权限" },
};

// 角色选择:徽章式自定义下拉(原生 select 在表格里样式不可控)。
function RoleSelect({
  value,
  disabled,
  onChange,
  ariaLabel,
}: {
  value: string;
  disabled: boolean;
  onChange: (role: string) => void;
  ariaLabel: string;
}) {
  const options = USER_ROLE_OPTIONS.map((opt) => ({
    value: opt.value as string,
    label: opt.label,
    dotClass: ROLE_META[opt.value]?.dotClass ?? "bg-gray-400",
    hint: ROLE_META[opt.value]?.hint,
  }));
  return (
    <MenuSelect
      value={value}
      options={options}
      onChange={onChange}
      disabled={disabled}
      aria-label={ariaLabel}
      buttonClassName="px-2.5 py-1 text-xs"
    />
  );
}

// --- Users Section ---
function UsersSection({ canEditQuota }: { canEditQuota: boolean }) {
  const [users, setUsers] = useState<User[]>([]);
  const [pagination, setPagination] = useState({ page: 1, total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState("");
  // 当前打开「分级权益」面板的用户(null = 关闭)。
  const [entitlementUser, setEntitlementUser] = useState<User | null>(null);

  const fetchUsers = useCallback(async (page = 1) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/users?page=${page}&limit=20`);
      if (res.ok) {
        const data = await res.json() as UsersResponse;
        setUsers(data.data);
        setPagination({ page, total: data.pagination.total, totalPages: data.pagination.totalPages });
      } else {
        setError("加载用户列表失败");
      }
    } catch {
      setError("网络错误，请稍后重试");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchUsers(1);
  }, [fetchUsers]);

  const updateUser = async (id: string, payload: Record<string, unknown>) => {
    setActionLoading(id);
    try {
      const res = await fetch(`/api/admin/users/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        await fetchUsers(pagination.page);
      } else {
        setError("操作失败，请稍后重试");
      }
    } catch {
      setError("网络错误，请稍后重试");
    } finally {
      setActionLoading(null);
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
    <div>
      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
          <button onClick={() => setError("")} className="ml-2 underline">关闭</button>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200">
              <th className="text-left py-3 px-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">用户</th>
              <th className="text-left py-3 px-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">角色</th>
              <th className="text-left py-3 px-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">状态</th>
              <th className="text-left py-3 px-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">注册时间</th>
              <th className="text-right py-3 px-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {users.map((user) => (
              <tr key={user.id} className="hover:bg-gray-50 transition-colors">
                <td className="py-3 px-4">
                  <div className="font-medium text-gray-900">{user.name}</div>
                  <div className="text-xs text-gray-400">{user.email}</div>
                </td>
                <td className="py-3 px-4">
                  <RoleSelect
                    value={user.role}
                    disabled={actionLoading === user.id}
                    onChange={(role) => updateUser(user.id, { role })}
                    ariaLabel={`${user.name} 的角色`}
                  />
                </td>
                <td className="py-3 px-4">
                  <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${
                    user.banned
                      ? "bg-red-100 text-red-700"
                      : "bg-green-100 text-green-700"
                  }`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${user.banned ? "bg-red-500" : "bg-green-500"}`} />
                    {user.banned ? "已封禁" : "正常"}
                  </span>
                </td>
                <td className="py-3 px-4 text-gray-500 text-xs">
                  {new Date(user.createdAt).toLocaleDateString("zh-CN")}
                </td>
                <td className="py-3 px-4 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <button
                      onClick={() => setEntitlementUser(user)}
                      className="text-xs font-medium px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors"
                    >
                      权益
                    </button>
                    <button
                      onClick={() => updateUser(user.id, { action: user.banned ? "unban" : "ban" })}
                      disabled={actionLoading === user.id}
                      className={`text-xs font-medium px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50 ${
                        user.banned
                          ? "bg-green-100 text-green-700 hover:bg-green-200"
                          : "bg-red-100 text-red-700 hover:bg-red-200"
                      }`}
                    >
                      {actionLoading === user.id ? (
                        <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                      ) : (
                        user.banned ? "解封" : "封禁"
                      )}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between mt-4 pt-4 border-t border-gray-200">
          <span className="text-xs text-gray-500">
            共 {pagination.total} 个用户
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => fetchUsers(pagination.page - 1)}
              disabled={pagination.page <= 1}
              className="px-3 py-1.5 text-xs border border-gray-200 rounded-lg disabled:opacity-40 hover:bg-gray-50"
            >
              上一页
            </button>
            <span className="text-xs text-gray-500">
              {pagination.page} / {pagination.totalPages}
            </span>
            <button
              onClick={() => fetchUsers(pagination.page + 1)}
              disabled={pagination.page >= pagination.totalPages}
              className="px-3 py-1.5 text-xs border border-gray-200 rounded-lg disabled:opacity-40 hover:bg-gray-50"
            >
              下一页
            </button>
          </div>
        </div>
      )}

      {entitlementUser && (
        <EntitlementPanel
          user={entitlementUser}
          canEditQuota={canEditQuota}
          onClose={() => setEntitlementUser(null)}
        />
      )}
    </div>
  );
}

// --- Reusable form primitives ---

// A field label row with optional hint text.
function FieldLabel({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div className="mb-1.5">
      <label className="text-xs font-medium text-gray-700">{children}</label>
      {hint && <span className="ml-2 text-xs text-gray-400">{hint}</span>}
    </div>
  );
}

const inputClass =
  "w-full text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder:text-gray-300";

// Editable list of single-line strings (add / remove rows). Always renders at
// least one row so the user has something to type into.
function StringListInput({
  values,
  onChange,
  placeholder,
  addLabel,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  addLabel: string;
}) {
  const rows = values.length === 0 ? [""] : values;

  const setAt = (i: number, v: string) => {
    const next = [...rows];
    next[i] = v;
    onChange(next);
  };
  const removeAt = (i: number) => {
    const next = rows.filter((_, idx) => idx !== i);
    onChange(next);
  };
  const add = () => onChange([...rows, ""]);

  return (
    <div className="space-y-2">
      {rows.map((val, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            type="text"
            value={val}
            onChange={(e) => setAt(i, e.target.value)}
            placeholder={placeholder}
            className={inputClass}
          />
          <button
            type="button"
            onClick={() => removeAt(i)}
            disabled={rows.length === 1}
            className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg border border-gray-200 text-gray-400 hover:text-red-600 hover:border-red-200 disabled:opacity-30 disabled:hover:text-gray-400 disabled:hover:border-gray-200 transition-colors"
            aria-label="删除此项"
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        className="text-xs font-medium text-blue-600 hover:text-blue-700"
      >
        + {addLabel}
      </button>
    </div>
  );
}

// Small accessible on/off toggle.
function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex items-center justify-between gap-3 cursor-pointer py-1">
      <span>
        <span className="text-sm text-gray-700">{label}</span>
        {hint && <span className="block text-xs text-gray-400">{hint}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative shrink-0 w-10 h-6 rounded-full transition-colors ${
          checked ? "bg-blue-600" : "bg-gray-200"
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
            checked ? "translate-x-4" : "translate-x-0"
          }`}
        />
      </button>
    </label>
  );
}

// Copy-to-clipboard button that flashes "已复制".
function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable (insecure context); silently ignore.
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      className="shrink-0 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors"
    >
      {copied ? "已复制" : "复制"}
    </button>
  );
}

// Centered modal shell with backdrop.
function Modal({
  onClose,
  children,
  maxWidth = "max-w-2xl",
}: {
  onClose: () => void;
  children: ReactNode;
  maxWidth?: string;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        className={`relative w-full ${maxWidth} max-h-[90vh] overflow-y-auto bg-white rounded-2xl border border-gray-200 shadow-xl`}
        role="dialog"
        aria-modal="true"
      >
        {children}
      </div>
    </div>
  );
}

// --- Entitlement panel (per-user 分级权益 / 能力授权) ---
// 表单态/矩阵实现见 components/EntitlementFields。保存为整组替换(full replace):
// 仅把勾选的 flag 与非空 quota 发给 PUT,未勾/空缺省即「false / 无限」。
// 预设从 GET /api/admin/entitlement-presets 读(管理台「权益预设」页可编辑)。
function EntitlementPanel({
  user,
  canEditQuota,
  onClose,
}: {
  user: User;
  canEditQuota: boolean;
  onClose: () => void;
}) {
  const [form, setForm] = useState<EntitlementForm>({});
  const [initLoading, setInitLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [applyingPreset, setApplyingPreset] = useState(false);
  const [presets, setPresets] = useState<EntitlementPreset[]>([]);
  const [preset, setPreset] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const load = useCallback(async () => {
    setInitLoading(true);
    setError("");
    try {
      const [res, presetsRes] = await Promise.all([
        fetch(`/api/admin/users/${user.id}/entitlements`),
        fetch("/api/admin/entitlement-presets"),
      ]);
      if (res.ok) {
        const data = (await res.json()) as { data: EntitlementItem[] };
        setForm(formFromItems(data.data ?? []));
      } else {
        setError(await readErrorMessage(res, "加载权益失败"));
      }
      if (presetsRes.ok) {
        const data = (await presetsRes.json()) as { data: EntitlementPreset[] };
        const list = data.data ?? [];
        setPresets(list);
        // 首次载入或当前选中项已不存在时,回落到第一个预设。
        setPreset((prev) =>
          prev && list.some((p) => p.name === prev) ? prev : (list[0]?.name ?? "")
        );
      }
    } catch {
      setError("网络错误，请稍后重试");
    } finally {
      setInitLoading(false);
    }
  }, [user.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSave = async () => {
    setError("");
    setSuccess("");
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/users/${user.id}/entitlements`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: buildItems(form) }),
      });
      if (res.ok) {
        setSuccess("已保存");
        await load();
      } else if (res.status === 403) {
        setError("需要 superAdmin 权限");
      } else {
        setError(await readErrorMessage(res, "保存失败，请稍后重试"));
      }
    } catch {
      setError("网络错误，请稍后重试");
    } finally {
      setSaving(false);
    }
  };

  const handleApplyPreset = async () => {
    if (!preset) return;
    setError("");
    setSuccess("");
    setApplyingPreset(true);
    try {
      const res = await fetch(
        `/api/admin/users/${user.id}/entitlements/preset`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ preset }),
        }
      );
      if (res.ok) {
        setSuccess(`已套用预设「${preset}」`);
        await load();
      } else if (res.status === 403) {
        setError("需要 superAdmin 权限");
      } else {
        setError(await readErrorMessage(res, "套用预设失败"));
      }
    } catch {
      setError("网络错误，请稍后重试");
    } finally {
      setApplyingPreset(false);
    }
  };

  return (
    <Modal onClose={onClose} maxWidth="max-w-xl">
      <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-gray-900">分级权益 / 能力授权</h3>
          <p className="text-xs text-gray-400 truncate">{user.name} · {user.email}</p>
        </div>
        <button
          onClick={onClose}
          className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors shrink-0"
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
        {success && (
          <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">
            {success}
            <button onClick={() => setSuccess("")} className="ml-2 underline">关闭</button>
          </div>
        )}

        {initLoading ? (
          <div className="flex items-center gap-2 text-gray-400 text-sm py-8">
            <div className="w-5 h-5 border-2 border-gray-300 border-t-transparent rounded-full animate-spin" />
            加载中...
          </div>
        ) : (
          <>
            {/* --- 预设套用 --- */}
            {presets.length > 0 && (
              <div className="flex items-end gap-2 border border-gray-100 bg-gray-50 rounded-xl p-3">
                <div className="flex-1">
                  <FieldLabel hint="一键写入预设权益,之后仍可逐项调整">套用预设</FieldLabel>
                  <MenuSelect
                    value={preset}
                    onChange={setPreset}
                    options={presets.map((p) => ({
                      value: p.name,
                      label: p.name,
                      hint: `${p.items.length} 项能力`,
                    }))}
                    aria-label="选择要套用的预设"
                    buttonClassName="w-full justify-between px-3 py-2"
                  />
                </div>
                <button
                  type="button"
                  onClick={handleApplyPreset}
                  disabled={applyingPreset || saving}
                  className="px-4 py-2 text-sm font-medium rounded-lg border border-gray-200 bg-white hover:bg-gray-50 disabled:opacity-50 flex items-center gap-1.5 transition-colors"
                >
                  {applyingPreset && <span className="w-3 h-3 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />}
                  套用
                </button>
              </div>
            )}

            {/* --- 按子系统分组的能力 --- */}
            <div className="border-t border-gray-100 pt-4">
              <EntitlementMatrix
                form={form}
                onChange={setForm}
                quickloginQuotaReadOnly
              />
            </div>
            {canEditQuota && (
              <QuotaEditor userId={user.id} onSaved={() => void load()} />
            )}
          </>
        )}
      </div>

      {!initLoading && (
        <div className="sticky bottom-0 bg-white border-t border-gray-200 px-6 py-4 flex items-center justify-between gap-2">
          <p className="text-xs text-gray-400">勾选/填值即授权;留空数量表示无限。保存为整组替换。</p>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={onClose}
              disabled={saving}
              className="px-4 py-2 text-sm font-medium rounded-lg border border-gray-200 hover:bg-gray-50 disabled:opacity-50 transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleSave}
              disabled={saving || applyingPreset}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:bg-blue-400 flex items-center gap-1.5 transition-colors"
            >
              {saving && <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />}
              保存
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// --- One-time credential reveal (used by create + rotate) ---
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

// --- OAuth Clients Section ---
function OAuthClientsSection() {
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
      const res = await fetch("/api/admin/oauth-clients");
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
      const res = await fetch(`/api/admin/oauth-clients/${deleteTarget.id}`, {
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

// --- Registration Invitations Section ---
function RegistrationInvitationsSection() {
  const [invitations, setInvitations] = useState<RegistrationInvitation[]>([]);
  const [created, setCreated] = useState<CreatedRegistrationInvitation | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [error, setError] = useState("");
  // 注册政策:是否强制邀请码;savingPolicy 期间禁用开关防连点。
  const [invitationRequired, setInvitationRequired] = useState(true);
  const [savingPolicy, setSavingPolicy] = useState(false);
  // 生成邀请时可选的权益预设("" = 跟随全局默认权益)。
  const [presets, setPresets] = useState<EntitlementPreset[]>([]);
  const [createPreset, setCreatePreset] = useState("");

  const fetchInvitations = useCallback(async () => {
    setLoading(true);
    try {
      const [res, settingsRes, presetsRes] = await Promise.all([
        fetch("/api/admin/registration-invitations"),
        fetch("/api/admin/registration-settings"),
        fetch("/api/admin/entitlement-presets"),
      ]);
      if (!res.ok) {
        setError(await readErrorMessage(res, "加载注册邀请失败"));
        return;
      }
      const body = (await res.json()) as { data: RegistrationInvitation[] };
      setInvitations(body.data ?? []);
      if (settingsRes.ok) {
        const settings = (await settingsRes.json()) as { invitationRequired?: boolean };
        if (typeof settings.invitationRequired === "boolean") {
          setInvitationRequired(settings.invitationRequired);
        }
      }
      if (presetsRes.ok) {
        const data = (await presetsRes.json()) as { data: EntitlementPreset[] };
        setPresets(data.data ?? []);
      }
    } catch {
      setError("网络错误，请稍后重试");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchInvitations();
  }, [fetchInvitations]);

  const togglePolicy = async (required: boolean) => {
    setSavingPolicy(true);
    setError("");
    try {
      const res = await fetch("/api/admin/registration-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invitationRequired: required }),
      });
      if (res.ok) {
        setInvitationRequired(required);
      } else if (res.status === 403) {
        setError("需要 superAdmin 权限");
      } else {
        setError(await readErrorMessage(res, "保存注册政策失败"));
      }
    } catch {
      setError("网络错误，请稍后重试");
    } finally {
      setSavingPolicy(false);
    }
  };

  const createInvitation = async () => {
    setCreating(true);
    setError("");
    try {
      const res = await fetch("/api/admin/registration-invitations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preset: createPreset || null }),
      });
      if (!res.ok) {
        setError(await readErrorMessage(res, "生成邀请码失败"));
        return;
      }
      const body = (await res.json()) as { data: CreatedRegistrationInvitation };
      setCreated(body.data);
      await fetchInvitations();
    } catch {
      setError("网络错误，请稍后重试");
    } finally {
      setCreating(false);
    }
  };

  const revokeInvitation = async (code: string) => {
    setRevoking(code);
    setError("");
    try {
      const res = await fetch(
        `/api/admin/registration-invitations/${encodeURIComponent(code)}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        setError(await readErrorMessage(res, "撤销邀请码失败"));
        return;
      }
      await fetchInvitations();
    } catch {
      setError("网络错误，请稍后重试");
    } finally {
      setRevoking(null);
    }
  };

  const statusMeta: Record<
    InvitationStatus,
    { label: string; className: string }
  > = {
    active: { label: "可使用", className: "bg-green-100 text-green-700" },
    in_use: { label: "注册中", className: "bg-blue-100 text-blue-700" },
    expired: { label: "已过期", className: "bg-gray-100 text-gray-600" },
    used: { label: "已使用", className: "bg-purple-100 text-purple-700" },
    revoked: { label: "已撤销", className: "bg-red-100 text-red-700" },
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
    <div className="space-y-5">
      {/* --- 注册政策开关 --- */}
      <div className="border border-gray-100 bg-gray-50 rounded-xl p-4">
        <Toggle
          checked={invitationRequired}
          onChange={(v) => void togglePolicy(v)}
          label="强制邀请码注册"
          hint={
            invitationRequired
              ? "未填写邀请码无法注册;邀请码可携带指定权益预设。"
              : "任何人都能注册,未填邀请码的新用户套用「权益预设」页的默认权益。"
          }
        />
        {savingPolicy && (
          <p className="mt-1 text-xs text-gray-400">保存中...</p>
        )}
      </div>

      {/* --- 生成邀请 --- */}
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0 flex-1 max-w-xs">
          <FieldLabel hint="使用该邀请码注册的用户获得对应权益">注册后权益</FieldLabel>
          <MenuSelect
            value={createPreset}
            onChange={setCreatePreset}
            options={[
              { value: "", label: "跟随默认权益" },
              ...presets.map((p) => ({
                value: p.name,
                label: p.name,
                hint: `${p.items.length} 项能力`,
              })),
            ]}
            aria-label="新邀请的权益预设"
            buttonClassName="w-full justify-between px-3 py-2"
          />
        </div>
        <button
          type="button"
          onClick={createInvitation}
          disabled={creating}
          className="shrink-0 px-3 py-2 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white transition-colors"
        >
          {creating ? "生成中..." : "+ 生成邀请"}
        </button>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
          <button onClick={() => setError("")} className="ml-2 underline">关闭</button>
        </div>
      )}

      {created && (
        <div className="p-4 bg-blue-50 border border-blue-200 rounded-xl">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-blue-900">注册链接已生成</p>
              <p className="mt-1 text-xl font-mono font-semibold tracking-widest text-blue-800">
                {created.code}
              </p>
            </div>
            <CopyButton value={created.code} />
          </div>
          <div className="mt-3 flex items-center gap-2">
            <input
              readOnly
              value={created.registrationUrl}
              className="min-w-0 flex-1 px-3 py-2 text-xs border border-blue-200 rounded-lg bg-white text-gray-600"
              aria-label="注册链接"
            />
            <CopyButton value={created.registrationUrl} />
          </div>
        </div>
      )}

      {invitations.length === 0 ? (
        <p className="text-sm text-gray-400 py-4">暂无注册邀请</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="text-left py-3 px-3 text-xs font-semibold text-gray-500">邀请码</th>
                <th className="text-left py-3 px-3 text-xs font-semibold text-gray-500">状态</th>
                <th className="text-left py-3 px-3 text-xs font-semibold text-gray-500">权益</th>
                <th className="text-left py-3 px-3 text-xs font-semibold text-gray-500">过期时间</th>
                <th className="text-left py-3 px-3 text-xs font-semibold text-gray-500">使用情况</th>
                <th className="text-right py-3 px-3 text-xs font-semibold text-gray-500">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {invitations.map((invitation) => {
                const meta = statusMeta[invitation.status];
                const registrationUrl = `${window.location.origin}/register?code=${encodeURIComponent(invitation.code)}`;
                return (
                  <tr key={invitation.code} className="hover:bg-gray-50">
                    <td className="py-3 px-3">
                      <span className="font-mono font-semibold tracking-wider text-gray-900">
                        {invitation.code}
                      </span>
                    </td>
                    <td className="py-3 px-3">
                      <span className={`inline-flex text-xs font-medium px-2 py-0.5 rounded-full ${meta.className}`}>
                        {meta.label}
                      </span>
                    </td>
                    <td className="py-3 px-3 text-xs text-gray-500">
                      {invitation.preset ?? <span className="text-gray-400">默认</span>}
                    </td>
                    <td className="py-3 px-3 text-xs text-gray-500 whitespace-nowrap">
                      {new Date(invitation.expiresAt).toLocaleString("zh-CN")}
                    </td>
                    <td className="py-3 px-3 text-xs text-gray-500">
                      {invitation.usedByUserId
                        ? `用户 ${invitation.usedByUserId}`
                        : invitation.claimedByEmail ?? "—"}
                    </td>
                    <td className="py-3 px-3">
                      <div className="flex items-center justify-end gap-2">
                        <CopyButton value={registrationUrl} />
                        {(invitation.status === "active" || invitation.status === "expired") && (
                          <button
                            type="button"
                            onClick={() => revokeInvitation(invitation.code)}
                            disabled={revoking === invitation.code}
                            className="px-2.5 py-1.5 text-xs font-medium rounded-lg text-red-600 hover:bg-red-50 disabled:opacity-50 transition-colors"
                          >
                            {revoking === invitation.code ? "撤销中..." : "撤销"}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// --- Presets section (权益预设 + 新用户默认权益) ---

// 预设编辑器:新建(name = null)或编辑既有预设。与 per-user 权益面板共用
// EntitlementMatrix;保存 = PUT 整体覆盖该预设的 items。
function PresetEditor({
  name,
  initialForm,
  onClose,
  onSaved,
}: {
  name: string | null;
  initialForm: EntitlementForm;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = name !== null;
  const [presetName, setPresetName] = useState(name ?? "");
  const [form, setForm] = useState<EntitlementForm>(initialForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const handleSave = async () => {
    const trimmed = presetName.trim();
    if (!trimmed) {
      setError("请填写预设名称");
      return;
    }
    setError("");
    setSaving(true);
    try {
      const res = await fetch(
        `/api/admin/entitlement-presets/${encodeURIComponent(trimmed)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: buildItems(form) }),
        }
      );
      if (res.ok) {
        onSaved();
      } else if (res.status === 403) {
        setError("需要 superAdmin 权限");
      } else {
        setError(await readErrorMessage(res, "保存失败，请稍后重试"));
      }
    } catch {
      setError("网络错误，请稍后重试");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal onClose={onClose} maxWidth="max-w-xl">
      <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <h3 className="text-base font-semibold text-gray-900">
          {isEdit ? `编辑预设「${name}」` : "新建预设"}
        </h3>
        <button
          onClick={onClose}
          className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors shrink-0"
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

        {!isEdit && (
          <div>
            <FieldLabel hint="例如:学生、助教、特邀教师">预设名称</FieldLabel>
            <input
              type="text"
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              maxLength={50}
              placeholder="预设名称"
              className={inputClass}
            />
          </div>
        )}

        <EntitlementMatrix form={form} onChange={setForm} />
      </div>

      <div className="sticky bottom-0 bg-white border-t border-gray-200 px-6 py-4 flex items-center justify-between gap-2">
        <p className="text-xs text-gray-400">勾选/填值即授权;留空数量表示无限。</p>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 text-sm font-medium rounded-lg border border-gray-200 hover:bg-gray-50 disabled:opacity-50 transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:bg-blue-400 flex items-center gap-1.5 transition-colors"
          >
            {saving && <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />}
            保存
          </button>
        </div>
      </div>
    </Modal>
  );
}

// 权益预设管理 + 新注册用户默认权益。
// 预设事实源在 D1(entitlement_preset 表);默认预设名存 entitlement_config,
// 注册钩子按它给新用户写初始权益行。删除默认预设时后端会顺带清掉默认配置。
function PresetsSection() {
  const [presets, setPresets] = useState<EntitlementPreset[]>([]);
  const [defaultPreset, setDefaultPreset] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // 默认权益下拉的保存状态:idle | saving | saved。
  const [defaultState, setDefaultState] = useState<"idle" | "saving" | "saved">("idle");
  // 打开编辑器的预设:null = 关闭;{ name: null } = 新建。
  const [editing, setEditing] = useState<{
    name: string | null;
    form: EntitlementForm;
  } | null>(null);
  // 删除两段确认:先点「删除」进入待确认,再点「确认删除」执行。
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [presetsRes, defaultRes] = await Promise.all([
        fetch("/api/admin/entitlement-presets"),
        fetch("/api/admin/entitlement-default"),
      ]);
      if (presetsRes.ok) {
        const data = (await presetsRes.json()) as { data: EntitlementPreset[] };
        setPresets(data.data ?? []);
      } else {
        setError(await readErrorMessage(presetsRes, "加载预设失败"));
      }
      if (defaultRes.ok) {
        const data = (await defaultRes.json()) as { preset: string | null };
        setDefaultPreset(data.preset ?? null);
      }
    } catch {
      setError("网络错误，请稍后重试");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 选择即保存:新默认预设(空串 = 无默认权益)。
  const changeDefault = async (value: string) => {
    const next = value === "" ? null : value;
    setError("");
    setNotice("");
    setDefaultState("saving");
    try {
      const res = await fetch("/api/admin/entitlement-default", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preset: next }),
      });
      if (res.ok) {
        setDefaultPreset(next);
        setDefaultState("saved");
        setTimeout(() => setDefaultState("idle"), 2000);
      } else if (res.status === 403) {
        setDefaultState("idle");
        setError("需要 superAdmin 权限");
      } else {
        setDefaultState("idle");
        setError(await readErrorMessage(res, "保存默认权益失败"));
      }
    } catch {
      setDefaultState("idle");
      setError("网络错误，请稍后重试");
    }
  };

  const handleDelete = async (name: string) => {
    setError("");
    setNotice("");
    setDeleting(name);
    try {
      const res = await fetch(
        `/api/admin/entitlement-presets/${encodeURIComponent(name)}`,
        { method: "DELETE" }
      );
      if (res.ok) {
        setNotice(`已删除预设「${name}」`);
        await load();
      } else if (res.status === 403) {
        setError("需要 superAdmin 权限");
      } else {
        setError(await readErrorMessage(res, "删除失败，请稍后重试"));
      }
    } catch {
      setError("网络错误，请稍后重试");
    } finally {
      setDeleting(null);
      setConfirmDelete(null);
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
    <div className="space-y-6">
      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
          <button onClick={() => setError("")} className="ml-2 underline">关闭</button>
        </div>
      )}
      {notice && (
        <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">
          {notice}
          <button onClick={() => setNotice("")} className="ml-2 underline">关闭</button>
        </div>
      )}

      {/* --- 新用户默认权益 --- */}
      <div className="flex items-center justify-between gap-4 border border-gray-100 bg-gray-50 rounded-xl p-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900">新用户默认权益</p>
          <p className="text-xs text-gray-400 mt-0.5">
            注册成功后自动套用的预设;选「无」则新用户不带任何权益。
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {defaultState === "saving" && (
            <span className="w-3.5 h-3.5 border-2 border-gray-300 border-t-transparent rounded-full animate-spin" />
          )}
          {defaultState === "saved" && (
            <span className="text-xs text-green-600">已保存</span>
          )}
          <MenuSelect
            value={defaultPreset ?? ""}
            onChange={(v) => void changeDefault(v)}
            disabled={defaultState === "saving"}
            options={[
              { value: "", label: "无默认权益" },
              ...presets.map((p) => ({
                value: p.name,
                label: p.name,
                hint: `${p.items.length} 项能力`,
              })),
            ]}
            aria-label="新用户默认权益"
            align="right"
            buttonClassName="px-3 py-1.5 text-sm"
          />
        </div>
      </div>

      {/* --- 预设列表 --- */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-medium text-gray-900">全部预设</p>
          <button
            type="button"
            onClick={() =>
              setEditing({ name: null, form: formFromItems([]) })
            }
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors"
          >
            + 新建预设
          </button>
        </div>

        {presets.length === 0 ? (
          <p className="text-sm text-gray-400 py-4">暂无预设</p>
        ) : (
          <div className="divide-y divide-gray-100 border border-gray-100 rounded-xl">
            {presets.map((p) => (
              <div key={p.name} className="flex items-center gap-4 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-900">{p.name}</span>
                    {defaultPreset === p.name && (
                      <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-green-100 text-green-700">
                        默认
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-400 mt-0.5 truncate">
                    {summarizeItems(p.items)}
                    {p.updatedAt && ` · 更新于 ${new Date(p.updatedAt + "Z").toLocaleDateString("zh-CN")}`}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() =>
                      setEditing({ name: p.name, form: formFromItems(p.items) })
                    }
                    className="text-xs font-medium px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors"
                  >
                    编辑
                  </button>
                  {confirmDelete === p.name ? (
                    <button
                      type="button"
                      onClick={() => void handleDelete(p.name)}
                      disabled={deleting === p.name}
                      className="text-xs font-medium px-3 py-1.5 rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:bg-red-400 transition-colors"
                    >
                      {deleting === p.name ? "删除中..." : "确认删除"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(p.name)}
                      className="text-xs font-medium px-3 py-1.5 rounded-lg text-red-600 hover:bg-red-50 transition-colors"
                    >
                      删除
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {editing && (
        <PresetEditor
          name={editing.name}
          initialForm={editing.form}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setNotice(editing.name ? `已保存预设「${editing.name}」` : "预设已创建");
            void load();
          }}
        />
      )}
    </div>
  );
}

// --- Main Admin Page ---
type Tab = "users" | "presets" | "invitations" | "oauth";

export default function Admin() {
  const [activeTab, setActiveTab] = useState<Tab>("users");
  const { data: session } = authClient.useSession();
  const canEditQuota = (session?.user as { role?: string } | undefined)?.role === "superAdmin";

  const tabs: { key: Tab; label: string }[] = [
    { key: "users", label: "用户管理" },
    { key: "presets", label: "权益预设" },
    { key: "invitations", label: "注册邀请" },
    { key: "oauth", label: "OAuth 客户端" },
  ];

  return (
    <Layout>
      <div>
        <h1 className="text-2xl font-bold text-gray-900 mb-6">管理控制台</h1>

        <div className="flex gap-1 p-1 bg-gray-100 rounded-xl w-fit mb-6">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                activeTab === tab.key
                  ? "bg-white text-gray-900 shadow-sm"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          {activeTab === "users" && <UsersSection canEditQuota={canEditQuota} />}
          {activeTab === "presets" && <PresetsSection />}
          {activeTab === "invitations" && <RegistrationInvitationsSection />}
          {activeTab === "oauth" && <OAuthClientsSection />}
        </div>
      </div>
    </Layout>
  );
}
