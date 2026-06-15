import { useState, useEffect, useCallback } from "react";
import {
  CAPABILITIES,
  type CapDef,
  type Subsystem,
} from "../../../../../src/capabilities";
import type { User, EntitlementRow, EntitlementForm } from "../types";
import { SUBSYSTEM_LABELS, PRESET_NAMES, readErrorMessage } from "../constants";
import { Modal, FieldLabel, inputClass } from "../../../components/ui";

// 把后端返回的 rows 投影进表单态(以 CAPABILITIES 为准遍历,逐个能力填值)。
export function formFromRows(rows: EntitlementRow[]): EntitlementForm {
  const byKey = new Map(
    rows.map((r) => [`${r.subsystem}.${r.capability}`, r.value])
  );
  const form: EntitlementForm = {};
  for (const subsystem of Object.keys(CAPABILITIES) as Subsystem[]) {
    const caps = CAPABILITIES[subsystem] as Record<string, CapDef>;
    for (const capability of Object.keys(caps)) {
      const key = `${subsystem}.${capability}`;
      const value = byKey.get(key);
      if (caps[capability].type === "flag") {
        form[key] = { flag: value === "1" };
      } else {
        // quota:存在且为数字串则填入;空/缺省 → 无限(空输入框)。
        form[key] = { quota: value && /^\d+$/.test(value) ? value : "" };
      }
    }
  }
  return form;
}

export function EntitlementPanel({
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
  const [preset, setPreset] = useState(PRESET_NAMES[0] ?? "");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const load = useCallback(async () => {
    setInitLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/users/${user.id}/entitlements`);
      if (res.ok) {
        const data = (await res.json()) as { data: EntitlementRow[] };
        setForm(formFromRows(data.data ?? []));
      } else {
        setError(await readErrorMessage(res, "加载权益失败"));
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

  const setFlag = (key: string, flag: boolean) =>
    setForm((prev) => ({ ...prev, [key]: { ...prev[key], flag } }));
  const setQuota = (key: string, quota: string) =>
    // 仅允许数字(空串=无限);非数字字符直接丢弃,保证 value 始终是数字串或 ""。
    setForm((prev) => ({
      ...prev,
      [key]: { ...prev[key], quota: quota.replace(/[^\d]/g, "") },
    }));

  // 把表单态压成 PUT items(整组替换):勾选 flag→value "1";非空 quota→数字串。
  // 未勾 flag / 空 quota 一律省略(absence = false / 无限)。
  const buildItems = () => {
    const items: { subsystem: string; capability: string; value: string }[] = [];
    for (const subsystem of Object.keys(CAPABILITIES) as Subsystem[]) {
      const caps = CAPABILITIES[subsystem] as Record<string, CapDef>;
      for (const capability of Object.keys(caps)) {
        const key = `${subsystem}.${capability}`;
        const entry = form[key];
        if (!entry) continue;
        if (caps[capability].type === "flag") {
          if (entry.flag) items.push({ subsystem, capability, value: "1" });
        } else {
          const q = (entry.quota ?? "").trim();
          if (q) items.push({ subsystem, capability, value: q });
        }
      }
    }
    return items;
  };

  const handleSave = async () => {
    setError("");
    setSuccess("");
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/users/${user.id}/entitlements`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: buildItems() }),
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
            {PRESET_NAMES.length > 0 && (
              <div className="flex items-end gap-2 border border-gray-100 bg-gray-50 rounded-xl p-3">
                <div className="flex-1">
                  <FieldLabel hint="一键写入预设权益,之后仍可逐项调整">套用预设</FieldLabel>
                  <select
                    value={preset}
                    onChange={(e) => setPreset(e.target.value)}
                    className={inputClass}
                  >
                    {PRESET_NAMES.map((name) => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </select>
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
            {(Object.keys(CAPABILITIES) as Subsystem[]).map((subsystem) => {
              const caps = CAPABILITIES[subsystem] as Record<string, CapDef>;
              return (
                <div key={subsystem} className="border-t border-gray-100 pt-4 first:border-t-0 first:pt-0">
                  <p className="text-xs font-semibold text-gray-700 mb-2">
                    {SUBSYSTEM_LABELS[subsystem] ?? subsystem}
                    <span className="ml-2 font-mono font-normal text-gray-400">{subsystem}</span>
                  </p>
                  <div className="space-y-1">
                    {Object.keys(caps).map((capability) => {
                      const def = caps[capability];
                      const key = `${subsystem}.${capability}`;
                      if (def.type === "flag") {
                        return (
                          <label
                            key={key}
                            className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-50 cursor-pointer"
                          >
                            <input
                              type="checkbox"
                              checked={form[key]?.flag ?? false}
                              onChange={(e) => setFlag(key, e.target.checked)}
                              className="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                            />
                            <span className="text-sm text-gray-700">{def.label}</span>
                            <span className="text-xs text-gray-400 font-mono ml-auto">{capability}</span>
                          </label>
                        );
                      }
                      // quota:数字输入框,空=无限。
                      return (
                        <div
                          key={key}
                          className="flex items-center gap-3 p-2 rounded-lg"
                        >
                          <span className="text-sm text-gray-700">{def.label}</span>
                          <span className="text-xs text-gray-400 font-mono">{capability}</span>
                          <div className="flex items-center gap-1.5 ml-auto">
                            <input
                              type="number"
                              min={0}
                              inputMode="numeric"
                              value={form[key]?.quota ?? ""}
                              onChange={(e) => setQuota(key, e.target.value)}
                              placeholder="无限"
                              className="w-28 text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder:text-gray-300"
                              aria-label={`${def.label}(${def.unit ?? "数量"};留空为无限)`}
                            />
                            {def.unit && <span className="text-xs text-gray-400">{def.unit}</span>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
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
