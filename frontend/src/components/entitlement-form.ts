// 能力目录单一事实源:直接复用 shared/capabilities.ts(纯常量,无服务端依赖,
// 可被前端 bundle)。新增能力只需在 shared 目录这一处加行,前后端自动同步。
import {
  CAPABILITIES,
  type CapDef,
  type Subsystem,
} from "../../../shared/capabilities";

// 一项 entitlement 的最小形状:per-user 行、预设项、PUT 提交体都是这个结构
// (per-user 行多 userId/updatedAt,结构化类型下可直接传入)。
export interface EntitlementItem {
  subsystem: string;
  capability: string;
  value: string;
}

// 表单态:flag → boolean(勾选=授权);quota → 字符串(空=无限,否则数字串)。
// key = `${subsystem}.${capability}`。保存时压回 EntitlementItem[]:
// 仅把勾选的 flag(value "1")与非空 quota 发出,未勾/空缺省即「false / 无限」。
// optional quota 另有 state:unset=未授予、unlimited=明确无限、number=明确数值。
export type OptionalQuotaState = "unset" | "unlimited" | "number";
export type EntitlementForm = Record<string, {
  flag?: boolean;
  quota?: string;
  optionalQuota?: OptionalQuotaState;
}>;

// 子系统中文名(展示用;键来自 CAPABILITIES,缺省回退键名本身)。
export const SUBSYSTEM_LABELS: Record<string, string> = {
  calendar: "日历",
  eval: "评教",
  cqu: "CQU 服务",
};

// 把既有项(用户行/预设项)投影进表单态(以 CAPABILITIES 为准遍历,逐个能力填值)。
export function formFromItems(items: EntitlementItem[]): EntitlementForm {
  const byKey = new Map(
    items.map((r) => [`${r.subsystem}.${r.capability}`, r.value])
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
        if (caps[capability].optional) {
          if (value === undefined) form[key] = { optionalQuota: "unset" };
          else if (value === "") {
            form[key] = {
              optionalQuota: caps[capability].allowUnlimited ? "unlimited" : "unset",
            };
          } else {
            form[key] = {
              optionalQuota: "number",
              quota: /^\d+$/.test(value) ? value : "",
            };
          }
        } else {
          // quota:存在且为数字串则填入;空/缺省 → 无限(空输入框)。
          form[key] = { quota: value && /^\d+$/.test(value) ? value : "" };
        }
      }
    }
  }
  return form;
}

// 把表单态压成提交 items:勾选 flag→value "1";非空 quota→数字串。
// 未勾 flag / 空 quota 一律省略(absence = false / 无限)。
export function buildItems(form: EntitlementForm): EntitlementItem[] {
  const items: EntitlementItem[] = [];
  for (const subsystem of Object.keys(CAPABILITIES) as Subsystem[]) {
    const caps = CAPABILITIES[subsystem] as Record<string, CapDef>;
    for (const capability of Object.keys(caps)) {
      const key = `${subsystem}.${capability}`;
      const entry = form[key];
      if (!entry) continue;
      if (caps[capability].type === "flag") {
        if (entry.flag) items.push({ subsystem, capability, value: "1" });
      } else {
        if (caps[capability].optional) {
          if (entry.optionalQuota === "unlimited") {
            items.push({ subsystem, capability, value: "" });
          } else if (entry.optionalQuota === "number") {
            const q = (entry.quota ?? "").trim();
            if (q) items.push({ subsystem, capability, value: q });
          }
        } else {
          const q = (entry.quota ?? "").trim();
          if (q) items.push({ subsystem, capability, value: q });
        }
      }
    }
  }
  return items;
}

export function validateEntitlementForm(form: EntitlementForm): string | null {
  for (const subsystem of Object.keys(CAPABILITIES) as Subsystem[]) {
    const caps = CAPABILITIES[subsystem] as Record<string, CapDef>;
    for (const [capability, def] of Object.entries(caps)) {
      if (def.type !== "quota" || !def.optional) continue;
      const entry = form[`${subsystem}.${capability}`];
      if (entry?.optionalQuota !== "number") continue;
      const value = (entry.quota ?? "").trim();
      if (!value) return `请填写${def.label}数值`;
      const amount = Number(value);
      if (!Number.isSafeInteger(amount)) {
        return `${def.label}必须是不超过安全整数范围的非负整数`;
      }
      if (
        def.minimum !== undefined &&
        amount < def.minimum &&
        !(def.zeroAllowed && amount === 0)
      ) {
        return amount === 0
          ? `${def.label}不能使用 0，请选择未授予或至少 ${def.minimum} 分钟`
          : `${def.label}不能小于 ${def.minimum}`;
      }
    }
  }
  return null;
}

// 把一组 items 摘要成短文本(预设列表用):取前 max 个能力中文标签,超出以 +N 表示。
export function summarizeItems(items: EntitlementItem[], max = 4): string {
  if (items.length === 0) return "无任何能力";
  const labels = items.map((it) => {
    const defs = (CAPABILITIES as Record<string, Record<string, CapDef>>)[
      it.subsystem
    ];
    return defs?.[it.capability]?.label ?? `${it.subsystem}.${it.capability}`;
  });
  const shown = labels.slice(0, max).join("、");
  return labels.length > max ? `${shown} 等 ${labels.length} 项` : shown;
}
