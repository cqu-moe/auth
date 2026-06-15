# 第一方一体化 + 分级权益 实现计划

> **For Claude:** REQUIRED SUB-SKILL: 用 superpowers:executing-plans 逐任务实现。每个任务先写失败测试(@superpowers:test-driven-development),再最小实现,跑测试,提交。
> 设计依据:`docs/plans/2026-06-14-firstparty-entitlements-design.md`。接入契约:`docs/subsystem-integration-guide.md`。

**Goal:** 把子系统从"第三方 OAuth 客户端"改造为第一方原生一体(分拓扑),用户权限改为中心按用户授予的能力(entitlements,含数字配额),并为浏览器插件加 ST 跳转快捷登录——CQU 取票维持按子系统最小权限。

**Architecture:** 新增一条正交的 `用户 × 子系统 × 能力` 轴(`user_entitlement` 表 + TS 常量目录),与现有 per-client 取票安全解耦。第一方按拓扑分道:同账户 Worker 走共享 cookie + Service Binding RPC;其余走 OAuth+PKCE+JWT。插件取票走严格校验的 `serviceUrl` 接口,只发单服务一次性 ST,不导出 TGT。

**Tech Stack:** Cloudflare Workers (Hono) · D1 + Drizzle · Better Auth (`@better-auth/oauth-provider` + `jwt` + `admin`) · Durable Objects · React SPA · Vitest。

---

## 关键纪律(执行前必读)

- **TDD**:可单测的单元(URL 校验、caps 解析、entitlement CRUD)严格先写失败测试。配置类改动(cookie SSO、RPC 接线)给手动验证步骤。
- **D1 迁移坑**:**App 自有表(如 `user_entitlement`)用 `npm run db:generate` 从 schema.ts 生成**;只有 **Better Auth 自有表**(user/session/oauthClient…)才手写 SQL(CLI 不支持函数式 `createAuth`)。App 表走 `drizzle-orm/d1`;Better Auth 表走 `(await auth.$context).adapter.*`。
- **测试 pool**:vitest 现为裸 Node pool。纯逻辑(URL 校验、caps 解析、entitlement CRUD)留 Node pool;**DO/RPC 集成测试**(C2、D 的 DO 行为)需 `@cloudflare/vitest-pool-workers` 另起 suite,或标记手动验证——别在 Node pool 里 mock DO 假装集成。
- **不动取票语义**:Phase A/B **不改**任何取票行为(纯加数据 + 下发 caps)。取票改动集中在 Phase D。
- **部署**:push main 即生产部署。开发期在 worktree / 分支推进;`npm run typecheck` + `cd frontend && npx tsc --noEmit` + `npm run test` 必过再合。
- **安全红线**:Phase D 的 URL 校验 + DO 万能闸是全局最敏感处,绕过向量测试一个都不能少;`cqu.quicklogin` opt-in + host 校验 + 限流 + 审计**都必须在 DO 内**(route/RPC/cookie 三入口唯一汇合点)。

---

## Phase A — Entitlements 数据层(不改取票行为)

### Task A1: 能力目录 + 预设常量

**Files:**
- Create: `src/capabilities.ts`
- Test: `test/capabilities.test.ts`

**Step 1: 写失败测试**

```ts
// test/capabilities.test.ts
import { describe, it, expect } from "vitest";
import { CAPABILITIES, PRESETS, isQuota, isFlag } from "../src/capabilities";

describe("capabilities catalog", () => {
  it("declares calendar.sync as a flag and sync_limit as a quota", () => {
    expect(isFlag(CAPABILITIES.calendar.sync)).toBe(true);
    expect(isQuota(CAPABILITIES.calendar.sync_limit)).toBe(true);
  });
  it("has cqu.quicklogin opt-in flag for the extension", () => {
    expect(isFlag(CAPABILITIES.cqu.quicklogin)).toBe(true);
  });
  it("presets only reference real catalog keys", () => {
    for (const preset of Object.values(PRESETS)) {
      for (const [sub, caps] of Object.entries(preset)) {
        for (const key of Object.keys(caps)) {
          expect((CAPABILITIES as any)[sub]?.[key]).toBeDefined();
        }
      }
    }
  });
});
```

**Step 2: 跑测试确认失败** — `npm run test -- capabilities` → FAIL(模块不存在)。

**Step 3: 实现**

