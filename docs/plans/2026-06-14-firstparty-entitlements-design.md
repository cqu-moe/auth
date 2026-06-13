# 第一方一体化 + 分级权益(Entitlements)设计

> 设计文档 · 2026-06-14 · 状态:**待实现**(brainstorm 已定稿,实现计划见同目录 `*-plan.md`)
> 仓库:`/Users/uu/Documents/Coding/cqu-moe/auth`
> 关联接入文档:`docs/subsystem-integration-guide.md`(给实现各子系统的 agent 读)

## 0. 一句话

把"子系统作为第三方 OAuth 客户端接入"的别扭关系,改造成 **Google Account ↔ Gmail ↔ Drive 那种第一方原生一体**:按客户端类型分道(共享 cookie / 内部 RPC / OAuth),用户权限改为**中心直接按用户授予的能力(entitlements,含配额)**,CQU 取票维持**按子系统最小权限**,并新增**浏览器插件快捷登录**(ST 跳转,不外泄主钥匙)。

---

## 1. 现状诊断(为什么要改)

对照源码核实的核心错配:**系统在"授权 App",但第一方套件需要"授权 用户在每个 App 里的能力"。**

| 维度 | 现状 | 问题 |
|------|------|------|
| CQU 服务访问 | `oauth_client_cqu_scopes` 按 `clientId`(应用)授权(`scope.ts:45-60`) | 问的是"这个 *App* 能不能取票",与"用户是谁"无关 |
| 用户角色 | `user.role` 全局三档 `user/admin/superAdmin`(`auth.ts:26-40`) | 是"谁能管理 IdP",不是"用户在日历里能用什么" |
| 分级维度 | 不存在 | 没有任何 `用户 × 子系统 × 能力` 的表达 |
| 第一方/第三方 | 数据模型无此标志,仅 `skipConsent` 布尔(`oauthClient`) | 自家应用与陌生第三方走同一套 consent/code 机器 |

**结论**:分级不是现有 per-client scope 表的扩展,而是一条**全新的、正交的 `用户 × 子系统 × 能力` 轴**;它与"取票安全(per-client)"必须解耦。

---

## 2. 设计原则与非目标

**原则**
1. **第一方 ≠ 第三方,按客户端类型分道**(共享 cookie / 内部 RPC / OAuth+PKCE)。
2. **分级 = per-user entitlements**,中心直接按用户授予;tier/预设只是批量套用的便利,不是事实源。
3. **CQU 取票安全 = client-scope 最小权限**(沿用现有双层校验并收紧)。能力(caps)**不参与**普通子系统取票。
4. **一份持久会话(DO 的 CAS 会话)派生多个短命、按受众隔离的 ticket**;主钥匙(TGT)永不出云端。

**非目标(明确不做,防过度工程)**
- ❌ 不上 ReBAC 引擎(OpenFGA/SpiceDB)或外部授权服务(无关系图谱、单租主)。
- ❌ 不用 organization 插件硬塞 tier(多租户机制对单租主是纯负担)。
- ❌ 不为第一方抛弃 OAuth 改纯共享会话(会丢 scope 隔离 / 按 client 撤销 / 第三方路径)。
- ❌ 不把分级编进 OAuth scope 或 consent 层(授权与 entitlement 解耦)。
- ❌ 不导出 TGT 到浏览器(插件只经手单服务、一次性 ST)。
- ❌ 能力目录不上 D1 动态表(先用 TS 常量,见 §4 方案 A)。

---

## 3. 第一方一体化:三种拓扑

子系统**部署在哪**决定了它与 auth 的"对话方式";功能/caps/取票逻辑三种完全一样,变的只是"身份怎么传过去"。

```
                子系统跑在哪?
        ┌──────────────┴───────────────┐
   在 *.cqu.moe 子域?              不在(别的域名)
        │                               │
   ┌────┴─────┐                    ③ OAuth + PKCE 跳转
是同账户 Worker?  不是(VPS/Python…)
   │              │
① cookie + RPC   ② cookie + JWT
(主线,最丝滑)     (中间)
```

