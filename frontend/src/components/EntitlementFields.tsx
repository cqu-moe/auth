// 按子系统分组的能力编辑矩阵:flag 渲染为勾选行,quota 渲染为数字输入(空=无限)。
// per-user 权益面板与预设编辑器共用。
// 表单态与纯函数在 ./entitlement-form(该文件无组件导出,满足 fast-refresh 约束)。
import {
  CAPABILITIES,
  type CapDef,
  type Subsystem,
} from "../../../src/capabilities";
import { SUBSYSTEM_LABELS, type EntitlementForm } from "./entitlement-form";

export function EntitlementMatrix({
  form,
  onChange,
  quickloginQuotaReadOnly = false,
}: {
  form: EntitlementForm;
  onChange: (next: EntitlementForm) => void;
  quickloginQuotaReadOnly?: boolean;
}) {
  const setFlag = (key: string, flag: boolean) =>
    onChange({ ...form, [key]: { ...form[key], flag } });
  const setQuota = (key: string, quota: string) =>
    // 仅允许数字(空串=无限);非数字字符直接丢弃,保证 value 始终是数字串或 ""。
    onChange({
      ...form,
      [key]: { ...form[key], quota: quota.replace(/[^\d]/g, "") },
    });

  return (
    <div className="space-y-5">
      {(Object.keys(CAPABILITIES) as Subsystem[]).map((subsystem) => {
        const caps = CAPABILITIES[subsystem] as Record<string, CapDef>;
        return (
          <div key={subsystem}>
            <p className="text-xs font-semibold text-gray-700 mb-2">
              {SUBSYSTEM_LABELS[subsystem] ?? subsystem}
              <span className="ml-2 font-mono font-normal text-gray-400">
                {subsystem}
              </span>
            </p>
            <div className="space-y-1">
              {Object.keys(caps).map((capability) => {
                const def = caps[capability];
                const key = `${subsystem}.${capability}`;
                if (quickloginQuotaReadOnly && key === "cqu.quicklogin_device_limit") {
                  return (
                    <div key={key} className="flex flex-wrap items-center gap-2 p-2 text-sm text-gray-600">
                      <span>{def.label}</span>
                      <span className="text-xs text-gray-400">请使用下方专用额度编辑器</span>
                    </div>
                  );
                }
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
                      <span className="text-xs text-gray-400 font-mono ml-auto">
                        {capability}
                      </span>
                    </label>
                  );
                }
                // quota:数字输入框,空=无限。
                return (
                  <div key={key} className="flex items-center gap-3 p-2 rounded-lg">
                    <span className="text-sm text-gray-700">{def.label}</span>
                    <span className="text-xs text-gray-400 font-mono">
                      {capability}
                    </span>
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
                      {def.unit && (
                        <span className="text-xs text-gray-400">{def.unit}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
