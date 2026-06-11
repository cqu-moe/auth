# OAuth 客户端管理 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 admin 后台为 superAdmin/admin 提供完整 OAuth 客户端管理（列表 / 新建 / 编辑配置 / 轮换密钥 / 删除），替代当前只能分配 CQU scope 的受限界面。

**Architecture:** 浏览器 → `src/routes/admin.ts` 新路由（过 admin 中间件）→ 服务端 `auth.api.adminCreateOAuthClient`/`adminUpdateOAuthClient`（SERVER_ONLY）做 create/update；delete/rotate 没有 admin 版插件端点，在 admin 层直接走 Better Auth adapter。secret 哈希存储（SHA-256 + base64url 无填充），创建/轮换时明文仅返回一次。

**Tech Stack:** Hono + Better Auth（`@better-auth/oauth-provider` + admin 插件）+ Drizzle/D1；前端 React 19 + Tailwind 4；`@better-auth/utils`（`createHash` / `base64Url`）；vitest。

**设计文档：** `docs/plans/2026-05-30-oauth-client-management-design.md`

---

## 关键事实（已核实，勿重复踩坑）

- `adminCreateOAuthClient` / `adminUpdateOAuthClient` 是 `SERVER_ONLY` → 只能 `auth.api.*` 调，body 用 snake_case。
- create 返回 `{ client_id, client_secret, client_secret_expires_at, scope }`，**secret 仅此一次**。
- 项目 secret 存储 = `"hashed"`（启用 jwt 插件）；插件 `defaultHasher` =
  `base64Url.encode(SHA-256(secret), { padding: false })`。admin 层 rotate 必须**精确复刻**此哈希。
- `deleteClientEndpoint`/`rotateClientSecretEndpoint` 有 owner 硬校验，admin 用不了 → 走 adapter。
- adapter 模型名 `oauthClient`，字段 `clientId`（公开）、`clientSecret`、`name`、`redirectUris`、`type` 等。
- `oauth_client_cqu_scopes.clientId` 按公开 `client_id` 关联（与 scope 中间件对齐）。删除客户端要级联删该表。

---

## Task 1: 密钥哈希/生成工具 + 单测

**Files:**
- Create: `src/utils/oauth-secret.ts`
- Test: `src/utils/oauth-secret.test.ts`
- Create: `vitest.config.ts`（若不存在）

**Step 1: 写失败测试** — `src/utils/oauth-secret.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { hashOAuthClientSecret, generateOAuthClientSecret } from "./oauth-secret";

describe("hashOAuthClientSecret", () => {
  it("matches SHA-256 + base64url(no padding) spec (= plugin defaultHasher)", async () => {
    // 独立用 Web Crypto 复算，证明与插件 defaultHasher 同规格
    const secret = "test-secret-123";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
    const b64 = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(await hashOAuthClientSecret(secret)).toBe(b64);
  });
});

describe("generateOAuthClientSecret", () => {
  it("returns a 32-char url-safe random string, unique per call", () => {
    const a = generateOAuthClientSecret();
    const b = generateOAuthClientSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(a).not.toBe(b);
  });
});
```

**Step 2: 跑测试确认失败**

Run: `npx vitest run src/utils/oauth-secret.test.ts`
Expected: FAIL（模块不存在）。若报缺 `vitest.config.ts`，先建最小配置：

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["src/**/*.test.ts"] } });
```

**Step 3: 实现** — `src/utils/oauth-secret.ts`

```ts
import { createHash } from "@better-auth/utils/hash";
import { base64Url } from "@better-auth/utils/base64";

// 复刻 @better-auth/oauth-provider 的 defaultHasher：SHA-256 → base64url（无填充）。
// 项目以 "hashed" 模式存 client secret（启用了 jwt 插件），admin 层轮换必须产出
// 与插件 validateClientCredentials 期望一致的哈希，否则新密钥无法通过校验。
export async function hashOAuthClientSecret(secret: string): Promise<string> {
  const hash = await createHash("SHA-256").digest(new TextEncoder().encode(secret));
  return base64Url.encode(new Uint8Array(hash), { padding: false });
}