```ts
// src/capabilities.ts
export type CapType = "flag" | "quota";
export interface CapDef { type: CapType; label: string; unit?: string; }

// 唯一权威:系统里存在哪些能力。新增能力在此加 + 重部署。
export const CAPABILITIES = {
  calendar: {
    sync:       { type: "flag",  label: "日历同步" },
    sync_limit: { type: "quota", label: "同步上限", unit: "条" }, // value 存数字;null=无限
    share:      { type: "flag",  label: "共享日历" },
  },
  eval: {
    submit:     { type: "flag",  label: "提交评教" },
    batch:      { type: "flag",  label: "批量评教" },
  },
  cqu: {
    // 浏览器插件快捷登录的 per-user 同意开关(见 Phase D)。
    quicklogin: { type: "flag",  label: "允许浏览器插件快捷登录" },
  },
} as const satisfies Record<string, Record<string, CapDef>>;

export const PRESETS: Record<string, Record<string, Record<string, number | null>>> = {
  "学生": { calendar: { sync: 1, sync_limit: 50 }, eval: { submit: 1 } },
  "助教": { calendar: { sync: 1, sync_limit: null, share: 1 }, eval: { submit: 1, batch: 1 } },
};

export const isFlag  = (d: CapDef) => d.type === "flag";
export const isQuota = (d: CapDef) => d.type === "quota";

export type Subsystem = keyof typeof CAPABILITIES;
export const SUBSYSTEMS = Object.keys(CAPABILITIES) as Subsystem[];
```

**Step 4: 跑测试确认通过** — `npm run test -- capabilities` → PASS。
**Step 5: 提交** — `git add -A && git commit -m "feat(caps): add capability catalog + presets constant"`。

---

### Task A2: `user_entitlement` 表 + migration

**Files:**
- Modify: `src/db/schema.ts`(在 oauthClientCquScopes 后追加)
- Create: `drizzle/migrations/0004_user_entitlement.sql`
- Test: `test/schema.entitlement.test.ts`(轻量:导入即编译)

**Step 1: schema 追加**

```ts
// src/db/schema.ts — 追加
export const userEntitlement = sqliteTable(
  "user_entitlement",
  {
    userId: text("user_id").notNull(),
    subsystem: text("subsystem").notNull(),
    capability: text("capability").notNull(),
    value: text("value").notNull(),          // flag:'1' | quota:数字串 | '' 约定无限
    updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [primaryKey({ columns: [table.userId, table.subsystem, table.capability] })]
);
```

**Step 2: 生成 migration(schema 为源,不手写)**

`user_entitlement` 是 **App 自有表**(走 drizzle adapter),所以**用 `npm run db:generate` 从 schema.ts 生成 0004**,核对生成 SQL 正确再用——别手写(手写会和 `db:generate` 输出冲突)。期望生成约:

```sql
-- drizzle/migrations/0004_user_entitlement.sql(db:generate 产出,核对即可)
CREATE TABLE `user_entitlement` (
  `user_id` text NOT NULL, `subsystem` text NOT NULL, `capability` text NOT NULL,
  `value` text NOT NULL, `updated_at` text DEFAULT (datetime('now')) NOT NULL,
  PRIMARY KEY(`user_id`, `subsystem`, `capability`)
);
```
> 区别:**Better Auth 自有表**(user/session/oauthClient…)才需手写 SQL(CLI 不支持函数式 `createAuth`);App 自有表用 `db:generate` 正常。如需 `idx_user_entitlement_user` 索引,在 schema 加 `.index()` 让其一并生成。

**Step 3: 本地迁移 + 验证** — `npm run db:migrate:local`,确认无报错;`git add drizzle/migrations/0004_*`。
**Step 4: 提交** — `git commit -m "feat(db): add user_entitlement table + migration"`。

---

### Task A3: caps 解析服务

**Files:**
- Create: `src/services/entitlements.ts`
- Test: `test/entitlements.test.ts`

**Step 1: 写失败测试**

