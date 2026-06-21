# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CQU Auth — 重庆大学统一认证服务。Cloudflare Workers (Hono) + D1 + Better Auth + React SPA。
提供用户注册登录、CQU SSO 绑定（维持 CAS 会话）、OAuth/OIDC 授权、管理后台。

生产域名：`https://auth.cqu.moe`

## Commands

```bash
# 开发
npm run dev                          # wrangler dev (localhost:8787)
cd frontend && npm run dev           # Vite dev (localhost:5173, /api 代理到 :8787)

# 类型检查
npm run typecheck                    # 后端 (根目录 tsconfig)
cd frontend && npx tsc --noEmit      # 前端 (单独 tsconfig)

# 数据库
# ⚠️ 勿用 npm run db:generate：本项目 drizzle/migrations 无 meta/ 基线(0000-0004 全是手写
#    wrangler 风格 SQL)；drizzle-kit generate 会把 schema.ts 所有表(含 Better Auth 表)当全新
#    重生成 0000_<随机名>.sql + 新建 meta/，与手写迁移灾难性冲突。新表一律手写下一个编号的 SQL。
npm run db:migrate:local             # 本地 D1 执行 migration（生产由 GH Actions push main 自动 apply --remote）

# 测试
npm run test                         # vitest run（Node 普通 pool，见 vitest.config.ts；当前测试是 runtime-agnostic crypto，不需要 Workers pool）

# 部署 (GitHub Actions: push main → 自动迁移+部署接管流量; 其他分支 → versions upload 0 流量版本)
# 见 .github/workflows/deploy.yml; CF git-connected Workers Builds 已禁用(构建不了容器); 需 secrets CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
npm run deploy                       # 备用手动部署: 构建前端 + wrangler deploy (需本地 Docker 构建容器)
```

## Architecture

### 后端 (src/)

```
src/index.ts          → Hono 路由入口，catch-all 转发 ASSETS (run_worker_first 模式)；导出 default(fetch)+CquSessionDO+CquLoginContainer+AuthService(RPC)
src/auth.ts           → Better Auth 配置 (角色: user/admin/superAdmin, RBAC, OAuth 2.1 Provider)；caps 下发(customSession/customAccessTokenClaims)；跨子域 cookie
src/capabilities.ts   → 能力目录(方案A,TS 常量)CAPABILITIES + PRESETS，前后端唯一权威键空间(calendar/eval/cqu)
src/db/schema.ts      → Drizzle schema: cquCredentials, oauthClientCquScopes, userEntitlement(分级权益事实源)
src/services/entitlements.ts → rowsToCaps/resolveCaps(行→caps)、subsystemForAccessToken、validateEntitlementItems/presetToItems(admin 校验)
src/services/service-url.ts → serviceUrl 严格校验(仅 https *.cqu.edu.cn，杜绝 CVE-2022-39369 ST-relay)，返回 canonical href
src/services/st-mint-policy.ts → 纯函数:ST 出票限流(per-user/per-client 窗口)+ distinct-host 告警策略
src/routes/cqu.ts     → GET /api/cqu/service-ticket(取 ST，需 Bearer；?service=key 或 ?serviceUrl=广域)
src/routes/cqu-bind.ts → RESTful 绑定资源 /api/cqu/binding (POST 创建/GET 状态/PUT credentials/GET events WS/DELETE 解绑)
src/routes/admin.ts   → 用户管理、OAuth 客户端 scope 配置、per-user entitlement CRUD+预设 (需 admin/superAdmin)
src/rpc.ts            → AuthService extends WorkerEntrypoint：verifySession + getCaps(离线权益,schedule cron 用) + getCquTicket(拓扑① Service Binding RPC)；getCquTicket/getCaps 共用 authenticateClient(M-6 client_secret 闸)
src/services/cqu-sso.ts → CAS 登录流程、ticket 获取、会话保活(哑层,不做 URL 校验)
src/services/crypto.ts  → AES-256-GCM (凭证加密) + AES-ECB (CQU SSO 密码加密)
src/durable-objects/cqu-session.ts → CQU 会话状态机，15 分钟 alarm keepalive；getServiceTicket 是取票万能闸(host 校验+quicklogin opt-in+限流+审计)
src/middleware/scope.ts → OAuth scope 校验中间件 (JWT 验证 + CQU scope 双重检查；无 Bearer 拒发票)
```

**关键设计**：
- `run_worker_first: true` → Worker 先处理请求，非 API 路由通过 `env.ASSETS.fetch()` 提供前端
- Durable Object 维护 CQU CAS 会话：自动 keepalive + 过期重登录
- CQU SSO 密码用 AES-256-GCM 加密存储在 D1
- Workers fetch CQU SSO 必须用浏览器 User-Agent

