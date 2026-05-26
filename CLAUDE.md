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
npm run db:generate                  # 从 schema.ts 生成 migration
npm run db:migrate:local             # 本地 D1 执行 migration

# 测试
npm run test                         # vitest (Cloudflare Workers pool)

# 部署 (GitHub 连接 Cloudflare，push 到 main 自动构建部署)
npm run deploy                       # 手动部署: 构建前端 + wrangler deploy
```

## Architecture

### 后端 (src/)

```
src/index.ts          → Hono 路由入口，catch-all 转发 ASSETS (run_worker_first 模式)
src/auth.ts           → Better Auth 配置 (角色: user/admin/superAdmin, RBAC, OAuth 2.1 Provider)
src/db/schema.ts      → Drizzle schema: cquCredentials, oauthClientCquScopes
src/routes/cqu.ts     → CQU 绑定/解绑/状态/service-ticket
src/routes/admin.ts   → 用户管理、OAuth 客户端 scope 配置 (需 admin 角色)
src/services/cqu-sso.ts → CAS 登录流程、ticket 获取、会话保活
src/services/crypto.ts  → AES-256-GCM (凭证加密) + AES-ECB (CQU SSO 密码加密)
src/durable-objects/cqu-session.ts → CQU 会话状态机，15 分钟 alarm keepalive
src/middleware/scope.ts → OAuth scope 校验中间件 (JWT 验证 + CQU scope 双重检查)
```

**关键设计**：
- `run_worker_first: true` → Worker 先处理请求，非 API 路由通过 `env.ASSETS.fetch()` 提供前端
- Durable Object 维护 CQU CAS 会话：自动 keepalive + 过期重登录
- CQU SSO 密码用 AES-256-GCM 加密存储在 D1
- Workers fetch CQU SSO 必须用浏览器 User-Agent

### OAuth 2.1 Provider

使用 `@better-auth/oauth-provider`（替代已废弃的 `oidcProvider`）+ `jwt` 插件。
端点前缀 `/api/auth/oauth2/*`，`.well-known` 在 `src/index.ts` 中手动挂载到根路径。
CQU 自定义 scope: `cqu:ticket:{jwxt,jxpj,library,card}`，通过 `oauth_client_cqu_scopes` 表 + scope middleware 双重校验。

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
- `drizzle-orm/d1` 是 D1 专用适配器
- UI 文字全部使用简体中文
- 更换域名后必须同步更新 `BETTER_AUTH_URL` secret: `echo "https://新域名" | npx wrangler secret put BETTER_AUTH_URL`
- Git commit 使用 1Password SSH 签名，需要 1Password 解锁；报 `1Password: failed to fill whole buffer` 时让用户在终端手动 commit
- `src/index.ts` 末尾的 `app.all("*")` catch-all 是必须的，删除会导致前端 404；路由重构不能丢失这个 fallback
- `@better-auth/oauth-provider` 的客户端 API 用 snake_case (`client_id`)，consent 返回 `{ redirect, url }` 不是 `{ redirectURI }`
- Better Auth CLI (`npx @better-auth/cli generate`) 不支持本项目的函数式 `createAuth(env, req)` 模式，migration 需手写 SQL
- `new Resend(apiKey)` 在构造时校验 key，必须延迟初始化（`getResend()`），否则缺 key 时所有路由 500
- 本地开发需要 `.dev.vars` 文件配置 secrets（`BETTER_AUTH_URL=http://localhost:8787` 等），否则 auth 路由全部 500
- `npm run deploy` 是手动部署的备用方式，常规部署通过 push 到 main 自动触发
