# 用户中心 + 管理后台重构 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把用户侧重构成「用户中心」（仪表盘 + 安全设置 + CQU 账户），让用户能看到自己的权益/配额上限；并把管理后台从两个单文件巨石拆成模块、重做 OAuth 编辑器、给用户管理加搜索。

**Architecture:** 纯前端为主的重构。新建 `UserCenterLayout`（侧边栏外壳）+ `/dashboard /security /cqu` 三页（拆自 918 行 `Settings.tsx`）+ 仪表盘读会话里已有的 `caps`（零新请求）。管理后台 `Admin.tsx`（1696 行）拆进 `pages/admin/` 目录，OAuth 编辑器改分区折叠。唯一后端改动：`GET /api/admin/users` 加 `?search=`（透传 better-auth `listUsers` 的 searchValue/searchField/searchOperator）。

**Tech Stack:** React 19 + React Router 7 + Tailwind CSS 4（前端）；Hono + Better Auth + D1（后端）；vitest（Node pool，仅纯函数单测）。

**前置条件（Task 0）：** PR #5（firstparty-entitlements）已合并上生产；本计划在**从 `main` 新切的 `feat/user-center` 分支**上执行。

**测试策略说明：** 项目前端无组件测试框架，本计划**不新建** FE 测试基建（YAGNI）。TDD 只用于两个纯函数（`capsToView`、`pickSearchField`，vitest Node pool）。UI 重构的验证闸 = 两个 root 的 `tsc --noEmit` + Playwright/手动走查。每个任务结束即 commit。

参考技能：@superpowers:test-driven-development（纯函数任务）、@superpowers:executing-plans（执行）、frontend-design / impeccable（UI 打磨时可选）。

---

## Phase 1 — 共享 UI 原语

把散落在 `Admin.tsx` 里的复用原语抽到 `components/ui/`，让用户中心与后台共用一套，消除视觉不统一。

### Task 1.1：抽出 `components/ui/` 基础原语

**Files:**
- Create: `frontend/src/components/ui/index.ts`（统一 re-export）
- Create: `frontend/src/components/ui/Modal.tsx`
- Create: `frontend/src/components/ui/Toggle.tsx`
- Create: `frontend/src/components/ui/CopyButton.tsx`
- Create: `frontend/src/components/ui/StringListInput.tsx`
- Create: `frontend/src/components/ui/FieldLabel.tsx`
- Create: `frontend/src/components/ui/form.ts`（导出 `inputClass` 常量）
- Create: `frontend/src/components/ui/Card.tsx`（新：统一卡片容器）
- Create: `frontend/src/components/ui/Badge.tsx`（新：状态徽章 green/yellow/gray/red/blue）

**Step 1:** 从 `Admin.tsx` 原样剪切 `Modal`(L462-483)、`Toggle`(L401-436)、`CopyButton`(L439-459)、`StringListInput`(L343-398)、`FieldLabel`(L329-336)、`inputClass`(L338-339) 到上述各文件，逐个 `export`。代码不改逻辑，仅迁移。

**Step 2:** 新增 `Card`：

```tsx
// frontend/src/components/ui/Card.tsx
import type { ReactNode } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`bg-white rounded-2xl border border-gray-200 ${className}`}>{children}</div>
  );
}

export function CardHeader({ title, desc }: { title: string; desc?: string }) {
  return (
    <div className="px-6 pt-6 pb-2">
      <h3 className="text-base font-semibold text-gray-900">{title}</h3>
      {desc && <p className="mt-1 text-sm text-gray-500">{desc}</p>}
    </div>
  );
}
```

**Step 3:** 新增 `Badge`：