### OAuth 2.1 Provider

使用 `@better-auth/oauth-provider`（替代已废弃的 `oidcProvider`）+ `jwt` 插件。
端点前缀 `/api/auth/oauth2/*`，`.well-known` 在 `src/index.ts` 中手动挂载到根路径。
CQU 自定义 scope: `cqu:ticket:{jwxt,jxpj,library,card}` + `cqu:ticket:any`(广域,浏览器插件用,需用户 opt-in)，通过 `oauth_client_cqu_scopes` 表 + scope middleware 双重校验。

### 分级权益 (Entitlements) + 第一方一体化

正交于 per-client 取票安全的 `用户 × 子系统 × 能力` 轴(`user_entitlement` 表为事实源)：
- **能力目录**：`src/capabilities.ts` TS 常量(方案 A)是唯一权威，分 flag(布尔) / quota(数字,null=无限)。预设(PRESETS)只是 admin 一键套用便利，非事实源。
- **caps 下发**：`customSession` 给 SPA 会话注入 caps(排除 `cqu` 伪子系统)；`customAccessTokenClaims`(oauth-provider)按 `client.metadata.subsystem` 给 access token 只盖该片 caps(最小披露，拿不到映射盖空 `{}` 绝不盖全量)。子系统只读 boolean/数字。
- **第一方三拓扑**：① 同账户 `*.cqu.moe` Worker = 跨子域 cookie + Service Binding RPC(`AuthService`)；② `*.cqu.moe` 非 Worker = cookie + JWT；③ 别域/插件 = OAuth+PKCE。跨子域 cookie 靠 `advanced.crossSubDomainCookies{domain:"cqu.moe"}` + `trustedOrigins`。
- **取票万能闸**：route(Bearer+scope) 与 RPC(clientSecret+scope) 两入口都收敛于 `DO.getServiceTicket` —— 它做 serviceUrl host 校验 + `cqu.quicklogin` opt-in(仅广域) + 限流 + 审计。普通符号 key 取票不受 caps/opt-in 影响。
- **接入契约**：见 `docs/subsystem-integration-guide.md`。

### 前端 (frontend/src/)

React 19 + React Router 7 + Tailwind CSS 4 SPA。
`createAuthClient()` 无参数调用 — 默认同源 + `/api/auth` basePath。

页面：Login, Register, ResetPassword, ResetPasswordConfirm, Settings (含 CQU 绑定), Admin, OAuthAuthorize。

### Cloudflare Bindings

| Binding       | 类型              | 用途                    |
|---------------|-------------------|-------------------------|
| DATABASE      | D1                | 用户数据、CQU 凭证       |
| KV            | KV Namespace      | Better Auth 会话缓存     |
| (Resend API)  | env var           | 密码重置/邮箱验证邮件     |
| CQU_SESSION   | Durable Object    | CQU CAS 会话状态         |
| ASSETS        | Static Assets     | 前端 SPA 文件            |