| 拓扑 | 浏览器登录态(SPA) | 服务间调用 | 身份校验 | 离线取票 |
|------|------|------|------|------|
| **① 同账户 `*.cqu.moe` Worker** ⭐ | 跨子域 cookie(`domain=cqu.moe`),一次登录全通、零 consent | **Service Binding RPC** | RPC 取**实时** caps/封禁 | RPC 直取,零 token 负担 |
| **② `*.cqu.moe` 跨账户/非 Worker** | 跨子域 cookie 仍可(同根域) | 公网 HTTPS + JWT | 离线验 JWT(JWKS) | 需 `offline_access` refresh token |
| **③ 不同根域 / 浏览器插件** | 走一次 OAuth 跳转(自家 client `skipConsent`,体验≈静默) | 公网 + JWT | 离线验 JWT | 同②(refresh token) |

**日历、教评等核心子系统按拓扑① 实现为主线**(最接近"原生一体",离线取票几乎零成本);放不进① 的自动降级到②,同一套设计无缝兼容;浏览器插件是③。

### 3.1 第一方客户端配置(skipConsent)

每个子系统 = 注册**一个第一方 OAuth client**,承载两件事:① 它能拿到哪片 caps、② 它被允许取哪些 CQU 票。

```
client "calendar":
  skipConsent: true                 // 第一方静默授权
  redirectUris: ["https://calendar.cqu.moe/callback"]   // 精确匹配
  metadata.subsystem: "calendar"    // 关键映射 → 决定 token 盖哪片 caps
  oauth_client_cqu_scopes: ["cqu:ticket:jwxt"]          // 最小权限
```

**`skipConsent` 护栏**(各家一致,写入实现):必须是 **admin 服务端设置**的 per-client 属性,绝不由 client 请求自述;auto-consent 仍**精确匹配注册 redirect_uri**;`localhost`/自定义 scheme 等不可验证回调**拒绝 auto-consent**;仍尊重 `prompt=consent` 强制弹窗。

### 3.2 跨子域 cookie SSO(拓扑①②)

`src/auth.ts` 的 betterAuth 配置增:

```ts
advanced: { crossSubDomainCookies: { enabled: true, domain: "cqu.moe" } },
trustedOrigins: ["https://auth.cqu.moe", "https://calendar.cqu.moe", "https://eval.cqu.moe", ...],
```

一次登录,cookie 自动在所有 `.cqu.moe` 子域生效(SameSite 保持 Lax)。换域名时同步 `trustedOrigins` 与 `BETTER_AUTH_URL`。

### 3.3 Service Binding RPC(拓扑①)

auth Worker 暴露 `WorkerEntrypoint`,同账户子系统通过 service binding 进程内调用(不走公网、部署期绑定即天然访问控制):

```ts
// auth Worker
export class AuthService extends WorkerEntrypoint<Env> {
  // 校验浏览器 cookie → 返回身份 + 实时 caps
  async verifySession(cookieHeader: string): Promise<{ user; caps } | null> { ... }
  // 替用户取 CQU service ticket(机器信任 + client-scope + DO active)
  async getCquTicket(args: { clientId: string; service?: string; serviceUrl?: string; userId: string }): Promise<{ ticket: string } | { error: string }> { ... }
}
```

子系统侧:

```ts
const sess = await env.AUTH.verifySession(req.headers.get("cookie"))
if (!sess) return new Response("401", { status: 401 })
if (!sess.caps.calendar.sync) { /* 功能未开通 */ }
const { ticket } = await env.AUTH.getCquTicket({ clientId: "calendar", service: "jwxt", userId: sess.user.id })
```