// 生成 32 字符 URL-safe 随机 secret（明文仅在创建/轮换时返回一次）。
export function generateOAuthClientSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return base64Url.encode(bytes, { padding: false }).slice(0, 32);
}
```

**Step 4: 跑测试确认通过**

Run: `npx vitest run src/utils/oauth-secret.test.ts`
Expected: PASS（2 passed）

**Step 5: Commit**

```bash
git add src/utils/oauth-secret.ts src/utils/oauth-secret.test.ts vitest.config.ts
git commit -m "feat: add OAuth client secret hash/generate util with test"
```

---

## Task 2: 后端 — 错误处理小工具

**Files:**
- Modify: `src/routes/admin.ts`（顶部导入 + 新增 helper）

**Step 1: 实现** — 在 `admin.ts` 顶部加导入与 helper（把插件 `APIError` 转规范 JSON，消灭"异常冒泡成 500"隐患）

```ts
import { APIError } from "better-auth/api";
import { hashOAuthClientSecret, generateOAuthClientSecret } from "../utils/oauth-secret";

function oauthClientError(c: Context<HonoEnv>, e: unknown) {
  if (e instanceof APIError) {
    const msg = (e.body as { error_description?: string; message?: string })?.error_description
      ?? (e.body as { message?: string })?.message ?? "OAuth 客户端操作失败";
    const status = typeof e.status === "number" ? e.status : 400;
    return errorResponse(c, "OAUTH_CLIENT_ERROR", msg, status as ContentfulStatusCode);
  }
  return errorResponse(c, "INTERNAL_ERROR", "服务器内部错误", 500);
}
```

> 注：`Context`/`ContentfulStatusCode` 类型按 admin.ts 现有导入风格补齐；若 `errorResponse` 签名不接受动态 status，执行时对齐其实际签名。

**Step 2: typecheck**

Run: `npm run typecheck`
Expected: 无错误

**Step 3: Commit**

```bash
git add src/routes/admin.ts
git commit -m "feat: add oauth client APIError->JSON helper"
```

---

## Task 3: 后端 — POST /oauth-clients（创建）

**Files:**
- Modify: `src/routes/admin.ts`（在 `GET /oauth-clients` 之后插入）

**Step 1: 实现**

```ts
// POST /api/admin/oauth-clients - Create an OAuth client (returns secret once)
admin.post("/oauth-clients", async (c) => {
  const auth = createAuth(c.env, c.req.raw);
  const body = await c.req.json();
  try {
    const result = await auth.api.adminCreateOAuthClient({
      headers: c.req.raw.headers,
      body, // { redirect_uris (required), client_name?, scope?, grant_types?, type?, skip_consent?, ... }
    });
    return c.json({ data: result });
  } catch (e) {
    return oauthClientError(c, e);
  }
});
```

**Step 2: typecheck**

Run: `npm run typecheck`
Expected: 无错误（若 `auth.api.adminCreateOAuthClient` 类型不存在，确认 oauth-provider 版本导出名）

**Step 3: 手动验证**（执行阶段，需本地 `.dev.vars` + 已登录 superAdmin 会话）

```bash
npm run dev   # :8787
# 带 superAdmin cookie：
curl -s -X POST localhost:8787/api/admin/oauth-clients \
  -H 'Content-Type: application/json' -b "$COOKIE" \
  -d '{"client_name":"Test App","redirect_uris":["https://example.com/cb"]}' | jq
