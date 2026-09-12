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
    // 字段集与 schedule(cqu-moe/schedule-cloudflare)的 CalendarCaps 契约对齐(见 issue #6)。
    // schedule 经 Service Binding RPC 消费 caps.calendar;缺字段会让 schedule fail-closed。
    sync: { type: "flag", label: "日历同步" }, // 个人课表自动同步开关
    external: { type: "flag", label: "外部订阅" }, // 教师/教室/实验室/课程/行政班 公开课表订阅
    share: { type: "flag", label: "共享日历" }, // 共享链接开关
    change_notification: { type: "flag", label: "课表变更邮件通知" },
    sub_limit: { type: "quota", label: "订阅上限", unit: "条" }, // 订阅数量上限;null=无限
    share_limit: { type: "quota", label: "分享链接上限", unit: "条" }, // 每用户分享链接总数;null=无限
    sync_interval: { type: "quota", label: "同步间隔", unit: "分钟" }, // 自动同步间隔档位(越小越新鲜);null=默认/最长。实际下限受 cron 每小时一次限制
    manual_refresh: { type: "quota", label: "每日手动刷新上限", unit: "次/天" }, // null=无限
  },
  eval: {
    submit: { type: "flag", label: "提交评教" },
    batch: { type: "flag", label: "批量评教" },
  },
  cqu: {
    quicklogin_device_limit: {
      type: "quota",
      label: "快捷登录设备额度",
      unit: "台",
    },
    // 浏览器插件快捷登录的「功能开放」闸(灰度/准入):由 admin 授予。无此权益的用户
    // 在设置页看不到快捷登录卡片,自助端点拒写,DO 广路径取票也拒(见 cqu-session.ts)。
    // 与 quicklogin 是两个独立维度:access 管「是否向该用户开放此功能」,
    // quicklogin 管「用户本人是否同意插件替他取 ST」—— 准入绝不等于代用户同意。
    quicklogin_access: { type: "flag", label: "浏览器插件快捷登录(功能开放)" },
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
  学生: {
    calendar: { sync: 1, external: 1, sub_limit: 50, sync_interval: 360, manual_refresh: 5 },
    eval: { submit: 1 },
  },
  助教: {
    calendar: {
      sync: 1,
      external: 1,
      share: 1,
      sub_limit: null,
      share_limit: null,
      sync_interval: 60,
      manual_refresh: null,
    },
    eval: { submit: 1, batch: 1 },
  },
};

export const isFlag = (d: CapDef) => d.type === "flag";
export const isQuota = (d: CapDef) => d.type === "quota";

export type Subsystem = keyof typeof CAPABILITIES;
export const SUBSYSTEMS = Object.keys(CAPABILITIES) as Subsystem[];