> **客户端身份不能只靠"自报 clientId"**:RPC 的 binding 图只保证"是某个被绑定的 Worker",但任一被绑定 Worker 都能传**任意** `clientId` 冒领更高权限。→ **持有广域 scope(`cqu:ticket:*`/`any`)的调用必须验证 clientId**(传 client_secret,或 auth 配置里维护"binding 名→clientId"固定映射),非可选;普通最小权限子系统可接受 binding 图信任。
> **可行性待核(plan C2 / M-2)**:单个 Worker 能否同时 `export default app`(Hono)+ `export class AuthService extends WorkerEntrypoint` 需用 Cloudflare 文档确认;不行则退路=拆独立 `auth-internal` Worker,或把 RPC 暴露成内部 HTTP 端点。

---

## 4. 分级 = Per-User Entitlements(能力授权)

**事实源是"每用户的能力授权",不是 tier。** tier/预设降级为 admin 一键套用的便利。能力分两种:**开关型(flag)** 与 **配额型(quota,直接存数字)**。

### 4.1 能力目录(方案 A:TS 常量)

目录定义"系统里存在哪些能力",放 auth 仓库的 TS 常量(类型安全 + git 版本化,前后端/各子系统共享一份;打错 key 编译期就炸)。改能力要重部署——对单业主小套件是可接受代价。**保留升级到方案 D(TS 为源 + 构建期同步 D1)的路,数据结构是其子集。**

```ts
// src/capabilities.ts —— 单一作者源
export const CAPABILITIES = {
  calendar: {
    sync:        { type: "flag",  label: "日历同步" },
    sync_limit:  { type: "quota", label: "同步上限", unit: "条" },  // value 直接存数字;null=无限
    share:       { type: "flag",  label: "共享日历" },
  },
  eval: {
    submit:      { type: "flag",  label: "提交评教" },
    batch:       { type: "flag",  label: "批量评教" },
  },
  // 特例:浏览器插件快捷登录的 per-user 同意开关(见 §6)
  cqu: {
    quicklogin:  { type: "flag",  label: "允许浏览器插件快捷登录" },
  },
} as const
```

`type` 仅决定 admin UI 渲染(勾选框 vs 数字框)与值类型;`value` 存裸值。

### 4.2 每用户授权表(D1,事实源)

```sql
CREATE TABLE user_entitlement (
  user_id     TEXT NOT NULL,
  subsystem   TEXT NOT NULL,          -- 'calendar' | 'eval' | 'cqu' | ...
  capability  TEXT NOT NULL,          -- 'sync' | 'sync_limit' | 'quicklogin' | ...
  value       TEXT NOT NULL,          -- flag: '1';  quota: 数字字符串(如 '200');  null 用空串/约定
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, subsystem, capability)
);
```
> 例:Alice → `calendar.sync=1`, `calendar.sync_limit=200`, `eval.submit=1`, `cqu.quicklogin=1`;Bob → `calendar.sync=1`, `calendar.sync_limit=50`(没给 eval 任何能力)。
> 该表为 **App 自有表**,走 `drizzle-orm/d1`(非 Better Auth Kysely adapter);schema 加在 `src/db/schema.ts`。

### 4.3 预设(可选便利层,TS 常量)

```ts
export const PRESETS = {
  "学生": { calendar: { sync: 1, sync_limit: 50 }, eval: { submit: 1 } },
  "助教": { calendar: { sync: 1, sync_limit: null, share: 1 }, eval: { submit: 1, batch: 1 } },
}
// admin 点"套用学生" → 往 user_entitlement 写若干行 → 仍可逐项加 share。预设非事实源。
```

### 4.4 解析与下发

签发时把该用户的授权解析成 `caps`,子系统**只读 boolean/数字**,不关心 tier/来源:

- **拓扑①(RPC)**:`verifySession` / 专用 `getCaps(userId)` 直接查表返回**实时** caps。
- **拓扑②③(JWT)**:用 Better Auth `jwt` 插件的 payload 定制钩子(暂名 `customAccessTokenClaims` / `definePayload`——**实际钩子名 + 是否能拿到 `client_id` 须 Context7 核对**,见 plan B2)按 `client→subsystem` 映射**只盖这一片** caps(最小披露);下游 `jose + createRemoteJWKSet` 离线验。
- **SPA 自身**:`customSession` 把 caps 暴露给前端渲染。