```tsx
// frontend/src/components/ui/Badge.tsx
type Variant = "green" | "yellow" | "gray" | "red" | "blue";
const MAP: Record<Variant, { pill: string; dot: string }> = {
  green:  { pill: "bg-green-100 text-green-700",  dot: "bg-green-500"  },
  yellow: { pill: "bg-yellow-100 text-yellow-700", dot: "bg-yellow-500" },
  gray:   { pill: "bg-gray-100 text-gray-500",    dot: "bg-gray-400"   },
  red:    { pill: "bg-red-100 text-red-700",      dot: "bg-red-500"    },
  blue:   { pill: "bg-blue-100 text-blue-700",    dot: "bg-blue-500"   },
};
export function Badge({ variant, children, dot = true }: { variant: Variant; children: React.ReactNode; dot?: boolean }) {
  const c = MAP[variant];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-0.5 rounded-full ${c.pill}`}>
      {dot && <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />}
      {children}
    </span>
  );
}
```

**Step 4:** `index.ts` re-export 全部。`Admin.tsx` 暂时改成从 `../components/ui` import 这些原语（删掉本地定义）。

**Step 5:** Run `cd frontend && npx tsc --noEmit` → Expected: PASS（无类型错误）。

**Step 6:** Commit
```bash
git add frontend/src/components/ui frontend/src/pages/Admin.tsx
git commit -m "refactor(ui): extract shared primitives into components/ui"
```

---

## Phase 2 — 用户中心外壳 + 路由

### Task 2.1：`UserCenterLayout`（侧边栏外壳）

**Files:**
- Create: `frontend/src/components/UserCenterLayout.tsx`

**Step 1:** 写组件。左侧边栏导航 + 右内容区；移动端（`md:` 以下）侧边栏折叠为顶部抽屉。导航项数据驱动；「管理控制台」入口用 `role === "admin" || role === "superAdmin"`（**修掉旧 Layout 漏放 superAdmin 的 bug**）。高亮用 `useLocation().pathname.startsWith(item.to)`。

```tsx
// frontend/src/components/UserCenterLayout.tsx
import { type ReactNode, useState } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { authClient } from "../lib/auth-client";

interface NavItem { to: string; label: string; adminOnly?: boolean }

const NAV: NavItem[] = [
  { to: "/dashboard", label: "概览" },
  { to: "/security", label: "安全设置" },
  { to: "/cqu", label: "CQU 账户" },
  { to: "/admin", label: "管理控制台", adminOnly: true },
];