```ts
// test/entitlements.test.ts
import { describe, it, expect } from "vitest";
import { rowsToCaps } from "../src/services/entitlements";

describe("rowsToCaps", () => {
  const rows = [
    { subsystem: "calendar", capability: "sync", value: "1" },
    { subsystem: "calendar", capability: "sync_limit", value: "200" },
    { subsystem: "eval", capability: "submit", value: "1" },
  ];
  it("maps flags to booleans and quotas to numbers", () => {
    const caps = rowsToCaps(rows);
    expect(caps.calendar).toEqual({ sync: true, sync_limit: 200, share: false });
    expect(caps.eval).toEqual({ submit: true, batch: false });
  });
  it("can scope to a single subsystem (least-disclosure for JWT)", () => {
    const caps = rowsToCaps(rows, "calendar");
    expect(caps).toEqual({ calendar: { sync: true, sync_limit: 200, share: false } });
    expect((caps as any).eval).toBeUndefined();
  });
  it("absent quota defaults to null (= unset), absent flag to false", () => {
    const caps = rowsToCaps([]);
    expect(caps.calendar.sync).toBe(false);
    expect(caps.calendar.sync_limit).toBe(null);
  });
  it.each(["-1", "Infinity", "abc", "1e9", "3.5"])("rejects malformed quota %s → null", (bad) => {
    const caps = rowsToCaps([{ subsystem: "calendar", capability: "sync_limit", value: bad }]);
    expect(caps.calendar.sync_limit).toBe(null);
  });
});
```

**Step 2: 确认失败** — `npm run test -- entitlements` → FAIL。

**Step 3: 实现**(用目录补齐缺省;flag→bool,quota→number|null)

```ts
// src/services/entitlements.ts
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { userEntitlement } from "../db/schema";
import { CAPABILITIES, SUBSYSTEMS, type Subsystem } from "../capabilities";

type Row = { subsystem: string; capability: string; value: string };
export type Caps = Record<string, Record<string, boolean | number | null>>;

export function rowsToCaps(rows: Row[], only?: Subsystem): Caps {
  const subs = (only ? [only] : SUBSYSTEMS) as Subsystem[];
  const out: Caps = {};
  for (const sub of subs) {
    out[sub] = {};
    for (const [key, def] of Object.entries(CAPABILITIES[sub])) {
      const row = rows.find((r) => r.subsystem === sub && r.capability === key);
      if (def.type === "flag") out[sub][key] = row?.value === "1";
      else // quota:仅接受纯非负整数串(`^\d+$`),否则视为未设(null=无限)——防恶意/脏行
        out[sub][key] = row && /^\d+$/.test(row.value) ? Number(row.value) : null;
    }
  }
  return out;
}

export async function resolveCaps(db: D1Database, userId: string, only?: Subsystem): Promise<Caps> {
  const rows = await drizzle(db).select().from(userEntitlement)
    .where(eq(userEntitlement.userId, userId)).all();
  return rowsToCaps(rows, only);
}
```

**Step 4: 确认通过** — `npm run test -- entitlements` → PASS。
**Step 5: 提交** — `git commit -m "feat(caps): entitlement rows→caps resolution service"`。

---

## Phase B — caps 下发 + admin 管理

### Task B1: customSession 暴露 caps 给 SPA

**Files:** Modify `src/auth.ts`(`withCloudflare` 第二参 `plugins`),Test `test/auth.session-caps.test.ts`(集成,或手动)。

**Step 1:** 在 plugins 数组加 `customSession`,注入 caps。**排除 `cqu` 伪子系统**(`cqu.quicklogin` 是 opt-in flag,不该盖进每个 SPA 会话;它**永远不是闸**,出票权威校验在 DO)。`resolveCaps` 加 `excludeInternal` 选项或解析后 `delete caps.cqu`:

```ts
import { customSession } from "better-auth/plugins";
// ...plugins: [ ...,
customSession(async ({ user, session }) => {
  const caps = await resolveCaps(env.DATABASE, user.id);
  delete (caps as any).cqu;              // 不向 SPA 会话披露 quicklogin;设置页另用专用查询
  return { user, session, caps };
}),
```

**Step 2:** 手动验证 — `npm run dev`,登录后 `GET /api/auth/get-session` 返回含 `caps`。
**Step 3: 提交** — `git commit -m "feat(caps): expose caps via customSession for SPA"`。

> 注意:`customSession` 需放在能拿到 `env` 的闭包内(`createAuth(env, request)` 已在闭包),直接引用 `env.DATABASE`。

---

### Task B2: customAccessTokenClaims 按 client→subsystem 盖 caps

**Files:** Modify `src/auth.ts`(`jwt()` 配置),Test 手动(取 token 解码看 claim)。