```jsonc
// token.claims(calendar client)
{ "sub": "...", "caps": { "calendar": { "sync": true, "sync_limit": 200, "share": false } } }
```

> **⚠️ 最小披露是安全属性,不是优化**:若钩子拿不到 `client_id` 无法按 client 切片,**禁止"盖全量"兜底**——那会把用户完整能力图泄露给 XSS 可达的公开插件 client。兜底只能是**盖空 `caps:{}`**,改由子系统经专用 endpoint/RPC 按自己 subsystem 取;再退一步走 oauthProvider 的 token 钩子(有完整 OAuth 上下文)。插件/quicklogin client 只能拿 `caps:{}` 或 `caps.cqu`。
> **`cqu` 伪子系统的披露**:`cqu.quicklogin` 经 `customSession` 会进 SPA 会话——**它永远不是闸**(出票权威校验在 DO,见 §6.3);默认全量 caps 解析应**排除 `cqu` 伪子系统**,只在设置页按需查。

**JWT 撤销滞后**:降档残留在已发 token 内直到过期 → token TTL 设短(插件 token 尤其,5–15min);写/特权路径回落 RPC 取实时态。

### 4.5 admin

复用现有 admin UI/路由(RESTful):per-user 增删改 entitlement、一键套用预设。归在 superAdmin 的能力下(新增 statement,如 `entitlement:[assign,revoke]`,记得 spread `defaultStatements` + `adminAc.statements`,见 CLAUDE.md 坑)。

---

## 5. CQU 取票:按子系统最小权限(沿用 + 收紧)

普通子系统取票**维持现有双层校验**,**caps 不参与**:

1. **token 层**:JWT `scope` 含 `cqu:ticket:{service}` 或 `cqu:ticket:*`(`scope.ts:35-43`)。
2. **client 层**:`oauth_client_cqu_scopes[azp/client_id]` 含之(`scope.ts:45-60`)。

每个子系统 client **只注册它需要的服务**(日历→`jwxt`,教评→`jxpj`…),爆炸半径锁死。

### 5.1 离线取票(用户不在场)

**关键区分**:用户对 auth 的登录态可过期;但 **CQU 的 CAS 会话由 `CquSessionDO` 服务端常驻**(15min keepalive + ~7h 主动重登,无人值守),**ST 由 DO 签,与用户在不在场无关**。用户只需**绑定过一次**。

- **拓扑①**:后台任务(Cron Worker)直接 `env.AUTH.getCquTicket({ clientId, service, userId })`。**全程无用户 cookie/token**;授权 = service binding 机器信任 + client-scope + DO `active`。
- **拓扑②③**:初次授权申请 `offline_access` 拿 refresh token,子系统加密存管,后台先换 access_token 再取票。

**离线护栏**:最小权限(client 只有它该有的 scope)+ 可撤销(解绑/吊销 → DO `revoked` → 立即出不了票)+ 审计每次出票。

---

## 6. 浏览器插件快捷登录(拓扑③ + ST 跳转,方案 b)

**目标**:用户落在 `sso.cqu.edu.cn/login?service=XXX` 时,插件用云端会话替他取 XXX 的 ST,跳转完成登录,跳过输密码/2FA。**浏览器全程拿不到 TGT,只经手单服务、一次性、短时效 ST。**

> 本设计**只覆盖 auth 侧支持面**;插件本体(MV3 实现、登录页检测、跳转)是插件项目自己的事,不在此文档范围。

### 6.1 流程

```
浏览器                插件                              auth.cqu.moe
 │ 落 sso.cqu.edu.cn/login?service=XXX                  │
 │                     │ 抠出 service=XXX                │
 │                     │ GET /api/cqu/service-ticket?serviceUrl=XXX (Bearer 插件 token) ─▶│
 │                     │                                 │ ① 校验 XXX(见 6.3)
 │                     │                                 │ ② client-scope 闸 + cqu.quicklogin opt-in
 │                     │                                 │ ③ DO 用云端 CAS 会话签 ST
 │                     │ ◀──────── { ticket } ───────────│
 │ ◀─ 跳 XXX?ticket=ST │                                 │
 │ 服务自己拿 ST 找 CAS 验票 → 放行                        │
```

