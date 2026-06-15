# 用户中心 + 管理后台重构 — 设计文档

- 日期：2026-06-15
- 分支策略：**先合 PR #5（firstparty-entitlements）上生产，再从 `main` 开 `feat/user-center`**。本文档与后续实现计划落在该新分支。
- 性质：**前端为主**的重构。唯一后端改动是给 `/api/admin/users` 加 `?search=` 查询过滤。

## 背景与动机

后端的分级权益（entitlements）能力早已就绪：`customSession` 在 SPA 会话里已注入 `caps`（`src/auth.ts:126-129`），但前端 4 个页面**没有任何一处读它** —— 用户「看不到自己的权益」不是数据缺口，纯粹是没做展示 UI。

同时前端存在两处结构性债务：

- `frontend/src/pages/Settings.tsx`（918 行）把四种不同性质的东西挤在一页：个人信息（展示）、修改密码（安全）、CQU 绑定（带 WebSocket 实时验证码的完整子流程）、快捷登录开关（权益 opt-in）。
- `frontend/src/pages/Admin.tsx`（1696 行）是单文件巨石：用户管理、权益面板、OAuth 客户端编辑器（500+ 行）、各种 Modal、复用原语全塞一处。这是它「一坨稀泥」的根因 —— 是结构问题，不是样式问题。

## 目标

1. 把用户侧重构成**用户中心**：仪表盘当门面，现有设置降格为「安全设置」一块。
2. 用户能在仪表盘看到自己的**权益与配额上限**（只读）。
3. 管理后台**结构 + UX 深度重做**：拆巨石、重做 OAuth 编辑器、改进用户管理。

## 非目标（YAGNI）

- ❌ 配额「已用量」（used/limit）。caps 只有上限值；已用量在 calendar/schedule 子系统里，auth 不掌握，跨服务改造，本轮明确排除，**只展示上限**。
- ❌ 新的 entitlement 后端语义、i18n、暗色模式。
- ❌ 用户自助修改自己的权益（仪表盘只读；写仍是 admin/superAdmin only）。

## 关键技术事实（已核对）

- **caps 值编码**（`src/services/entitlements.ts:11-30` `rowsToCaps`）：`Caps = Record<subsystem, Record<capability, boolean | number | null>>`；flag → `boolean`，quota → `number`（上限）或 `null`（= 无限/未设）。
- **SPA 会话 caps 只含 `calendar` + `eval`**：`customSession` 里 `delete caps.cqu`（`src/auth.ts:128`）。仪表盘「我的权益」天然只展示这两个子系统。
- **能力目录可被前端 bundle**：`src/capabilities.ts` 是纯 TS 常量，无服务端依赖，前端直接 `import`（Admin.tsx 已这么用），提供 label/unit/type。
- **路由守卫已正确**：`ProtectedRoute` 放行 `admin` + `superAdmin`（`ProtectedRoute.tsx:27`）。但 **`Layout` 导航链接只认 `role === "admin"`**（漏掉 superAdmin）—— 重做时修掉。
- **`/api/admin/users` 不支持搜索**：列表端点只有 `page/limit/offset`。

## A. 整体架构 · 路由 · 外壳

新建 `UserCenterLayout`（左侧边栏 + 右内容区，移动端折叠成抽屉），替换现有 `Layout`。侧边栏分组：

| 入口 | 路由 | 内容 |
|---|---|---|
| 概览 | `/dashboard` | 仪表盘（新） |
| 安全设置 | `/security` | 个人信息 + 修改密码（从 Settings 拆出） |
| CQU 账户 | `/cqu` | 绑定状态 + 实时验证码 + 快捷登录开关（从 Settings 拆出） |
| —— 分隔 —— | | |
| 管理控制台 | `/admin` | 仅 admin/superAdmin |

路由行为：

| 路由 | 行为 |
|---|---|
| `/` | 纯重定向分流器：已登录 → `/dashboard`；未登录 → `/login`（沿用现有 `RootRedirect` 模式，目标从 `/settings` 改为 `/dashboard`） |
| `/dashboard` | 仪表盘（受保护） |
| `/security` | 安全设置（受保护） |
| `/cqu` | CQU 账户（受保护） |
| `/cqu/bind` | 绑定向导（原样保留） |
| `/admin` | 管理控制台（admin/superAdmin） |
| `/settings` | 302 → `/security`（旧书签 / `signOut` 跳转兼容） |

- 侧边栏「概览」高亮直接比 `/dashboard`，不必处理 `/` 这个瞬间跳走的特殊态。
- 顺手修掉 `Layout` 漏放 superAdmin 的导航 bug（侧边栏「管理控制台」入口用 `role === "admin" || role === "superAdmin"`）。

