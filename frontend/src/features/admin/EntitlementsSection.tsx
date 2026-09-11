import { useState, useEffect, useCallback } from "react";
import MenuSelect from "../../components/MenuSelect";
import { EntitlementMatrix } from "../../components/EntitlementFields";
import { buildItems, formFromItems, summarizeItems, type EntitlementForm, type EntitlementItem } from "../../components/entitlement-form";
import { adminFetch } from "../../lib/api/admin";
import { FieldLabel, Modal, inputClass } from "./ui";


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
export function EntitlementsSection() {
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
        adminFetch("/admin/entitlement-presets"),
        adminFetch("/admin/entitlement-default"),
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