export default function UserCenterLayout({ children }: { children: ReactNode }) {
  const { data: session } = authClient.useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [drawer, setDrawer] = useState(false);

  const user = session?.user as { role?: string; email?: string } | undefined;
  const isAdmin = user?.role === "admin" || user?.role === "superAdmin";
  const items = NAV.filter((i) => !i.adminOnly || isAdmin);

  const handleSignOut = async () => {
    await authClient.signOut();
    navigate("/login");
  };

  const NavLinks = () => (
    <nav className="flex flex-col gap-1">
      {items.map((item) => {
        const active = location.pathname.startsWith(item.to);
        const sep = item.adminOnly;
        return (
          <div key={item.to}>
            {sep && <div className="my-2 border-t border-gray-200" />}
            <Link
              to={item.to}
              onClick={() => setDrawer(false)}
              className={`block px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                active ? "bg-blue-50 text-blue-700" : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
              }`}
            >
              {item.label}
            </Link>
          </div>
        );
      })}
    </nav>
  );

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Top bar */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-30">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button className="md:hidden p-2 -ml-2 text-gray-500" onClick={() => setDrawer((v) => !v)} aria-label="菜单">
              ☰
            </button>
            <Link to="/dashboard" className="text-lg font-semibold text-blue-600">CQU Auth</Link>
          </div>
          <div className="flex items-center gap-4">
            <span className="hidden sm:inline text-sm text-gray-500">{user?.email}</span>
            <button onClick={handleSignOut} className="text-sm text-gray-600 hover:text-gray-900 font-medium">退出登录</button>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 flex gap-8">
        {/* Sidebar (desktop) */}
        <aside className="hidden md:block w-48 shrink-0">
          <div className="sticky top-24"><NavLinks /></div>
        </aside>
        {/* Drawer (mobile) */}
        {drawer && (
          <div className="md:hidden fixed inset-0 z-40" onClick={() => setDrawer(false)}>
            <div className="absolute inset-0 bg-black/30" />
            <div className="absolute left-0 top-16 bottom-0 w-60 bg-white border-r border-gray-200 p-4" onClick={(e) => e.stopPropagation()}>
              <NavLinks />
            </div>
          </div>
        )}
        <main className="flex-1 min-w-0">{children}</main>
      </div>
    </div>
  );
}
```

**Step 2:** Run `cd frontend && npx tsc --noEmit` → PASS.

**Step 3:** Commit
```bash
git add frontend/src/components/UserCenterLayout.tsx
git commit -m "feat(uc): add UserCenterLayout sidebar shell (fixes superAdmin nav gap)"
```

### Task 2.2：路由改造（App.tsx）

**Files:**
- Modify: `frontend/src/App.tsx`

**Step 1:** `RootRedirect` 目标从 `/settings` 改为 `/dashboard`。新增路由 `/dashboard`、`/security`、`/cqu`（均 `ProtectedRoute` 包裹）。`/settings` 改为 `<Navigate to="/security" replace />`。删除对 `Settings` 的引用（Phase 3 建好新页后再删旧文件）。占位：先临时让 `/dashboard /security /cqu` 渲染对应新页（Phase 3/4 创建）。

```tsx
// 关键片段
function RootRedirect() {
  const { data: session, isPending } = authClient.useSession();
  if (isPending) return <FullPageSpinner />;
  return <Navigate to={session ? "/dashboard" : "/login"} replace />;
}
// ...routes...
<Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
<Route path="/security" element={<ProtectedRoute><Security /></ProtectedRoute>} />
<Route path="/cqu" element={<ProtectedRoute><CquAccount /></ProtectedRoute>} />
<Route path="/settings" element={<Navigate to="/security" replace />} />
```

**Step 2:** 把 `RootRedirect` 里重复的 spinner 抽成 `FullPageSpinner`（`ProtectedRoute` 也用同一个 → DRY）。

**Step 3:** typecheck 会暂时因 `Dashboard/Security/CquAccount` 未建而失败 —— 该任务与 Phase 3/4 一起完成才 green。**本任务先 commit 到能编译的中间态**：用三个最小占位组件（`return <div>TODO</div>`）让 tsc 通过，后续 Phase 替换。

**Step 4:** Run `cd frontend && npx tsc --noEmit` → PASS（占位件在位）。

**Step 5:** Commit
```bash
git add frontend/src/App.tsx
git commit -m "feat(uc): wire /dashboard /security /cqu routes; / -> /dashboard"
```

---

## Phase 3 — 拆解 Settings.tsx → 安全设置 + CQU 账户

### Task 3.1：安全设置页

**Files:**
- Create: `frontend/src/pages/Security.tsx`
- Modify: `frontend/src/pages/Settings.tsx`（搬出后删）

**Step 1:** 新建 `Security.tsx`，用 `UserCenterLayout` 包裹，内含：
- 「个人信息」卡（从 `Settings.tsx` L892-904 迁移：昵称 / 邮箱）
- `ChangePasswordSection`（从 `Settings.tsx` L21-137 整段迁移，逻辑零改）
用 `Card`/`CardHeader` 替换内联卡片样式（视觉统一）。

**Step 2:** Run `cd frontend && npx tsc --noEmit` → PASS.

**Step 3:** Commit
```bash
git add frontend/src/pages/Security.tsx
git commit -m "feat(uc): add Security page (个人信息 + 修改密码)"
```

### Task 3.2：CQU 账户页

**Files:**
- Create: `frontend/src/pages/CquAccount.tsx`
- Modify/Delete: `frontend/src/pages/Settings.tsx`

**Step 1:** 新建 `CquAccount.tsx`，用 `UserCenterLayout` 包裹，迁移 `CquBindingSection`（含 `LiveCodeSection`、`CodeCountdown`、WS 逻辑 L186-879）+ `QuickLoginSection`（L551-662）。**WebSocket 重连/ping 生命周期逻辑必须逐行原样迁移**，不在搬运中改动（迁移后对照 diff 确认 `connect`/`onclose`/`useEffect` 清理逻辑未变）。`CopyButton` 改用 `components/ui` 版（删本地副本）。

**Step 2:** 删除 `frontend/src/pages/Settings.tsx`；从 `App.tsx` 移除 `Settings` import。

**Step 3:** Run `cd frontend && npx tsc --noEmit` → PASS.

**Step 4:** 手动/Playwright 走查：登录 → `/cqu` → 实时验证码面板展开能连上 WS、`/security` 改密码表单可提交、`/settings` 自动跳 `/security`。

**Step 5:** Commit
```bash
git add frontend/src/pages/CquAccount.tsx frontend/src/App.tsx
git rm frontend/src/pages/Settings.tsx
git commit -m "feat(uc): add CQU account page; dissolve 918-line Settings.tsx"
```

---

## Phase 4 — 仪表盘 + caps 展示（含纯函数 TDD）

### Task 4.1：caps 类型层 + `capsToView()` 纯函数（TDD）

**Files:**
- Create: `frontend/src/lib/caps.ts`
- Create: `frontend/src/lib/caps.test.ts`
- Test 运行环境：根目录 vitest（`npm run test`），需确认 vitest 扫描 `frontend/**`；若 `vitest.config.ts` 的 include 不覆盖前端，则在该测试文件顶部用相对 import，并把 include 临时扩展（见 Step 5 备选）。

**Step 1（写失败测试）:** `caps.ts` 导出 `capsToView(caps, subsystem)`，把会话 caps + `CAPABILITIES` 目录合成展示模型：每个能力 → `{ key, label, type, value, display }`。flag → `display` 为 `"已开通"|"未开通"`；quota → `null` 显示 `"无限"`，数字显示 `"<n> <unit>"`。

```ts
// frontend/src/lib/caps.test.ts
import { describe, it, expect } from "vitest";
import { capsToView } from "./caps";

describe("capsToView", () => {
  it("flag true -> 已开通", () => {
    const v = capsToView({ calendar: { sync: true } }, "calendar");
    expect(v.find((c) => c.key === "sync")?.display).toBe("已开通");
  });
  it("flag false/缺省 -> 未开通", () => {
    const v = capsToView({ calendar: {} }, "calendar");
    expect(v.find((c) => c.key === "sync")?.display).toBe("未开通");
  });
  it("quota number -> 值 + 单位", () => {
    const v = capsToView({ calendar: { sub_limit: 50 } }, "calendar");
    expect(v.find((c) => c.key === "sub_limit")?.display).toBe("50 条");
  });
  it("quota null/缺省 -> 无限", () => {
    const v = capsToView({ calendar: { sub_limit: null } }, "calendar");
    expect(v.find((c) => c.key === "sub_limit")?.display).toBe("无限");
  });
  it("caps 整体缺失 -> 全部安全降级（flag 未开通 / quota 无限）", () => {
    const v = capsToView(undefined, "calendar");
    expect(v.every((c) => c.display === "未开通" || c.display === "无限")).toBe(true);
  });
});
```

**Step 2（跑测试看失败）:** Run `npm run test -- caps` → Expected: FAIL（`capsToView` 未定义）。

**Step 3（最小实现）:**

```ts
// frontend/src/lib/caps.ts
import { CAPABILITIES, isFlag, type CapDef, type Subsystem } from "../../../src/capabilities";

export type Caps = Record<string, Record<string, boolean | number | null>>;
export interface CapView { key: string; label: string; type: CapDef["type"]; value: boolean | number | null; display: string }

export function capsToView(caps: Caps | undefined, subsystem: Subsystem): CapView[] {
  const defs = CAPABILITIES[subsystem] as Record<string, CapDef>;
  const sub = caps?.[subsystem] ?? {};
  return Object.entries(defs).map(([key, def]) => {
    const value = sub[key] ?? (isFlag(def) ? false : null);
    const display = isFlag(def)
      ? (value ? "已开通" : "未开通")
      : (value == null ? "无限" : `${value}${def.unit ? " " + def.unit : ""}`);
    return { key, label: def.label, type: def.type, value, display };
  });
}
```

**Step 4（跑测试看通过）:** Run `npm run test -- caps` → Expected: PASS（5 个用例全绿）。

**Step 5:** 若 vitest 未扫描到前端测试：在 `vitest.config.ts` 的 `test.include` 增加 `"frontend/src/**/*.test.ts"`（仅纯函数测试，不引入浏览器环境）。确认 `npm run test` 全绿。