Secrets (via `wrangler secret`): `ENCRYPTION_KEY`, `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `RESEND_API_KEY`

## Gotchas

- `better-auth/react` 的 `createAuthClient()` 不接受相对路径 baseURL，同源部署直接无参调用
- CQU SSO TGT cookie 名是 `SOURCEID_TGC`（不是 `CASTGC`），需要三个 cookie: SOURCEID_TGC + SESSION + rg_objectid
- Workers 中 AES-ECB 加密的 IV 必须传 `""` 而非 `null`
- `frontend/dist/` 在 `.gitignore` 中，部署时由 CI 自动构建
- `withCloudflare()` 源码是 `{ ...options, database, ... }` — `disabledPaths` 等 betterAuth 顶层选项放在第二参数中即可透传
- `drizzle-orm/d1` 是 D1 专用适配器（仅用于 App 自有表 cquCredentials/oauthClientCquScopes）。**Better Auth 自有表（user/session/oauthClient 等）走的是内置 Kysely adapter**（`d1Native: env.DATABASE` → better-auth-cloudflare 直连 Kysely，**不经过 drizzleAdapter**）；操作 Better Auth 表用 `(await auth.$context).adapter.findMany/update/delete({ model: "oauthClient", ... })`。sqlite dialect `supportsJSON/Arrays=false`，数组/json 字段以 JSON 字符串存、读时 `safeJSONParse`
- UI 文字全部使用简体中文
- 更换域名后必须同步更新 `BETTER_AUTH_URL` secret: `echo "https://新域名" | npx wrangler secret put BETTER_AUTH_URL`
- Git commit 使用 1Password SSH 签名，需要 1Password 解锁；报 `1Password: failed to fill whole buffer` 时让用户在终端手动 commit
- `src/index.ts` 末尾的 `app.all("*")` catch-all 是必须的，删除会导致前端 404；路由重构不能丢失这个 fallback
- `@better-auth/oauth-provider` 的客户端 API 用 snake_case (`client_id`)，consent 返回 `{ redirect, url }` 不是 `{ redirectURI }`
- Better Auth CLI (`npx @better-auth/cli generate`) 不支持本项目的函数式 `createAuth(env, req)` 模式，migration 需手写 SQL
- `new Resend(apiKey)` 在构造时校验 key，必须延迟初始化（`getResend()`），否则缺 key 时所有路由 500
- 本地开发需要 `.dev.vars` 文件配置 secrets（`BETTER_AUTH_URL=http://localhost:8787` 等），否则 auth 路由全部 500
- `npm run deploy` 是手动部署的备用方式，常规部署通过 push 到 main 自动触发
- **Better Auth admin 插件自定义 `ac` 时必须 spread `defaultStatements` + 角色 spread `adminAc.statements`**（`better-auth/plugins/admin/access`），否则内置端点（listUsers/setRole/banUser…）缺 `user:["list","set-role",...]` 动作，权限校验全失败抛 FORBIDDEN；而 `auth.api.*` 抛的 APIError 无 try/catch 会被 Hono 兜底成**通用 500**，伪装成"服务器崩溃"。前端路由守卫也要同时放行 `admin` 和 `superAdmin`
- admin 层轮换/直写 OAuth client secret 必须复刻插件 `defaultHasher`（`base64Url.encode(SHA-256(secret), {padding:false})`，存储模式 `"hashed"`，见 `src/utils/oauth-secret.ts`）；插件的 rotate/delete 端点有 `userId===session.user.id` 的 owner 硬校验，admin 用不了，只能走 adapter 直操
- **项目 API 一律 RESTful**：资源名词 + HTTP 方法语义 + 正确状态码（201 创建/204 删除/200 读写）。绑定流程=资源 `/api/cqu/binding`；admin 吊销/恢复=`PATCH /api/admin/users/:id/cqu-binding {status:"revoked"|"active"}`，不用动词端点
- 部署用 **GitHub Actions**（`.github/workflows/deploy.yml`）而非 CF Workers Builds：容器构建需 Docker，CF git-connected Workers Builds 构建不了容器（已禁用）；runner/本地自带 Docker 可构建。push main → 迁移+部署；其他分支 → `versions upload` 0 流量版本
- CF **不为使用 Durable Objects 的 Worker 生成 preview URL** → 分支 `versions upload` 拿不到可点预览链接；要可测分支环境只能另建独立预览 Worker
- DO 可休眠 WebSocket keepalive：`this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping","pong"))`，运行时层直接应答 ping、不唤醒休眠 DO（前端定期发 `"ping"`）
- **迁移一律手写**：`drizzle/migrations` 无 drizzle meta/ 基线(全是手写 wrangler 风格)，`db:generate` 会重生成所有表(含 Better Auth 表)→ 灾难。**App 自有表也手写**下一个编号的 SQL(沿用 `CREATE TABLE IF NOT EXISTS` + 反引号 + `DEFAULT (datetime('now'))`)。schema.ts 加表只为 drizzle 查询类型，不用于生成迁移
- **OAuth access token 盖 caps 用 `customAccessTokenClaims`(oauth-provider)而非 `jwt.definePayload`**：实测 OAuth access token 不经 definePayload,且 definePayload 入参只有 `{user,session}` 无 client_id。`customAccessTokenClaims` 入参 `metadata` = 解析后的 `client.metadata`，按 `metadata.subsystem` 切片;拿不到 subsystem **必须盖空 `{}`**(绝不盖全量,否则泄露完整能力图给 XSS 可达的公开 client)
- **`customSession` 必须放 `plugins` 数组末位**(它内部调 getSession 拿其它插件已组装的 user/session),且返回值**完全替换** get-session 响应体 → 必须显式 `return {user,session,caps}`,否则前端 `data.user/session` 变 undefined;给 SPA 的 caps 要 `delete caps.cqu`(quicklogin 不进 SPA 会话)
- **跨子域 cookie 的 `advanced.crossSubDomainCookies.domain` 必须显式写 `"cqu.moe"`**:省略时默认取 `new URL(baseURL).hostname` = `auth.cqu.moe`(只作用单子域),`*.cqu.moe` 子域收不到 cookie → SSO 静默失效。`trustedOrigins`(顶层,支持通配 `https://*.cqu.moe`)与之正交,换域名时与 `BETTER_AUTH_URL` 一起改
- **取票一律要 Bearer + 经 DO 万能闸**:`scope.ts` 无 Bearer 不再 blanket `next()`(已关 cookie 绕过,cookie-only 取票 401)。取票四道闸(host 校验 / `cqu.quicklogin` opt-in / 限流 / 审计)全落 `DO.getServiceTicket` —— route/RPC/cookie 三入口唯一汇合点。**新增取票入口绝不能直调 `ssoClient.getServiceTicket`**,必须经 `this.getServiceTicket`/DO `service-ticket` action
- **keepalive 现经临时浏览器真铸 ST(不再"只探活不取票"),已纳审计+限流闭合**:浏览器水化取票改造后,keepalive 探活在节点侧 `navigate /login?service=PROBE` **真在 CAS 铸一张可用 ST**(再丢弃),与水化取票同一条路径。故 `runKeepAlive` 的 alive 分支已自行补 `recordKeepaliveMint`:打一条 `st_mint` 审计(`source:"keepalive"`)+ 把这次出票计入 per-user 限流窗口(`stMintLog` 追加 `StMintRecord`)。关键:keepalive 是后台系统探活,**记账但豁免限流拒绝**(不调 `stMintThrottled`——被限流挡掉会破坏会话保鲜);哨兵 `clientId="__keepalive__"` 自成桶,不挤占用户/插件 per-client 配额;`broad:false` 不计入 distinct-broad 告警。**这是"任何新增真实出票动作都必须纳审计+限流闭合"的落实**,勿因 keepalive 是内部探针就漏掉
- **storageState(完整 CAS 会话凭证)明文存 DO storage,非 D1、非应用层 AES-GCM**:浏览器水化取票需完整 `storage_state`(实测 12 cookie 含 `SOURCEID_TGC` + 2 origin 的 localStorage),它存在 **DO storage**(`ctx.storage.put("state", SessionState)` 的 `storageState` 字段,structured-clone),**不入 D1**——`cquCredentials` 表只有 `encryptedPassword`+`iv`,从无 cookie/state 列。state 在应用层**明文**(`crypto.ts` 的 AES-256-GCM 只加密 D1 里的 SSO 密码),落盘前只有 `putStateGuarded` 一道 128KiB 体量守卫。**这是已知接受项**:DO storage 受 CF 平台层静态加密 + 账户访问控制,同一 Worker 同时持 `ENCRYPTION_KEY` 与 DO storage 句柄使应用层再加密增益边际,且明文存 DO storage **非本分支引入**(`main` 同样明文存 TGT/3-cookie),本分支只把体量从 3-cookie 放大到完整 state
- **取票/keepalive 出站经节点有第二层 host 校验 + `NODE_DEADLINE_MS` 超时**:`DO.getServiceTicket` 的 serviceUrl host 红线(仅 https `*.cqu.edu.cn`)是 canonical 事实源;节点 `/service-ticket` 另有 `is_allowed_service_url`(同策略,对齐 `service-url.ts`)作**纵深第二层**校验(防 VPC 误配/将来新增直连调用方绕过红线 → CVE-2022-39369 式 ST-relay)。DO→节点的 `/service-ticket`、`/keepalive` 出站 fetch 都套 `AbortSignal.timeout(NODE_DEADLINE_MS=90s,对齐节点最坏 ~80s)`,防节点 backlog 时阻塞 DO 单线程;超时归 transient(退避不误判过期)。**`/run`(登录含 2FA 邮件往返可达数分钟)刻意不套此短超时**
- **RPC `AuthService.getCquTicket` 必须验 `client_secret`(M-6)**:RPC 进程内调用,任一被绑定 Worker 都能自报任意 clientId,故强制 `hashOAuthClientSecret` 比对(constant-time);否则只返回 `{error:"INVALID_CLIENT"}`。单 Worker 可同时 `export default`(Hono fetch) + `export class extends WorkerEntrypoint` + DO 具名导出(本仓 index.ts 已验证共存)
- **entitlement 写权限是 superAdmin only**:`statement` 加 `entitlement:["assign","revoke"]`(仍 spread `defaultStatements`),只 spread 进 `superAdmin` 角色(`admin` 不给);admin entitlement 写路由额外过 `auth.api.userHasPermission({entitlement:[...]})`,不能只靠角色中间件