**Step 1:** 给 `jwt({...})` 配置 payload 定制(确认 better-auth `jwt` 插件当前钩子名:`definePayload` / `jwt.definePayload`,**用 Context7 核对**)。映射规则:从被请求 token 的 `client_id` 查 `oauthClient.metadata.subsystem`,只盖该片 caps(最小披露)。

```ts
jwt({
  jwt: {
    definePayload: async ({ user }, ctx) => {
      const clientId = ctx?.client_id; // 以实际 API 为准
      const sub = await subsystemOfClient(env, clientId); // 读 oauthClient.metadata.subsystem
      const caps = sub ? await resolveCaps(env.DATABASE, user.id, sub) : {};
      return { caps };
    },
  },
}),
```

**Step 2:** 验证(可写集成测试或手动)— 日历 client 的 token **只含 `caps.calendar`**;插件 client 的 token **不含** `caps.calendar/eval`(只 `caps:{}` 或 `caps.cqu`)。
**Step 3: 提交** — `git commit -m "feat(caps): stamp per-subsystem caps into access token"`。

> **⚠️ 先 Context7 核对**(实现前必做):(a) 钩子准确名(`customAccessTokenClaims` / `jwt.definePayload`),(b) 签发时上下文**能否拿到 `client_id`**。
> **🚫 禁止"盖全量"兜底**(安全红线 B-4):若钩子拿不到 client_id 无法按 client 切片,**不许盖全量**——会把用户完整能力图泄露给 XSS 可达的公开插件 client。兜底只能是 **盖空 `caps:{}`**(子系统改用 §C2 的 RPC / 专用 endpoint 按自己 subsystem 取),或改用 **oauthProvider 的 token 钩子**(有完整 OAuth 上下文,能拿 client_id)。插件 client 无论如何只能拿 `caps:{}` 或 `caps.cqu`。

---

### Task B3: admin entitlement CRUD + 套用预设

**Files:** Modify `src/auth.ts`(`statement` 加 `entitlement:["assign","revoke"]`,superAdmin 角色加之),Modify `src/routes/admin.ts`(新增 RESTful 路由),Test `test/admin.entitlement.test.ts`。

路由(RESTful,沿用现有 admin 守卫 + `hasPermission`):
- `GET    /api/admin/users/:id/entitlements` → 该用户全部 entitlement 行
- `PUT    /api/admin/users/:id/entitlements` → 全量替换 `{ items:[{subsystem,capability,value}] }`(校验 key ∈ CAPABILITIES、quota 值为数字)
- `POST   /api/admin/users/:id/entitlements/preset` → `{ preset:"学生" }` 套用预设(写若干行)
- `DELETE /api/admin/users/:id/entitlements/:subsystem/:capability` → 删单条

**Step 1: 写失败测试**(校验拒绝非法 key、quota 非数字)。
**Step 2: 实现**(`statement` + 角色 + 路由;校验用 `CAPABILITIES`)。**记得** `statement` 仍 spread `defaultStatements`,superAdmin 仍 spread `adminAc.statements`(CLAUDE.md 坑)。
**Step 3: typecheck + test 通过**。
**Step 4: 提交** — `git commit -m "feat(admin): per-user entitlement management + preset apply"`。

---

### Task B4: admin 前端 UI(可后置/独立)

**Files:** Modify `frontend/src/pages/Admin.tsx`(用户编辑区加 entitlement 面板:flag 勾选框 / quota 数字框,来源 `CAPABILITIES`;预设下拉一键套用)。
独立任务,不阻塞后端。完成后 `cd frontend && npx tsc --noEmit` 通过再提交。

---

## Phase C — 第一方传输层

### Task C1: 跨子域 cookie SSO

**Files:** Modify `src/auth.ts`(`withCloudflare` 第二参顶层加 `trustedOrigins` + `advanced.crossSubDomainCookies`)。

```ts
// withCloudflare 第二参对象内追加:
trustedOrigins: [
  "https://auth.cqu.moe", "https://calendar.cqu.moe", "https://eval.cqu.moe",
],
advanced: { crossSubDomainCookies: { enabled: true, domain: "cqu.moe" } },
```