### 6.2 auth 侧改动

- **接口新增形态**:`GET /api/cqu/service-ticket?serviceUrl=<https…>`,与现有 `?service=<key>` 并存。**符号 key 路径仍是首选**(client 不供 URL);`serviceUrl` 是受严格校验的例外。
- **scope**:插件 client 授予 `cqu:ticket:any`(新增,语义="任意 `*.cqu.edu.cn` 白名单 host")或退而用 `cqu:ticket:*`。admin grant 正则 `/^cqu:ticket:([\w*]+)$/` 已接受 `any`,**无需改正则**。⚠️ `any` 的爆炸半径见 §6.5——白名单 host **不等于**安全终点。
- **`cqu.quicklogin` per-user opt-in**:在 DO/endpoint(非仅 UI)校验——用户没开此 flag,即便 token 泄露也签不出 ST。这是 entitlement 模型与取票路径的**唯一刻意交点**,且只针对广域插件,不影响普通子系统按 client-scope 取票。

### 6.3 URL 校验(安全核心,务必照做)

ST-relay 是有评分的 CAS 漏洞类(CVE-2022-39369,CVSS 8.0)。**绝不信任 client 供给的 URL**。校验函数(`src/services/service-url.ts`)是**唯一可信来源**;它**返回 canonical `href`**,出票全程只用返回值,绝不回传原始 param:

```ts
function validateCquServiceUrl(serviceUrl: string): string {
  if (serviceUrl.includes("\\")) reject()            // ★ 解析前拒反斜杠:WHATWG 把 \ 改写成 / → 跨解析器陷阱
  const u = new URL(serviceUrl)                       // 解析后再判,绝不裸字符串 endsWith
  if (u.protocol !== "https:") reject()
  if (u.username || u.password) reject()              // 防 https://lib.cqu.edu.cn@evil.com
  if (u.port && u.port !== "443") reject()            // 防异常端口
  const host = u.hostname.toLowerCase()
  if (/[^a-z0-9.-]/.test(host)) reject()              // 强制 ToASCII:拒 %编码/非 ASCII 残留
  if (!(host === "cqu.edu.cn" || host.endsWith(".cqu.edu.cn"))) reject()  // 判 PARSED hostname
  return u.href                                       // ★ 只把 canonical href 往下传
}
```
**红线**:① 裸 `endsWith('.cqu.edu.cn')` 禁用(`evil-cqu.edu.cn`/`cqu.edu.cn.evil.com`/userinfo/IDN/双编码绕过);② 反斜杠 `\` 解析前拒(`https://lib.cqu.edu.cn\@evil.com` 被 WHATWG 改写成 `/@`,但 CAS 的 Java/php 解析器可能当 userinfo);③ **下游只用返回的 canonical `href`**——跨解析器安全靠这一条,**不是**靠 round-trip(同一 WHATWG 解析器自稳,round-trip 只是廉价 sanity)。CQU 自己的 CAS service registry 只是**纵深防御**,不能当唯一闸。

**校验 + opt-in 都在 DO 执行(万能闸)**:route/RPC/cookie 三条入口都汇于 `DO.getServiceTicket`,route/RPC 可预校验改善 UX,但 **DO 再校验且权威**——`serviceUrl`/`any` 路径出票前 DO 先 `validateCquServiceUrl` **再** `resolveCaps(userId,"cqu").cqu.quicklogin===true` 否则拒(见 §7、plan D3/D5)。

### 6.4 可行性边界(写入接入文档,插件需自行兜底)

