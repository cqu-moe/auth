// --- Entitlement panel (per-user 分级权益 / 能力授权) ---
// 表单态/矩阵实现见 components/EntitlementFields。保存为整组替换(full replace):
// 仅把勾选的 flag 与非空 quota 发给 PUT,未勾/空缺省即「false / 无限」。
// 预设从 GET /admin/entitlement-presets 读(管理台「权益预设」页可编辑)。
import { useState, useEffect, useCallback } from "react";
import { Loader2 } from "lucide-react";
import {
  Alert,
  AlertDescription,
  Button,
  PageState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@cqu-moe/ui";
import MenuSelect from "../../components/MenuSelect";
import { EntitlementMatrix } from "../../components/EntitlementFields";
import { buildItems, formFromItems, type EntitlementForm, type EntitlementItem } from "../../components/entitlement-form";
import { USER_ROLE_OPTIONS } from "../../../../shared/user-roles";
import { adminFetch } from "../../lib/api/admin";
import { authClient } from "../../lib/auth-client";
import QuotaEditor from "../../components/quicklogin/QuotaEditor";
import { FieldLabel, Modal } from "./ui";

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  banned: boolean;
  createdAt: string;
}

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

// 角色的展示元数据:权限说明。值与 shared/user-roles.ts 的 USER_ROLE_OPTIONS 对齐。
const ROLE_META: Record<string, { hint: string }> = {
  user: { hint: "普通使用,无管理入口" },
  admin: { hint: "可管理用户与邀请" },
  superAdmin: { hint: "含权益与客户端写权限" },
};

// 角色选择:共享 Select(原生 select 在表格里样式不可控)。
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
    hint: ROLE_META[opt.value]?.hint,
  }));
  return (
    <MenuSelect
      value={value}
      options={options}
      onChange={onChange}
      disabled={disabled}
      aria-label={ariaLabel}
      size="sm"
    />
  );
}

// --- Users Section ---
export function UsersSection() {
  const { data: session } = authClient.useSession();
  const canEditQuota =
    (session?.user as { role?: string } | undefined)?.role === "superAdmin";
  const [users, setUsers] = useState<User[]>([]);
  const [pagination, setPagination] = useState({ page: 1, total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState("");
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
      <PageState state="loading" title="正在加载用户" description="正在读取用户列表…" />
    );
  }

  return (
    <div>
      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-left">用户</TableHead>
              <TableHead className="text-left">角色</TableHead>
              <TableHead className="text-left">状态</TableHead>
              <TableHead className="text-left">注册时间</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((user) => (
              <TableRow key={user.id}>
                <TableCell>
                  <div className="font-medium text-foreground">{user.name}</div>
                  <div className="text-xs text-muted-foreground">{user.email}</div>
                </TableCell>
                <TableCell>
                  <RoleSelect
                    value={user.role}
                    disabled={actionLoading === user.id}
                    onChange={(role) => updateUser(user.id, { role })}
                    ariaLabel={`${user.name} 的角色`}
                  />
                </TableCell>
                <TableCell>
                  <span className={`badge ${user.banned ? "badge-destructive" : "badge-success"}`}>
                    <i aria-hidden="true" />
                    {user.banned ? "已封禁" : "正常"}
                  </span>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {new Date(user.createdAt).toLocaleDateString("zh-CN")}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEntitlementUser(user)}
                    >
                      权益
                    </Button>
                    <Button
                      variant={user.banned ? "outline" : "destructive"}
                      size="sm"
                      onClick={() => updateUser(user.id, { action: user.banned ? "unban" : "ban" })}
                      disabled={actionLoading === user.id}
                    >
                      {actionLoading === user.id ? (
                        <Loader2 className="animate-spin" aria-hidden="true" size={16} />
                      ) : (
                        user.banned ? "解封" : "封禁"
                      )}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {users.length === 0 && (
        <PageState state="empty" title="还没有用户" description="用户注册后会显示在这里。" />
      )}

      {pagination.totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between border-t border-border pt-4">
          <span className="text-xs text-muted-foreground">
            共 {pagination.total} 个用户
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => fetchUsers(pagination.page - 1)}
              disabled={pagination.page <= 1}
            >
              上一页
            </Button>
            <span className="text-xs text-muted-foreground">
              {pagination.page} / {pagination.totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => fetchUsers(pagination.page + 1)}
              disabled={pagination.page >= pagination.totalPages}
            >
              下一页
            </Button>
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

export function EntitlementPanel({
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
        body: JSON.stringify({
          items: buildItems(form).filter((item) => !(
            item.subsystem === "cqu" &&
            (item.capability === "quicklogin" ||
              item.capability === "quicklogin_device_limit")
          )),
        }),
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
    <Modal
      onClose={onClose}
      title="分级权益 / 能力授权"
      description={`${user.name} · ${user.email}`}
      footer={
        !initLoading ? (
          <>
            <p className="mr-auto text-xs text-muted-foreground">勾选/填值即授权;留空数量表示无限。保存为整组替换。</p>
            <Button variant="outline" onClick={onClose} disabled={saving}>
              取消
            </Button>
            <Button onClick={handleSave} disabled={saving || applyingPreset}>
              {saving && <Loader2 className="animate-spin" aria-hidden="true" size={16} />}
              保存
            </Button>
          </>
        ) : undefined
      }
    >
      <div className="space-y-5">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {success && (
          <Alert className="border-success/40 bg-success/10">
            <AlertDescription className="text-success">{success}</AlertDescription>
          </Alert>
        )}

        {initLoading ? (
          <PageState state="loading" title="正在加载权益" description="正在读取该用户的权益与预设…" />
        ) : (
          <>
            {presets.length > 0 && (
              <div className="flex items-end gap-2 rounded-lg border border-border bg-muted p-3">
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
                    className="w-full"
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleApplyPreset}
                  disabled={applyingPreset || saving}
                >
                  {applyingPreset && <Loader2 className="animate-spin" aria-hidden="true" size={16} />}
                  套用
                </Button>
              </div>
            )}

            <div className="border-t border-border pt-4">
              <EntitlementMatrix
                form={form}
                onChange={setForm}
                quickloginPolicyReadOnly
              />
            </div>
            {canEditQuota && (
              <QuotaEditor
                userId={user.id}
                onSaved={(deviceLimit) => setForm((current) => ({
                  ...current,
                  "cqu.quicklogin_device_limit": { quota: String(deviceLimit) },
                }))}
              />
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
