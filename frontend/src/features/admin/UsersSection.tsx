import { useState, useEffect, useCallback } from "react";
import MenuSelect from "../../components/MenuSelect";
import { EntitlementMatrix } from "../../components/EntitlementFields";
import { buildItems, formFromItems, type EntitlementForm, type EntitlementItem } from "../../components/entitlement-form";
import { USER_ROLE_OPTIONS } from "../../../../shared/user-roles";
import { adminFetch } from "../../lib/api/admin";
import { FieldLabel, Modal } from "./ui";


interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  banned: boolean;
  createdAt: string;
}

// 一个权益预设:GET /admin/entitlement-presets 的元素。
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

// 角色的展示元数据:色点与权限说明。值与 shared/user-roles.ts 的 USER_ROLE_OPTIONS 对齐。
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
export function UsersSection() {
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
      const res = await adminFetch(`/admin/users?page=${page}&limit=20`);
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
      const res = await adminFetch(`/admin/users/${id}`, {
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

      <div className="space-y-3 sm:hidden">
        {users.map((user) => (
          <div key={user.id} className="rounded-xl border border-gray-200 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium text-gray-900">{user.name}</div>
                <div className="truncate text-xs text-gray-400">{user.email}</div>
              </div>
              <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${user.banned ? "bg-red-100 text-red-700" : "bg-green-100 text-green-700"}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${user.banned ? "bg-red-500" : "bg-green-500"}`} />
                {user.banned ? "已封禁" : "正常"}
              </span>
            </div>
            <div className="mt-4 flex items-center justify-between gap-3">
              <RoleSelect value={user.role} disabled={actionLoading === user.id} onChange={(role) => updateUser(user.id, { role })} ariaLabel={`${user.name} 的角色`} />
              <span className="text-xs text-gray-500">{new Date(user.createdAt).toLocaleDateString("zh-CN")}</span>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button onClick={() => setEntitlementUser(user)} className="min-h-11 rounded-lg border border-gray-200 px-3 text-sm font-medium hover:bg-gray-50">权益</button>
              <button onClick={() => updateUser(user.id, { action: user.banned ? "unban" : "ban" })} disabled={actionLoading === user.id} className={`min-h-11 rounded-lg px-3 text-sm font-medium disabled:opacity-50 ${user.banned ? "bg-green-100 text-green-700 hover:bg-green-200" : "bg-red-100 text-red-700 hover:bg-red-200"}`}>
                {actionLoading === user.id ? <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" /> : user.banned ? "解封" : "封禁"}
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="hidden overflow-x-auto sm:block">
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
          onClose={() => setEntitlementUser(null)}
        />
      )}
    </div>
  );
}

function EntitlementPanel({
  user,
  onClose,
}: {
  user: User;
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
        adminFetch(`/admin/users/${user.id}/entitlements`),
        adminFetch("/admin/entitlement-presets"),
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
      const res = await adminFetch(`/admin/users/${user.id}/entitlements`, {
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
      const res = await adminFetch(
        `/admin/users/${user.id}/entitlements/preset`,
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
              <EntitlementMatrix form={form} onChange={setForm} />
            </div>
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
