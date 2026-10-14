// 按子系统分组的能力编辑矩阵:flag 渲染为勾选行,quota 渲染为数字输入(空=无限)。
// per-user 权益面板与预设编辑器共用。
// 表单态与纯函数在 ./entitlement-form(该文件无组件导出,满足 fast-refresh 约束)。
import { Input } from "@cqu-moe/ui";
import {
  CAPABILITIES,
  type CapDef,
  type Subsystem,
} from "../../../shared/capabilities";
import MenuSelect from "./MenuSelect";
import {
  SUBSYSTEM_LABELS,
  type EntitlementForm,
  type OptionalQuotaState,
} from "./entitlement-form";

export function EntitlementMatrix({
  form,
  onChange,
  quickloginPolicyReadOnly = false,
  manualOnlyHidden = false,
}: {
  form: EntitlementForm;
  onChange: (next: EntitlementForm) => void;
  quickloginPolicyReadOnly?: boolean;
  manualOnlyHidden?: boolean;
}) {
  type OptionalQuotaOption = {
    value: OptionalQuotaState;
    label: string;
    hint?: string;
  };

  const setFlag = (key: string, flag: boolean) =>
    onChange({ ...form, [key]: { ...form[key], flag } });
  const setQuota = (key: string, quota: string) =>
    // 仅允许数字(空串=无限);非数字字符直接丢弃,保证 value 始终是数字串或 ""。
    onChange({
      ...form,
      [key]: { ...form[key], quota: quota.replace(/[^\d]/g, "") },
    });
  const setOptionalNumber = (key: string, quota: string) => {
    const digits = quota.replace(/[^\d]/g, "");
    onChange({
      ...form,
      [key]: { optionalQuota: "number", quota: digits },
    });
  };
  const setOptionalState = (key: string, state: OptionalQuotaState) =>
    onChange({
      ...form,
      [key]:
        state === "number"
          ? { optionalQuota: "number", quota: form[key]?.quota ?? "" }
          : { optionalQuota: state },
    });

  return (
    <div className="space-y-5">
      {(Object.keys(CAPABILITIES) as Subsystem[]).map((subsystem) => {
        const caps = CAPABILITIES[subsystem] as Record<string, CapDef>;
        return (
          <div key={subsystem}>
            <p className="mb-2 text-xs font-semibold text-foreground">
              {SUBSYSTEM_LABELS[subsystem] ?? subsystem}
              <span className="ml-2 font-mono font-normal text-muted-foreground">
                {subsystem}
              </span>
            </p>
            <div className="space-y-1">
              {Object.keys(caps).map((capability) => {
                const def = caps[capability];
                const key = `${subsystem}.${capability}`;
                if (def.manualOnly && manualOnlyHidden) return null;
                if (
                  quickloginPolicyReadOnly &&
                  (key === "cqu.quicklogin_device_limit" || key === "cqu.quicklogin")
                ) {
                  const value = def.type === "quota"
                    ? (form[key]?.quota || "未初始化")
                    : (form[key]?.flag ? "已开启" : "已关闭");
                  const hint = def.type === "quota"
                    ? "设备额度须通过专用预览流程调整"
                    : "总开关由用户在账户设置中管理";
                  return (
                    <div key={key} className="flex flex-wrap items-center gap-2 p-2 text-sm">
                      <span className="text-foreground">{def.label}</span>
                      <span className="font-mono text-xs text-muted-foreground">{capability}</span>
                      <output
                        aria-label={`${def.label}当前值`}
                        className="ml-auto text-sm font-medium text-foreground"
                      >
                        {value}{def.type === "quota" && value !== "未初始化" ? ` ${def.unit ?? ""}` : ""}
                      </output>
                      <p className="basis-full text-xs text-muted-foreground">{hint}</p>
                    </div>
                  );
                }
                if (def.type === "flag") {
                  return (
                    <label
                      key={key}
                      className="flex cursor-pointer items-center gap-3 rounded-lg p-2 hover:bg-muted"
                    >
                      <input
                        type="checkbox"
                        checked={form[key]?.flag ?? false}
                        onChange={(e) => setFlag(key, e.target.checked)}
                        className="size-4 accent-primary"
                      />
                      <span className="text-sm text-foreground">{def.label}</span>
                      <span className="ml-auto font-mono text-xs text-muted-foreground">
                        {capability}
                      </span>
                    </label>
                  );
                }
                if (def.optional) {
                  const state = form[key]?.optionalQuota ?? "unset";
                  const options: OptionalQuotaOption[] = [
                    { value: "unset", label: "未授予" },
                    ...(def.allowUnlimited
                      ? [{
                          value: "unlimited" as const,
                          label: "无限",
                          hint: "明确授权不限次数",
                        }]
                      : []),
                    { value: "number", label: "指定数值" },
                  ];
                  return (
                    <div key={key} className="flex flex-wrap items-center gap-3 rounded-lg p-2">
                      <span className="text-sm text-foreground">{def.label}</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {capability}
                      </span>
                      <div className="ml-auto flex items-center gap-1.5">
                        <MenuSelect
                          value={state}
                          options={options}
                          onChange={(next) => setOptionalState(key, next)}
                          aria-label={`${def.label}授权状态`}
                          size="sm"
                        />
                        {state === "number" && (
                          <Input
                            type="number"
                            min={def.zeroAllowed ? 0 : def.minimum ?? 0}
                            inputMode="numeric"
                            value={form[key]?.quota ?? ""}
                            onChange={(e) => setOptionalNumber(key, e.target.value)}
                            className="w-24"
                            aria-label={`${def.label}数值`}
                          />
                        )}
                        {def.unit && state !== "unset" && (
                          <span className="text-xs text-muted-foreground">{def.unit}</span>
                        )}
                      </div>
                      {def.hint && (
                        <p className="basis-full text-xs text-muted-foreground">{def.hint}</p>
                      )}
                    </div>
                  );
                }
                // quota:数字输入框,空=无限。
                return (
                  <div key={key} className="flex items-center gap-3 rounded-lg p-2">
                    <span className="text-sm text-foreground">{def.label}</span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {capability}
                    </span>
                    <div className="ml-auto flex items-center gap-1.5">
                      <Input
                        type="number"
                        min={0}
                        inputMode="numeric"
                        value={form[key]?.quota ?? ""}
                        onChange={(e) => setQuota(key, e.target.value)}
                        placeholder="无限"
                        className="w-28"
                        aria-label={`${def.label}(${def.unit ?? "数量"};留空为无限)`}
                      />
                      {def.unit && (
                        <span className="text-xs text-muted-foreground">{def.unit}</span>
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