**Step 6:** Commit
```bash
git add frontend/src/lib/caps.ts frontend/src/lib/caps.test.ts vitest.config.ts
git commit -m "feat(uc): capsToView() pure mapping with unit tests"
```

### Task 4.2：`useCaps()` 会话 caps 读取 helper

**Files:**
- Modify: `frontend/src/lib/caps.ts`（追加 hook）

**Step 1:** 追加一个轻量 hook，封装「`useSession()` 的 data 上有 customSession 追加的 `caps`，但 better-auth 类型未声明」这一事实，集中一处 `as`，避免到处散落：

```ts
import { authClient } from "./auth-client";
export function useCaps(): Caps | undefined {
  const { data } = authClient.useSession();
  return (data as { caps?: Caps } | null | undefined)?.caps;
}
```

**Step 2:** typecheck PASS。Commit
```bash
git add frontend/src/lib/caps.ts
git commit -m "feat(uc): useCaps() session caps accessor"
```

### Task 4.3：仪表盘页

**Files:**
- Create: `frontend/src/pages/Dashboard.tsx`
- Modify: `frontend/src/App.tsx`（替换占位件）

**Step 1:** 写 `Dashboard.tsx`，`UserCenterLayout` 包裹，三块：
- **账户摘要卡**：昵称/邮箱/角色徽章（`useSession()` 拿 user）
- **我的权益卡**：遍历 `["calendar","eval"]`，每个子系统一张子卡；用 `useCaps()` + `capsToView(caps, sub)` 渲染能力列表；flag 用 `Badge`（green=已开通 / gray=未开通），quota 显示 `display` 文本。子系统中文名用本地 `SUBSYSTEM_LABELS`（日历/评教）。
- **CQU 绑定快照卡**：`GET /api/cqu/binding` 拉一次，显示 `bindStatus` + 会话状态徽章 + 「去管理」`<Link to="/cqu">`。绑定状态映射复用与 `CquAccount` 相同的徽章语义。