**Step 1:** 改配置。**用 Context7 核对** better-auth `advanced.crossSubDomainCookies` 与 `trustedOrigins` 当前用法。
**Step 2: 手动验证** — 两个本地子域(改 hosts 或部署预览)验证一次登录 cookie 跨子域可用;SameSite=Lax。
**Step 3: 提交** — `git commit -m "feat(sso): cross-subdomain cookie + trustedOrigins"`。

> 换域名时同步 `trustedOrigins` + `BETTER_AUTH_URL`(CLAUDE.md 坑)。

---

### Task C2: Service Binding RPC entrypoint

**Files:** Create `src/rpc.ts`(`AuthService extends WorkerEntrypoint`),Modify `src/index.ts`(export),Modify `wrangler.jsonc`(若 auth 自身需被绑定,服务名确认),Test `test/rpc.test.ts`。

接口:
```ts
export class AuthService extends WorkerEntrypoint<Env> {
  async verifySession(cookieHeader: string | null) {
    if (!cookieHeader) return null;
    const auth = createAuth(this.env, new Request("https://auth.cqu.moe", { headers: { cookie: cookieHeader } }));
    const s = await auth.api.getSession({ headers: new Headers({ cookie: cookieHeader }) });
    if (!s) return null;
    const caps = await resolveCaps(this.env.DATABASE, s.user.id);
    return { user: s.user, caps };
  }
  async getCquTicket(args: { clientId: string; service?: string; serviceUrl?: string; userId: string }) {
    // 1) client-scope 闸(查 oauth_client_cqu_scopes[clientId])
    // 2) 若 serviceUrl:走 Task D1 校验 + cqu.quicklogin opt-in
    // 3) CQU_SESSION.idFromName(userId) → DO /service-ticket
    // 复用 Phase D 的 service-url 校验 + DO 分支,不要另起一套
  }
}
```

**Step 0: 可行性预检(M-2,Cloudflare 文档/Context7)** — 确认**单个 Worker 能否同时** `export default app`(Hono fetch)**和** `export class AuthService extends WorkerEntrypoint`。不行则退路:① 拆独立 `auth-internal` Worker 暴露 RPC;② 把 RPC 方法做成 auth 的内部 HTTP 端点。先确认再写。
wrangler 示例(子系统侧绑定 auth):
```jsonc
// calendar 的 wrangler.jsonc
{ "services": [{ "binding": "AUTH", "service": "cqu-auth", "entrypoint": "AuthService" }] }
```

**Step 1: 写测试**(verifySession 无 cookie→null;getCquTicket 未授权 client→error;**未 opt-in 的 serviceUrl 调用→error**——RPC 路径必须同样被 DO 的 opt-in 闸挡)。
**Step 2: 实现** — 校验/取票/opt-in 逻辑**全部复用 DO 的 `getServiceTicket`**(万能闸,见 D3/D5),RPC 只做转发,**绝不另起一套校验**。**🔒 clientId 鉴权(M-6)**:RPC 调用者**自报的 `clientId` 必须验证**(传 client_secret,或 auth 配置维护"binding→clientId"映射);持广域 scope(`*`/`any`)的调用**强制**,否则任一被绑定 Worker 可冒领高权限。
**Step 3: typecheck + test 通过**;`wrangler dev` 不报错。
**Step 4: 提交** — `git commit -m "feat(rpc): AuthService WorkerEntrypoint (verifySession, getCquTicket)"`。

> 依赖:Phase D 的 `service-url.ts` + DO opt-in 闸 → **C2 必须排在 D1/D3/D5 之后**。

---

### Task C3: 子系统侧 binding 文档

无代码改动。在 `docs/subsystem-integration-guide.md` §1.2 已写明 `wrangler.jsonc` services binding + RPC 用法,执行时核对接口签名与最终实现一致。

---

## Phase D — 插件快捷登录 + 取票安全(最敏感)

### Task D1: serviceUrl 校验(安全核心,严格 TDD)

**Files:** Create `src/services/service-url.ts`,Test `test/service-url.test.ts`。

**Step 1: 写失败测试 — 绕过向量逐条覆盖(一个都不能少)**