```
Expected: 返回 `{ data: { client_id, client_secret, ... } }`

**Step 4: Commit**

```bash
git add src/routes/admin.ts
git commit -m "feat: add POST /admin/oauth-clients create endpoint"
```

---

## Task 4: 后端 — PATCH /oauth-clients/:id（编辑）

**Files:** Modify: `src/routes/admin.ts`

**Step 1: 实现**

```ts
// PATCH /api/admin/oauth-clients/:id - Update an OAuth client's config
admin.patch("/oauth-clients/:id", async (c) => {
  const auth = createAuth(c.env, c.req.raw);
  const clientId = c.req.param("id");
  const update = await c.req.json();
  try {
    const result = await auth.api.adminUpdateOAuthClient({
      headers: c.req.raw.headers,
      body: { client_id: clientId, update },
    });
    return c.json({ data: result });
  } catch (e) {
    return oauthClientError(c, e);
  }
});
```

**Step 2: typecheck** → `npm run typecheck` → 无错误

**Step 3: 手动验证** — curl PATCH 改 `client_name`，确认返回更新后字段

**Step 4: Commit** — `feat: add PATCH /admin/oauth-clients/:id update endpoint`

---

## Task 5: 后端 — POST /oauth-clients/:id/rotate-secret（轮换）

**Files:** Modify: `src/routes/admin.ts`

**Step 1: 实现**

```ts
// POST /api/admin/oauth-clients/:id/rotate-secret - Rotate client secret (returns new secret once)
admin.post("/oauth-clients/:id/rotate-secret", async (c) => {
  const auth = createAuth(c.env, c.req.raw);
  const clientId = c.req.param("id");
  const ctx = await auth.$context;
  const secret = generateOAuthClientSecret();
  const hashed = await hashOAuthClientSecret(secret);
  const updated = await ctx.adapter.update({
    model: "oauthClient",
    where: [{ field: "clientId", value: clientId }],
    update: { clientSecret: hashed },
  });
  if (!updated) return errorResponse(c, "NOT_FOUND", "客户端不存在", 404);
  return c.json({ data: { client_id: clientId, client_secret: secret } });
});
```

**Step 2: typecheck** → 无错误

**Step 3: 关键 round-trip 验证**（证明哈希复刻正确）：rotate 后用新 secret 走 client_credentials/token 端点或 introspection，确认通过校验。执行阶段用 curl：

```bash
# rotate
NEW=$(curl -s -X POST localhost:8787/api/admin/oauth-clients/$CID/rotate-secret -b "$COOKIE" | jq -r .data.client_secret)
# 用新 secret 换 token（依据 docs/oauth-integration-guide.md 的 token 流程）
curl -s -X POST localhost:8787/api/auth/oauth2/token \
  -H "Authorization: Basic $(echo -n "$CID:$NEW" | base64)" \
  -d 'grant_type=client_credentials' | jq