权益为空（caps 全 false/null 或 undefined）时，仍展示能力清单（全为「未开通/无限」），并在卡顶加一句「如需开通更多能力请联系管理员」。

**Step 2:** typecheck PASS。

**Step 3:** Playwright/手动走查：登录后落 `/dashboard`，权益卡数值与该账户在 admin 权益面板里的设置一致；CQU 快照与 `/cqu` 一致。

**Step 4:** Commit
```bash
git add frontend/src/pages/Dashboard.tsx frontend/src/App.tsx
git commit -m "feat(uc): dashboard with entitlements/quota overview + CQU snapshot"
```

---

## Phase 5 — 拆解 Admin.tsx 巨石

### Task 5.1：建目录骨架 + 主壳

**Files:**
- Create: `frontend/src/pages/admin/Admin.tsx`（主壳：子 Tab 用户/OAuth + `UserCenterLayout` 包裹）
- Create: `frontend/src/pages/admin/types.ts`（`User`/`EntitlementRow`/`ClientConfig`/`ClientPayload`/`EditorState` 等接口集中）
- Create: `frontend/src/pages/admin/constants.ts`（`ALL_CQU_SCOPES`/`GRANT_TYPE_OPTIONS`/`CLIENT_TYPE_OPTIONS`/`AUTH_METHOD_OPTIONS`/`ROLE_OPTIONS`/`SUBSYSTEM_LABELS`/`readErrorMessage`）
- Modify: `frontend/src/App.tsx`（`/admin` 指向新 `pages/admin/Admin.tsx`）

**Step 1:** 从旧 `Admin.tsx` 把类型 → `types.ts`，常量与 `readErrorMessage` → `constants.ts`。主壳 `Admin.tsx` 保留 `export default function Admin()`（顶部标题 + Tab 切换 + `UserCenterLayout`），渲染 `<UsersSection/>` / `<OAuthClientsSection/>`（下个任务建）。

**Step 2:** typecheck（此时引用未建的 section 会失败 → 与 5.2/5.3 一起 green；先用占位）。占位让 tsc PASS 后 commit。

**Step 3:** Commit
```bash
git add frontend/src/pages/admin
git commit -m "refactor(admin): scaffold pages/admin module (shell + types + constants)"
```

### Task 5.2：用户管理 section + 权益面板

**Files:**
- Create: `frontend/src/pages/admin/users/UsersSection.tsx`（迁移旧 L145-324）
- Create: `frontend/src/pages/admin/users/EntitlementPanel.tsx`（迁移旧 L485-785，含 `formFromRows`/`buildItems`/预设套用）

**Step 1:** 整段迁移，逻辑零改；原语改 import 自 `components/ui`。`EntitlementPanel` 仍走 `GET/PUT /api/admin/users/:id/entitlements` 与 `POST .../preset`，superAdmin 403 文案保留。

**Step 2:** typecheck PASS。

**Step 3:** Commit
```bash
git add frontend/src/pages/admin/users
git commit -m "refactor(admin): extract UsersSection + EntitlementPanel"
```

### Task 5.3：OAuth section + 子模态（先平迁，不改 UX）

