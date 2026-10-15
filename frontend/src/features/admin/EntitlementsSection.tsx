import { useState, useEffect, useCallback } from "react";
import { Loader2, Plus } from "lucide-react";
import {
  ActionButton,
  Alert,
  AlertDescription,
  Button,
  Input,
  PageState,
} from "@cqu-moe/ui";
import MenuSelect from "../../components/MenuSelect";
import { EntitlementMatrix } from "../../components/EntitlementFields";
import {
  buildItems,
  formFromItems,
  summarizeItems,
  validateEntitlementForm,
  type EntitlementForm,
  type EntitlementItem,
} from "../../components/entitlement-form";
import { adminFetch } from "../../lib/api/admin";
import { EntitlementsSkeleton } from "./AdminSkeletons";
import { FieldLabel, Modal } from "./ui";

interface EntitlementPreset {
  name: string;
  items: EntitlementItem[];
  updatedAt?: string;
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
    const invalid = validateEntitlementForm(form);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError("");
    setSaving(true);
    try {
      const res = await adminFetch(
        `/admin/entitlement-presets/${encodeURIComponent(trimmed)}`,
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
    <Modal
      onClose={onClose}
      title={isEdit ? `编辑预设「${name}」` : "新建预设"}
      description="勾选/填值即授权;留空数量表示无限。"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <ActionButton
            type="button"
            onClick={handleSave}
            state={saving ? "loading" : "idle"}
            labels={{
              idle: "保存",
              loading: "正在保存…",
              success: "已保存",
              error: "重试保存",
            }}
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

        {!isEdit && (
          <div>
            <FieldLabel htmlFor="preset-name" hint="例如:学生、助教、特邀教师">预设名称</FieldLabel>
            <Input
              id="preset-name"
              type="text"
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              maxLength={50}
              placeholder="预设名称"
            />
          </div>
        )}

        <EntitlementMatrix
          form={form}
          onChange={setForm}
          quickloginPolicyReadOnly
          manualOnlyHidden
        />
      </div>
    </Modal>
  );
}

// 权益预设管理 + 新注册用户默认权益。
// 预设事实源在 D1(entitlement_preset 表);默认预设名存 entitlement_config,
// 注册钩子按它给新用户写初始权益行。删除默认预设时后端会顺带清掉默认配置。
export function EntitlementsSection() {
  const [presets, setPresets] = useState<EntitlementPreset[]>([]);
  const [defaultPreset, setDefaultPreset] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [defaultState, setDefaultState] = useState<"idle" | "saving" | "saved">("idle");
  const [editing, setEditing] = useState<{
    name: string | null;
    form: EntitlementForm;
  } | null>(null);
  // 删除两段确认:先点「删除」进入待确认,再点「确认删除」执行。
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    setError("");
    try {
      const [presetsRes, defaultRes] = await Promise.all([
        adminFetch("/admin/entitlement-presets"),
        adminFetch("/admin/entitlement-default"),
      ]);
      if (presetsRes.ok) {
        const data = (await presetsRes.json()) as { data: EntitlementPreset[] };
        setPresets(data.data ?? []);
        setHasLoaded(true);
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
      setRefreshing(false);
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
      const res = await adminFetch("/admin/entitlement-default", {
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
      const res = await adminFetch(
        `/admin/entitlement-presets/${encodeURIComponent(name)}`,
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
      <EntitlementsSkeleton />
    );
  }

  if (error && !hasLoaded) {
    return (
      <PageState
        state="error"
        title="加载预设失败"
        description={error}
        action={
          <Button
            disabled={refreshing}
            onClick={() => {
              setLoading(true);
              void load();
            }}
          >
            重试
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-6" aria-busy={refreshing}>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <Alert className="border-success/40 bg-success/10">
          <AlertDescription className="text-success">{notice}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-5">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">新用户默认权益</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            注册成功后自动套用的预设;选「无」则新用户不带任何权益。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {defaultState === "saving" && (
            <Loader2 className="animate-spin text-muted-foreground" aria-hidden="true" size={14} />
          )}
          {defaultState === "saved" && (
            <span className="text-xs text-success">已保存</span>
          )}
          <MenuSelect
            value={defaultPreset ?? ""}
            onChange={(v) => void changeDefault(v)}
            disabled={defaultState === "saving" || refreshing}
            options={[
              { value: "", label: "无默认权益" },
              ...presets.map((p) => ({
                value: p.name,
                label: p.name,
                hint: `${p.items.length} 项能力`,
              })),
            ]}
            aria-label="新用户默认权益"
            size="sm"
          />
        </div>
      </div>

      <div>
        <div className="mb-3 flex items-center justify-between">
          <p className="text-sm font-medium text-foreground">全部预设</p>
          <Button
            type="button"
            size="sm"
            disabled={refreshing}
            onClick={() =>
              setEditing({ name: null, form: formFromItems([]) })
            }
          >
            <Plus aria-hidden="true" size={16} />
            新建预设
          </Button>
        </div>

        {presets.length === 0 ? (
          <PageState state="empty" title="暂无预设" description="新建预设后，可为用户一键套用权益。" />
        ) : (
          <div className="divide-y divide-border rounded-lg border border-border">
            {presets.map((p) => (
              <div key={p.name} className="flex flex-col gap-4 px-4 py-3 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <div className="flex min-h-7 items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{p.name}</span>
                    {defaultPreset === p.name && (
                      <span className="badge badge-success">默认</span>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {summarizeItems(p.items)}
                    {p.updatedAt && ` · 更新于 ${new Date(p.updatedAt + "Z").toLocaleDateString("zh-CN")}`}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={refreshing}
                    onClick={() =>
                      setEditing({ name: p.name, form: formFromItems(p.items) })
                    }
                  >
                    编辑
                  </Button>
                  {confirmDelete === p.name ? (
                    <ActionButton
                      variant="destructive"
                      size="sm"
                      type="button"
                      onClick={() => void handleDelete(p.name)}
                      disabled={refreshing}
                      state={deleting === p.name ? "loading" : "idle"}
                      labels={{
                        idle: "确认删除",
                        loading: "删除中…",
                        success: "已删除",
                        error: "重试删除",
                      }}
                    />
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      disabled={refreshing}
                      onClick={() => setConfirmDelete(p.name)}
                    >
                      删除
                    </Button>
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