```ts
// test/service-url.test.ts
import { describe, it, expect } from "vitest";
import { validateCquServiceUrl } from "../src/services/service-url";

describe("validateCquServiceUrl", () => {
  it.each([
    "https://my.cqu.edu.cn/sso/login",
    "https://cqu.edu.cn/x",
    "https://my.cqu.edu.cn:443/x",            // 显式 443 必须 ACCEPT(防回归成 if(port)reject)
  ])("accepts %s and returns canonical href", (ok) => {
    expect(validateCquServiceUrl(ok)).toBe(new URL(ok).href);
  });
  // pinned 决策:纯数字子域属 *.cqu.edu.cn → 放行,CAS service registry 兜底
  it("accepts numeric-looking subdomain", () => {
    expect(() => validateCquServiceUrl("https://0x7f000001.cqu.edu.cn/x")).not.toThrow();
  });
  it.each([
    "http://my.cqu.edu.cn/x",                 // 非 https
    "https://evil-cqu.edu.cn/x",              // 缺前导点
    "https://cqu.edu.cn.evil.com/x",          // 后缀在中间
    "https://lib.cqu.edu.cn@evil.com/x",      // userinfo
    "https://lib.cqu.edu.cn\\@evil.com/x",    // ★ 反斜杠(曾 ACCEPT 的 blocker B-1)
    "https://my.cqu.edu.cn:8443/x",           // 异常端口
    "https://my.cqu.edu.cn./x",               // ★ 尾点(pinned REJECT:cn.==cn 风险)
    "https://my。cqu。edu。cn/x",              // ★ 全角点(non-ascii,pinned REJECT)
    "https://my.cqu.edu.cn\r\n.evil.com/x",   // ★ CRLF 注入形
    "https://my.cqu.edu.cn%252e.evil.com/x",  // ★ 双重编码点
    "https://xn--cqu-evil.edu.cn/x",          // IDN(非 .cqu.edu.cn)
    "https://127.0.0.1/x",                    // ★ IP literal
    "ftp://my.cqu.edu.cn/x",
    "javascript:alert(1)",
    "not a url",
  ])("rejects %s", (bad) => {
    expect(() => validateCquServiceUrl(bad)).toThrow();
  });
});
```

**Step 2: 确认失败** — `npm run test -- service-url` → FAIL。

**Step 3: 实现(解析后判,绝不裸字符串)**

```ts
// src/services/service-url.ts
// 仅允许 https 的 *.cqu.edu.cn,杜绝 CVE-2022-39369 式 ST-relay。
// 红线:① 解析前拒反斜杠/非ASCII;② 绝不裸 endsWith;③ 强制 ToASCII;④ 只返回 canonical href。
export function validateCquServiceUrl(input: string): string {
  if (input.includes("\\")) throw new Error("INVALID_SERVICE_URL: backslash");        // \→/ 跨解析器陷阱
  if (/[^\x20-\x7e]/.test(input)) throw new Error("INVALID_SERVICE_URL: non-ascii");  // 杀 IDN同形/全角点/CRLF
  let u: URL;
  try { u = new URL(input); } catch { throw new Error("INVALID_SERVICE_URL: unparsable"); }
  if (u.protocol !== "https:") throw new Error("INVALID_SERVICE_URL: not https");
  if (u.username || u.password) throw new Error("INVALID_SERVICE_URL: userinfo");
  if (u.port && u.port !== "443") throw new Error("INVALID_SERVICE_URL: port");
  const host = u.hostname.toLowerCase();
  if (/[^a-z0-9.-]/.test(host)) throw new Error("INVALID_SERVICE_URL: bad host char");  // %编码等残留
  if (host.endsWith(".")) throw new Error("INVALID_SERVICE_URL: trailing dot");         // cn. == cn 风险
  if (!(host === "cqu.edu.cn" || host.endsWith(".cqu.edu.cn")))                          // 判 PARSED hostname
    throw new Error("INVALID_SERVICE_URL: host not allowed");
  return u.href; // ★ canonical;下游(cqu.ts/DO/RPC)只用此返回值,绝不回传原始 input
}
```
> **round-trip 不是安全控制**:同一 WHATWG 解析器自稳,挡不住跨解析器差异;真正防御靠"只返回/只用 canonical href"(Task D4 断言)。

**Step 4: 确认通过** — `npm run test -- service-url` → PASS(全部绕过向量被拒)。
**Step 5: 提交** — `git commit -m "feat(security): strict *.cqu.edu.cn serviceUrl validation"`。

---

### Task D2: `cqu:ticket:any` scope

**Files:** Modify `src/auth.ts`(`OAUTH_SCOPES` 加 `"cqu:ticket:any"`),Modify `src/middleware/scope.ts`。