**Files:**
- Create: `frontend/src/pages/admin/oauth/OAuthClientsSection.tsx`（迁移旧 L1506-1655）
- Create: `frontend/src/pages/admin/oauth/OAuthClientEditor.tsx`（迁移旧 L969-1503，**本任务先原样平迁**）
- Create: `frontend/src/pages/admin/oauth/CredentialModal.tsx`（旧 L788-840）
- Create: `frontend/src/pages/admin/oauth/DeleteConfirmModal.tsx`（旧 L843-881）
- Create: `frontend/src/pages/admin/oauth/payload.ts`（`emptyEditorState`/`stateFromClient`/`cleanList`/`buildPayload` 抽成纯逻辑，便于后续单测与复用）
- Delete: 旧 `frontend/src/pages/Admin.tsx`

**Step 1:** 平迁所有 OAuth 相关组件到 `oauth/`；删除旧 `pages/Admin.tsx`；确认 `App.tsx` 已指向 `pages/admin/Admin.tsx`。

**Step 2:** Run `cd frontend && npx tsc --noEmit` → PASS（整个 admin 拆分完成、可编译）。

**Step 3:** Playwright/手动回归：用户列表/封禁/角色/权益面板、OAuth 列表/新建/编辑/删除/轮换密钥 全部可用（与重构前行为一致）。

**Step 4:** Commit
```bash
git add frontend/src/pages/admin/oauth frontend/src/pages/admin/Admin.tsx
git rm frontend/src/pages/Admin.tsx
git commit -m "refactor(admin): split OAuth section/editor/modals; remove 1696-line monolith"
```

---

## Phase 6 — OAuth 编辑器分区重做

### Task 6.1：编辑器改分区折叠

**Files:**
- Modify: `frontend/src/pages/admin/oauth/OAuthClientEditor.tsx`

**Step 1:** 把「一面墙表单」重组为分区（用 `components/ui` 的折叠/卡片）：
- **基础**：名称、回调 URI、客户端类型（默认展开）
- **权限**：scope、grant_types、CQU 服务勾选（默认展开）
- **高级**：client_uri/logo/tos/policy/contacts/post_logout/pkce/auth_method/response_types/metadata（默认折叠，复用现有 `showAdvanced`）
- **密钥**：仅编辑态，轮换按钮
保留**全部现有逻辑**：`buildPayload` 省略空字段、CQU scope 合并进 scope、创建失败后 `createdId` 重试改 PATCH、public client 无 secret 不弹凭证框、PATCH 切换 confidential 返回新 secret 的处理。**仅改布局与分区，不改提交语义。**

**Step 2:** typecheck PASS。

**Step 3:** Playwright/手动逐分支回归（与 5.3 同清单 + 重点验：勾 CQU 服务 → scope 自动并入；改 public→confidential 弹新 secret）。

**Step 4:** Commit
```bash
git add frontend/src/pages/admin/oauth/OAuthClientEditor.tsx
git commit -m "feat(admin): sectioned OAuth client editor (基础/权限/高级/密钥)"
```

---

## Phase 7 — 用户管理搜索（后端纯函数 TDD + 端点 + 前端）

### Task 7.1：`pickSearchField()` 纯函数（TDD）

**Files:**
- Create: `src/services/admin-search.ts`
- Create: `src/services/admin-search.test.ts`

**Step 1（写失败测试）:** `listUsers` 一次只能搜一个字段，故按启发式选字段：值含 `@` → 搜 `email`，否则搜 `name`；空白返回 `null`（不带 search 参数）。

```ts
// src/services/admin-search.test.ts
import { describe, it, expect } from "vitest";
import { pickSearchField } from "./admin-search";

describe("pickSearchField", () => {
  it("含 @ -> email", () => expect(pickSearchField("a@b.com")).toEqual({ searchField: "email", searchValue: "a@b.com", searchOperator: "contains" }));
  it("无 @ -> name", () => expect(pickSearchField("张三")).toEqual({ searchField: "name", searchValue: "张三", searchOperator: "contains" }));
  it("首尾空白被 trim", () => expect(pickSearchField("  bob ")?.searchValue).toBe("bob"));
  it("空/纯空白 -> null", () => { expect(pickSearchField("")).toBeNull(); expect(pickSearchField("   ")).toBeNull(); });
});
```

**Step 2（跑测试看失败）:** Run `npm run test -- admin-search` → FAIL.

**Step 3（最小实现）:**

```ts
// src/services/admin-search.ts
export interface UserSearchQuery {
  searchField: "email" | "name";
  searchValue: string;
  searchOperator: "contains";
}
export function pickSearchField(raw: string | undefined | null): UserSearchQuery | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  return { searchField: v.includes("@") ? "email" : "name", searchValue: v, searchOperator: "contains" };
}
```

