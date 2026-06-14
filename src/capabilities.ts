// 能力目录(方案 A:TS 常量)—— 系统里「存在哪些能力」的唯一权威源。
// 类型安全 + git 版本化,前后端 / 各子系统共享一份;打错 key 编译期就炸。
// 新增能力在此加一行 + 重部署。改 schema 不是事实源 —— 事实源是 user_entitlement 表
// (每用户 × 子系统 × 能力的授权值),此目录只声明「键空间 + 类型 + 展示标签」。
export type CapType = "flag" | "quota";
export interface CapDef {
  type: CapType;
  label: string;
  unit?: string;
}

export const CAPABILITIES = {
  calendar: {
    sync: { type: "flag", label: "日历同步" },
    sync_limit: { type: "quota", label: "同步上限", unit: "条" }, // value 存数字;null=无限
    share: { type: "flag", label: "共享日历" },
  },
  eval: {
    submit: { type: "flag", label: "提交评教" },
    batch: { type: "flag", label: "批量评教" },
  },
  cqu: {
    // 浏览器插件快捷登录的 per-user 同意开关(见 Phase D)。它**永远不是取票闸**
    // ——出票的权威校验落在 DO;此 flag 只表达「用户是否同意插件替他取 ST」。
    quicklogin: { type: "flag", label: "允许浏览器插件快捷登录" },
  },
} as const satisfies Record<string, Record<string, CapDef>>;

// 预设:admin「一键套用」便利层,**非事实源**。套用 = 往 user_entitlement 写若干行,
// 之后仍可逐项增删。值约定同 user_entitlement.value 的解析:flag 用 1,quota 用数字,
// null 表示「无限」(quota 专用)。
export const PRESETS: Record<
  string,
  Record<string, Record<string, number | null>>
> = {
  学生: { calendar: { sync: 1, sync_limit: 50 }, eval: { submit: 1 } },
  助教: {
    calendar: { sync: 1, sync_limit: null, share: 1 },
    eval: { submit: 1, batch: 1 },
  },
};

export const isFlag = (d: CapDef) => d.type === "flag";
export const isQuota = (d: CapDef) => d.type === "quota";

export type Subsystem = keyof typeof CAPABILITIES;
export const SUBSYSTEMS = Object.keys(CAPABILITIES) as Subsystem[];