admin grant 正则 `/^cqu:ticket:([\w*]+)$/` 已接受 `any`,**无需改正则**。在 `scope.ts` 中:当请求带 `serviceUrl`(而非 service key)时,required scope 视为 `cqu:ticket:any`,token 与 client 二层校验沿用同逻辑(`any` 或 `*` 通过)。

**Step 1: 写测试** — 有 `cqu:ticket:any` 的 token/client 过广域校验;无则 403。
**Step 2: 实现**。**Step 3: test 通过**。**Step 4: 提交** — `git commit -m "feat(scope): add cqu:ticket:any for broad-host quick-login"`。

---

### Task D3: 关闭 cookie 绕过(必修缺口,两件事别只修一半)

**Files:** Modify `src/middleware/scope.ts`(`:12-14`),Modify `src/durable-objects/cqu-session.ts`(DO 内无条件校验),Test `test/scope.bypass.test.ts`。

**问题(两层)**:`scope.ts:12-14` 无 Bearer 时直接 `next()`,而 `cqu.ts:10-35` 接受 session cookie → cookie 调用者**跳过全部 scope/per-client 校验**。不只影响新 `serviceUrl`——**今天**任何登录 cookie 就能取 4 个符号 key 任意一张票而无授权校验。

**Step 1: 写失败测试** —
- cookie-only `service=card` 无授权 → 期望 403(符号 key 路径也要授权,不能裸 `next()`)。
- cookie-only 命中 `serviceUrl` → 必须经 DO host 白名单(非法 URL → 拒)。
**Step 2: 实现** —
- `scope.ts` no-Bearer 分支**不再 blanket `next()`**:解析主体 + 显式授权(第一方"self"语义放行符号 key,或按策略拒),不留 fall-through。
- DO `getServiceTicket` 对**任何**带 URL 入参**无条件** `validateCquServiceUrl`(route/RPC/cookie 都汇于此)。
- 本任务只关 **host 白名单 + 符号 key 授权**;`cqu.quicklogin` opt-in 在 **Task D5**(同样落 DO),紧随其后补。
**Step 3: test 通过**。**Step 4: 提交** — `git commit -m "fix(security): close cookie-path scope bypass (symbolic + serviceUrl)"`。

---

### Task D4: cqu.ts 接受 serviceUrl + DO getServiceTicket 分支

**Files:** Modify `src/routes/cqu.ts`(`:40-60`),Modify `src/durable-objects/cqu-session.ts`(`getServiceTicket` `:338-351`、handler `:212-217`),Test `test/cqu.serviceurl.test.ts`。`src/services/cqu-sso.ts` **不改**。

**Step 1: 写测试** — `?serviceUrl=https://my.cqu.edu.cn/x`(合法)→ 触达 DO;非法 URL → 400/403 早拒;无 `service` 且无 `serviceUrl` → 400;**断言传给 `ssoClient.getServiceTicket` 的 URL `===` `validateCquServiceUrl` 返回值**(canonical href,绝非原始 param)。
**Step 2: 实现** —
- `cqu.ts:41` 同时取 `service` 与 `serviceUrl`;若 `serviceUrl`,先 `validateCquServiceUrl` 早拒,**之后全程只用其返回的 canonical href**,传 canonical token 给 `requireCquScope`(走 `any`)。
- 转发到 DO 用 `URL`/`searchParams.set` 构造(别字符串拼接),DO 侧 `url.searchParams.get` 解回,避免完整 URL 含 `?#` 与 DO 请求自身 query 冲突。
- DO `getServiceTicket`:已知 key → `SERVICE_URLS[service]`(不变);URL 入参 → **DO 内再 `validateCquServiceUrl` 一次(权威)**,只用其返回值传 `ssoClient.getServiceTicket(cookies, validated)`。
**Step 3: typecheck + test 通过**。**Step 4: 提交** — `git commit -m "feat(cqu): accept validated serviceUrl for quick-login ST mint"`。

---

### Task D5: `cqu.quicklogin` per-user opt-in(在 DO 内强制)

**Files:** Modify `src/durable-objects/cqu-session.ts`(`getServiceTicket` 内),Test `test/cqu.quicklogin-optin.test.ts`。