**Step 4（跑测试看通过）:** Run `npm run test -- admin-search` → PASS.

**Step 5:** Commit
```bash
git add src/services/admin-search.ts src/services/admin-search.test.ts
git commit -m "feat(admin): pickSearchField() heuristic with unit tests"
```

### Task 7.2：`GET /api/admin/users?search=` 端点接线

**Files:**
- Modify: `src/routes/admin.ts:224-244`

**Step 1:** 读 `search` query，经 `pickSearchField` 透传给 `listUsers`：

```ts
import { pickSearchField } from "../services/admin-search";
// ...
admin.get("/users", async (c) => {
  const auth = createAuth(c.env, c.req.raw);
  const page = Math.max(1, parseInt(c.req.query("page") ?? "1"));
  const limit = Math.min(Math.max(1, parseInt(c.req.query("limit") ?? "20")), 100);
  const search = pickSearchField(c.req.query("search"));

  const result = await auth.api.listUsers({
    headers: c.req.raw.headers,
    query: { limit, offset: (page - 1) * limit, ...(search ?? {}) },
  });

  return c.json({
    data: result.users,
    pagination: { page, limit, total: result.total, totalPages: Math.max(1, Math.ceil(result.total / limit)) },
  });
});
```

（`total` 是 better-auth「搜索/过滤后的总数」，分页数学不变。）

**Step 2:** Run `npm run typecheck` → PASS. Run `npm run test` → 全绿。

**Step 3:** Commit
```bash
git add src/routes/admin.ts
git commit -m "feat(admin): GET /api/admin/users?search= (RESTful query filter)"
```

### Task 7.3：前端搜索框 + 状态筛选

**Files:**
- Modify: `frontend/src/pages/admin/users/UsersSection.tsx`

**Step 1:** 列表上方加：搜索输入框（debounce 300ms，回 page=1，`fetchUsers(1, search)`，URL 带 `&search=`）+ 状态筛选（全部/正常/已封禁，客户端过滤当前页即可，标注其仅过滤本页）。搜索 fetch 拼 `?page=&limit=&search=`。空搜索词不带 `search`。保留分页。

**Step 2:** typecheck PASS。

**Step 3:** Playwright/手动：输入邮箱片段 → 命中邮箱；输入姓名片段 → 命中姓名；翻页与搜索叠加正确。

**Step 4:** Commit
```bash
git add frontend/src/pages/admin/users/UsersSection.tsx
git commit -m "feat(admin): user search box + status filter"
```

---

## Phase 8 — 收尾验证

### Task 8.1：全量验证 + CLAUDE.md 同步

**Files:**
- Modify: `CLAUDE.md`（前端 SPA 结构段：补「用户中心」路由/页面、`components/ui`、`pages/admin/` 拆分、`/api/admin/users?search=`）

**Step 1:** Run `npm run typecheck`（后端）→ PASS。
**Step 2:** Run `cd frontend && npx tsc --noEmit`（前端）→ PASS。
**Step 3:** Run `npm run test` → 全绿（含 `caps`、`admin-search`）。
**Step 4:** Playwright 端到端走查清单：
- 未登录访问 `/` → `/login`；登录 → `/dashboard`
- 侧边栏：普通用户无「管理控制台」；admin **和 superAdmin** 都能看到
- `/dashboard` 权益数值 == admin 权益面板设置值；CQU 快照正确
- `/security` 改密码；`/cqu` 绑定状态 + 实时验证码 WS;`/settings` → `/security`
- 管理后台：用户搜索/封禁/角色/权益面板；OAuth 新建/编辑（分区）/删除/轮换/CQU scope
**Step 5:** 更新 CLAUDE.md 前端段落。
**Step 6:** Commit
```bash
git add CLAUDE.md
git commit -m "docs: sync CLAUDE.md with user-center + admin refactor"
```

### Task 8.2：完成分支

参考 @superpowers:finishing-a-development-branch：跑完验证后，开 PR `feat/user-center` → main（标题/描述含本计划摘要 + 走查结论）。

---

## 附：执行顺序与依赖

- Phase 1 → 2 → 3/4（3、4 可并行）→ 5 → 6 → 7 → 8。
- 6 依赖 5.3（编辑器已迁出）；7.3 依赖 5.2（UsersSection 已迁出）。
- 每个 Phase 自带可编译中间态 + commit，便于按 @superpowers:executing-plans 逐任务 review。