## B. 用户中心三页（拆解 Settings.tsx）

把 918 行的 `Settings.tsx` 拆解到三个聚焦页面（各归各位，逻辑零改动、只迁移）：

- **安全设置** `/security`：`个人信息` + `ChangePasswordSection`
- **CQU 账户** `/cqu`：`CquBindingSection`（含 `LiveCodeSection` 实时码）+ `QuickLoginSection`
- 拆完 `Settings.tsx` 消失。

## C. 仪表盘权益展示（纯前端，零取数）

数据来源：`authClient.useSession()` 的 `data.caps`（已在会话里，**不发任何新请求**）。

布局（卡片）：

- **账户摘要**：昵称 / 邮箱 / 角色徽章
- **我的权益**：按子系统（日历 / 评教）分组卡片
  - label/unit/type 来自 `CAPABILITIES`，事实值来自 `caps`
  - flag → 「已开通 / 未开通」徽章
  - quota → `50 条` / `360 分钟`；`null` → 「无限」
- **CQU 绑定快照**：复用 `GET /api/cqu/binding`，显示绑定 + 会话状态，「去管理」跳 `/cqu`

实现要点：

- caps → 展示数据的映射抽成**纯函数 `capsToView(caps)`**，便于单测。
- caps 类型：`useSession()` 的 `data` 由 `customSession` 追加了 `caps`，但 better-auth 类型未声明。提供一个轻量类型/helper（如 `useCaps()`）读取，避免散落的 `as any`。
- 旧会话无 `caps` 时优雅降级为「暂无权益」。

## D. 管理后台重做

### 拆巨石

`Admin.tsx`（1696 行）→ `pages/admin/` 目录：

- shell（顶部子 Tab：用户 / OAuth 客户端）
- `users/UsersSection.tsx` + `users/EntitlementPanel.tsx`
- `oauth/OAuthClientsSection.tsx` + `oauth/OAuthClientEditor.tsx` + `oauth/CredentialModal.tsx` + `oauth/DeleteConfirmModal.tsx`

### OAuth 编辑器

从「一面墙表单」改成**分区折叠**：基础（名称 / 回调 / 类型）→ 权限（scope + grant_types + CQU 服务勾选）→ 高级（logo/tos/pkce/metadata…）→ 密钥（仅编辑态）。不强制做成 wizard，保证改单个字段还是快。保留现有 create/edit/rotate/CQU-scopes 的全部逻辑与边界（含 `buildPayload` 省略空字段、CQU scope 合并、创建失败重试 PATCH 等）。

### 用户管理

- 加搜索框（按 name/email）+ 状态筛选 + 更清爽的表格
- 保留角色下拉 / 封禁 / 权益按钮
- **后端小改**：`GET /api/admin/users?search=` —— RESTful query filter（集合资源上的过滤参数，非动词端点），沿用现有分页模式。在 better-auth adapter `findMany` 的 `where` 上做 name/email 模糊匹配。

## E. 共享设计系统

把散落的 `Modal / Toggle / CopyButton / StringListInput / FieldLabel / Card / Badge` 收进 `components/ui/`，用户中心与后台**共用一套** —— 从根上消除「视觉不统一 / 稀泥感」。保持 Tailwind 现有语言（圆角卡、灰边）但系统化。

## 数据流

- 仪表盘 caps：`authClient.useSession()` → `data.caps`（customSession 已填，零新请求）。
- CQU 快照：现有 `GET /api/cqu/binding`。
- 管理用户搜索：`GET /api/admin/users?search=&page=&limit=`。

## 错误处理

复用现有模式：加载 spinner、错误横幅、`readErrorMessage`。caps 缺失（旧会话）→ 视为空，优雅显示「暂无权益」。

## 测试 / 验证

- 后端：给 `?search=` 加查询构造 / 过滤的单测（vitest，Node pool）。
- 前端无测试框架：靠 `npm run typecheck`（后端 root）+ `cd frontend && npx tsc --noEmit`（前端 root）+ `capsToView()` 纯函数单测 + Playwright 手动走查。不为此新建 FE 测试基建。

## 风险 / 待验证点

- `useSession()` 返回类型不含 `caps` —— 需自定义类型层，注意不要把 `customSession` 的契约写错（它**完全替换** get-session 响应体，返回 `{user, session, caps}`）。
- 拆 Settings / Admin 时，WebSocket 实时验证码（`LiveCodeSection`）的生命周期逻辑必须原样迁移，别在搬运中弄坏重连/ping 逻辑。
- OAuth 编辑器分区重构是改动面最大的一块，重构后须逐项回归 create/edit/rotate/CQU-scope/public-client 无 secret 等分支。