ST 跳转**对已注册、redirect 式服务可干净登录**(my/lib/card.cqu.edu.cn 即此形)。**失败场景 → 一律降级到原生登录页,绝不伪造流程**:
- 服务未在 CQU CAS 注册 → `parseLoginPage()` 已能识别 `noDocking`(`cqu-sso.ts:54-61`)→ 报"不支持"。
- 服务用 POST-binding/非 `?ticket=` 回调 → 交回服务自身登录按钮。
- SPA 深路由/`pushState` 丢 ticket → 跳"CAS 本会跳的那个确切 URL"。
- 瑞数 WAF 挑战页(ST 热路径**当前豁免**,但若被挑战)→ `classifyNon302Body()` 已能区分,降级到正常登录页。

### 6.5 爆炸半径(为什么 b 是对的)

被盗 **TGT** = 全 CAS 冒充、任意服务、~8h(`PROACTIVE_RELOGIN_MS`,`cqu-session.ts:25`)。被盗**插件 token**(公开 client,XSS 可达)= 仅该用户已 opt-in 的白名单 host、每张 ST 单服务/单次/短时效。

**⚠️ 残余风险(别只靠 host 白名单)**:`*.cqu.edu.cn` 里很可能存在 open-redirector / 反代 / SSO 桥 / 反射 `returnUrl` 的服务——给它取 ST 后,认证后的会话可能被二跳到攻击者处,使 `cqu:ticket:any` 逼近 TGT 量级。**host 白名单只约束"票发给谁",不约束"那个服务拿到会话后干什么"**。缓解(择一 + 监控):① **优先用正向 URL 白名单**(扩展现有符号 `SERVICE_URLS` 模型而非开放 `any`);② 若必须 `any`,诚实记录此残余风险 + 对"已知良好集之外的 host 出票"告警 + 限单位时间 distinct host 数;③ 配合 §6.1 短 TTL(5–15min)+ opt-in 硬闸。**故修订"只那一个服务"的旧措辞为上述。**

---

## 7. ⚠️ 必修缺口:scope 中间件的 cookie 绕过

`requireCquScope()` 在**无 Bearer 头时直接 `next()`**(`scope.ts:12-14`),而 `cqu.ts:10-35` 接受登录 session cookie。→ **cookie 调用者跳过全部 scope/per-client 校验**。这不只影响新 `serviceUrl` 路径——**今天**任何登录用户的 cookie 就能取 jwxt/jxpj/library/card **任意一张票而不经任何 per-client/scope 校验**(目前唯一约束是 DO 封闭的 `SERVICE_URLS`,但那只保证"host 安全",不保证"此主体被授权")。

**修复(两件事,别只修一半)**:
1. **符号 key 路径**:明确"裸登录 cookie(无 client 上下文)到底能不能取票"。`scope.ts` 的 no-Bearer 分支**不能再 blanket `next()`**——要么解析出主体 + 显式授权(如第一方"self"语义),要么拒。
2. **`serviceUrl`/`any` 路径**:host 白名单 + `cqu.quicklogin` opt-in 放进 **DO 无条件执行**(route/RPC/cookie 任一入口都汇于 DO,见 §6.3)。

测试:cookie-only 调用 `service=card` 无授权 → 403;cookie-only 命中 `serviceUrl` 无 opt-in → 403。

---

## 8. 数据模型变更汇总

| 变更 | 位置 | 说明 |
|------|------|------|
| 新增 `user_entitlement` 表 | `src/db/schema.ts` + 手写 migration | 事实源;App 自有表走 drizzle/d1 |
| 新增 `st_mint_audit` 表(或结构化日志) | schema 或 CF observability | 离线/插件出票审计 `(clientId,userId,serviceUrl,ts,ip)` |
| `oauthClient.metadata.subsystem` | 现有字段(JSON) | client→subsystem 映射,决定盖哪片 caps |
| `cqu:ticket:any` scope | `OAUTH_SCOPES`(`auth.ts:44-53`) | 插件广域取票;正则无需改 |
| 能力目录 `CAPABILITIES` / `PRESETS` | 新文件 `src/capabilities.ts` | TS 常量(方案 A) |