```
Expected: 不报 invalid_client（哈希与插件一致）

**Step 4: Commit** — `feat: add admin oauth client secret rotation`

---

## Task 6: 后端 — DELETE /oauth-clients/:id（删除 + 级联 scope）

**Files:** Modify: `src/routes/admin.ts`

**Step 1: 实现**

```ts
// DELETE /api/admin/oauth-clients/:id - Delete a client + cascade its CQU scopes
admin.delete("/oauth-clients/:id", async (c) => {
  const auth = createAuth(c.env, c.req.raw);
  const clientId = c.req.param("id");
  const ctx = await auth.$context;
  await ctx.adapter.delete({
    model: "oauthClient",
    where: [{ field: "clientId", value: clientId }],
  });
  const db = drizzle(c.env.DATABASE);
  await db.delete(oauthClientCquScopes).where(eq(oauthClientCquScopes.clientId, clientId));
  return c.json({ success: true });
});
```

**Step 2: typecheck** → 无错误

**Step 3: 手动验证** — DELETE 后 `GET /oauth-clients` 不再含该 client，scope 表对应行清空

**Step 4: Commit** — `feat: add DELETE /admin/oauth-clients/:id with scope cascade`

---

## Task 7: 前端 — 类型 + API 封装

**Files:** Modify: `frontend/src/pages/Admin.tsx`

**Step 1:** 扩展 `OAuthClient` 类型（加 `redirectUris`/`type`/`grantTypes`/`scope`/`skipConsent` 等可选字段），新增请求函数：`createClient`、`updateClient`、`rotateSecret`、`deleteClient`（fetch 对应路由，统一处理 `res.ok` 与错误）。

**Step 2:** `npm --prefix frontend run`… → `cd frontend && npx tsc --noEmit` → 无错误

**Step 3: Commit** — `feat(ui): add oauth client api wrappers and types`

---

## Task 8: 前端 — 编辑器抽屉（精简区 + 完整配置展开）

**Files:** Modify: `frontend/src/pages/Admin.tsx`（新增 `ClientEditor` 组件）

**Step 1:** 实现抽屉/弹窗：
- 精简区：`client_name`、`redirect_uris`（多条增删）、`scope`、`grant_types`（多选）、`type`（web/native/user-agent-based）、`skip_consent`。
- 「展开完整配置」折叠区：`client_uri`/`logo_uri`/`tos_uri`/`policy_uri`/`contacts`/`require_pkce`/`token_endpoint_auth_method`/`post_logout_redirect_uris`/`metadata`。
- 提交：create 模式 → `createClient`；edit 模式 → `updateClient`。

**Step 2:** `cd frontend && npx tsc --noEmit` → 无错误

**Step 3: Commit** — `feat(ui): oauth client editor with progressive config disclosure`

---

## Task 9: 前端 — CQU scope 区收编进编辑器

**Files:** Modify: `frontend/src/pages/Admin.tsx`

**Step 1:** 把现有 `ALL_CQU_SCOPES` 勾选框移入 `ClientEditor` 的「CQU 服务权限」区，edit 模式打开时 `GET .../scopes` 回填，保存时 `PUT .../scopes`。移除旧的独立 per-card scope 面板。

**Step 2:** typecheck → 无错误

**Step 3: Commit** — `refactor(ui): fold CQU scope assignment into client editor`

---

## Task 10: 前端 — 密钥展示 + 轮换 + 删除确认

**Files:** Modify: `frontend/src/pages/Admin.tsx`

**Step 1:**
- 创建成功 → 弹层展示 `client_id` + `client_secret`（复制按钮 + "仅显示一次"警示）。
- 编辑区密钥块：不回显，「重新生成密钥」→ `rotateSecret` → 同款一次性弹层展示新 secret。
- 删除：二次确认弹窗 → `deleteClient` → 刷新列表。

**Step 2:** typecheck → 无错误

**Step 3: Commit** — `feat(ui): secret reveal, rotation and delete confirmation`

---

## Task 11: 收尾验证 + CLAUDE.md/文档

**Step 1:** 全量 typecheck：`npm run typecheck` + `cd frontend && npx tsc --noEmit`
**Step 2:** 跑单测：`npm run test`（至少 Task 1 的哈希单测通过）
**Step 3:** `npm run dev` 本地手动走通：列表 → 新建（拿 secret）→ 编辑 → 轮换（新 secret 可换 token）→ 配 CQU scope → 删除。
**Step 4:** 更新 `CLAUDE.md` Gotchas：补「Better Auth 自定义 access control 必须 spread defaultStatements」「admin 层 rotate 需复刻 defaultHasher」两条。
**Step 5: Commit + push** — `feat: OAuth client management in admin console` / 文档单独 commit。

---

## 风险与回退

- **哈希不匹配** → 轮换后新 secret 失效。Task 1 单测 + Task 5 round-trip 双保险；若插件升级改了 `defaultHasher`，单测会先红。
- **SERVER_ONLY 端点类型缺失** → 确认 `@better-auth/oauth-provider` 版本的 `auth.api` 导出名（`adminCreateOAuthClient`/`adminUpdateOAuthClient`）。
- 所有改动限定在 `src/routes/admin.ts`、`src/utils/oauth-secret.ts`、`frontend/src/pages/Admin.tsx`、`vitest.config.ts`；**不触碰** `cqu-session.ts`/`scope.ts`/`cqu-sso.ts` 等他人 WIP。