**规则**:`serviceUrl`/`any` 路径出票前,**在 DO `getServiceTicket` 内**(唯一万能闸)查 `resolveCaps(db, userId, "cqu").cqu.quicklogin === true`,否则拒。**只作用于广域路径**,不影响普通 `service` key 取票(仍纯 client-scope)。

**为什么在 DO 而非"调 DO 之前"**:有三条入口(HTTP route、RPC `getCquTicket`、DO 自身)。放路由层 → RPC 直调 DO 会绕过。DO 已按 `userId` 载状态,顺手 `resolveCaps(userId,"cqu")` 即可;route/RPC 可预校验改 UX 但 **DO 权威**。

**Step 1: 写失败测试** —
- 未开 `cqu.quicklogin` 经 **HTTP** serviceUrl 取票 → 拒;开了 → 放行;`service=jwxt` 不受影响。
- **未开经 RPC `getCquTicket(serviceUrl)` → 同样拒**(证明 DO 闸覆盖 RPC 入口)。
**Step 2: 实现**(opt-in 校验落 DO `getServiceTicket`,与 host 校验同处)。
**Step 3: test 通过**。**Step 4: 提交** — `git commit -m "feat(security): enforce cqu.quicklogin opt-in inside the DO chokepoint"`。

---

### Task D6: 审计 + 限流(在 DO 万能闸,非 betterAuth rateLimit)

**Files:** Modify `src/durable-objects/cqu-session.ts`(`getServiceTicket` 内),Test `test/cqu.audit-ratelimit.test.ts`。

**为什么在 DO**:betterAuth `rateLimit` 只覆盖 HTTP auth 路由——**不覆盖 RPC 路径(`env.AUTH.getCquTicket`,无 HTTP)也不覆盖 DO 内出票**。被攻陷的第一方 Worker 可经 RPC 循环出票而不受限;审计同理(RPC 无 IP、符号 key 路径今天零日志)。→ 限流 + 审计都落 DO。

- **审计**:每次出票记 `{ clientId, userId, target, ts, ip?, source: "route"|"rpc"|"cookie" }`。MVP 用结构化 `console.log`(CF observability 抓);要可查询再落 D1 表(加 migration 0005)。RPC 无 IP 记 null、记调用方 clientId/binding。
- **限流**:DO 内 per `(userId, clientId)` + per `userId` 全局出票上限(复用 DO relogin 限频思路);对"单位时间多 distinct serviceUrl host"告警(open-redirector 探测信号)。

**Step 1: 写测试**(超阈值拒;审计字段齐全含 `source`)。**Step 2: 实现**。**Step 3: test 通过**。**Step 4: 提交** — `git commit -m "feat(security): audit + rate-limit ST mint inside the DO"`。

---

## 收尾

- **全量校验**:`npm run typecheck` + `cd frontend && npx tsc --noEmit` + `npm run test` 全绿。
- **CLAUDE.md 同步**:新增 `user_entitlement`、caps 下发、`cqu:ticket:any`、serviceUrl 校验、cookie 绕过修复、RPC entrypoint 等写进架构/gotcha(用 claude-md-management:revise-claude-md)。
- **接入文档复核**:`docs/subsystem-integration-guide.md` 中标「计划中」的接口签名与最终实现对齐,去掉「计划中」。
- **部署**:合 main 触发生产部署前,确认迁移 `0004` 在 CI `migrations apply --remote` 链路内。
- **插件**:auth 侧契约就绪后,插件本体另起项目(MV3),按 §5 契约接入。

---

## 任务依赖图

```
A1 ─ A2 ─ A3 ─┬─ B1
              ├─ B2
              └─ B3 ─ B4(独立)
A3 ───────────── C1(独立配置)
D1 ─ D2 ─ D3 ─ D4 ─ D5 ─ D6   ← D3/D4/D5/D6 全改同一个 DO.getServiceTicket(万能闸),作为一组连续实现
D1·D3·D5 ──────────── C2(RPC 复用 DO 万能闸:host 校验 + opt-in + 限流,不另起一套)
```

建议顺序:**A1→A2→A3→B1→B2→B3 → D1→D2→D3→D4→D5→D6 → C1→C2 → B4**。Phase A/B 上线不改取票行为,可先验证 caps 全链路;**D3/D4/D5/D6 改同一 `DO.getServiceTicket` 万能闸,作为一组连续完成**;C2(RPC)复用该万能闸,排在 D5 之后。