> 迁移:**App 自有表(`user_entitlement`)用 `npm run db:generate`** 从 schema.ts 生成;只有 **Better Auth 自有表**才手写 SQL(CLI 不支持函数式 `createAuth`,见 CLAUDE.md)。

---

## 9. 代码改动点(文件级地图)

- `src/auth.ts`:`crossSubDomainCookies` + `trustedOrigins`;`customSession`/`customAccessTokenClaims` 注入 caps;`OAUTH_SCOPES` 加 `cqu:ticket:any`;(导出 RPC entrypoint)。
- `src/middleware/scope.ts`:**关闭 cookie 绕过**(§7);处理 `cqu:ticket:any`/`serviceUrl`。
- `src/routes/cqu.ts`(`:40-60`):接受并校验 `serviceUrl`(§6.3),仍把 canonical scope token 传 `requireCquScope`。
- `src/durable-objects/cqu-session.ts`:`getServiceTicket` 分支(已知 key 走 `SERVICE_URLS`,合法 URL 直用)+ **无条件 host 校验** + 审计;DO 请求处理注意 query 编码(完整 URL 内含 `?#`)。
- `src/services/cqu-sso.ts`(`:94-127`):**无改动**(已接受任意 serviceUrl 并 `encodeURIComponent`,保持"哑"层,校验全在上层)。
- 新文件:`src/capabilities.ts`(目录+预设)、`src/services/entitlements.ts`(查表+解析 caps)、`src/services/service-url.ts`(URL 校验)、RPC `WorkerEntrypoint`(`src/rpc.ts` 或 index)。
- `src/routes/admin.ts` + 前端 Admin:per-user entitlement 增删改 + 套用预设。
- `wrangler.jsonc`:子系统侧加指向 auth 的 service binding(拓扑①)。

---

## 10. 测试策略

- **URL 校验单测(最关键)**:逐一覆盖绕过向量——`evil-cqu.edu.cn`、`cqu.edu.cn.evil.com`、`https://lib.cqu.edu.cn@evil.com`、IDN 同形、双重编码、非 443 端口、非 https。每个都必须 reject。
- **caps 解析单测**:flag/quota/预设套用/缺省;client→subsystem 只盖该片。
- **scope cookie 绕过闭合**:cookie 调用者命中新 `serviceUrl` 路径必须被 host 白名单挡住。
- **RPC entrypoint**:`verifySession` 无效 cookie 返 null;`getCquTicket` 对未授权 client/未 active DO 拒绝。
- 沿用现有 vitest(runtime-agnostic;crypto 部分见 `vitest.config.ts`)。

---

## 11. 迁移与兼容

- 现有第三方 OAuth client、现有 4 个 `service` key 路径**全部继续可用**(符号 key 仍是首选路径)。
- 分阶段:① 数据模型 + caps 下发(不影响取票)→ ② cookie SSO + RPC entrypoint → ③ 插件 `serviceUrl` 接口 + 安全护栏 + cookie 绕过修复 → ④ admin UI。
- 详见 `*-plan.md`。

---

## 附录:研究依据(择要)

- 第一方静默授权是业界正解非 hack:Microsoft `preAuthorizedApplications`、Auth0 first-party、Keycloak `consentRequired=false`、Logto;IETF FiPA draft(consent 是策略非协议)。
- 分级用 entitlements 而非 ReBAC:OpenFGA/SpiceDB 价值(关系图/多租户/跨服务大规模)本项目一条不中;big-tech 一致把 license/entitlement 与 auth 解耦(Microsoft licensing 最显式)。
- ST-relay 安全:CVE-2022-39369(CVSS 8.0,phpCAS Host 头信任)、RFC 9700 redirect_uri 精确匹配 BCP、Apereo CAS Security-Guide(service registry 仅纵深防御)、Black Hat Asia '19 重定向绕过。
- 公开客户端 token:RFC 9700(短 TTL + 轮换/sender-constrain)、RFC 9449 DPoP(被同源 XSS 偷 key 则失效 → 短 TTL+per-service scope+审计+opt-in 才是耐用控制)。
