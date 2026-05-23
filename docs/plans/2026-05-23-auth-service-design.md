# auth.cqu.moe 认证服务设计文档

## 概述

为 cqu.moe 生态提供统一的用户认证、权限管理和 CQU 统一认证代理服务。所有子应用（schedule、评教等）通过 OAuth 2.0 接入，auth 服务集中管理用户身份和 CQU SSO 会话。

## 技术栈

| 组件 | 选型 |
|---|---|
| Runtime | Cloudflare Workers (Hono) |
| 数据库 | Cloudflare D1 (SQLite) + Drizzle ORM |
| 认证框架 | Better Auth + better-auth-cloudflare 适配器 |
| 前端 | React (Vite SPA) + shadcn/ui + Tailwind CSS |
| 邮件 | Cloudflare Email Service (`env.EMAIL.send()` binding) |
| CQU 会话管理 | Durable Object (per-user) |
| 加密 | AES-256-GCM (Web Crypto API) |

## 架构

```
                    ┌─────────────────────────────────────────────┐
                    │           auth.cqu.moe (Workers)            │
                    │                                             │
  React SPA ◄──────┤  Hono API Server                            │
  (静态资源)        │  ├── /api/auth/*     Better Auth 路由       │
                    │  ├── /api/cqu/*      CQU 凭证管理 API      │
                    │  ├── /api/admin/*    管理员 API             │
                    │  └── /api/oauth/*    OIDC Provider          │
                    │                                             │
                    │  Bindings:                                  │
                    │  ├── DATABASE (D1)    用户/角色/OAuth 数据  │
                    │  ├── EMAIL            Cloudflare Email      │
                    │  ├── CQU_SESSION (DO) CQU SSO 会话管理     │
                    │  └── ENCRYPTION_KEY   加密密钥 (Secret)     │
                    └─────────────────────────────────────────────┘
                              ▲                    ▲
                              │ OAuth 2.0 PKCE     │ DO.fetch()
                              │                    │
                    ┌─────────┴──────┐   ┌────────┴────────┐
                    │ schedule.cqu.moe│   │  CQU SSO        │
                    │ jxpj.cqu.moe   │   │ (sso.cqu.edu.cn)│
                    │ 其他消费方      │   │                  │
                    └────────────────┘   └─────────────────┘
```

### 数据存储分工

| 存储 | 内容 |
|---|---|
| D1 | 用户账号、密码哈希、角色权限、OAuth 客户端及 scope 授权、sessions、加密的 CQU 账号密码 |
| Durable Object | CQU CAS cookie jar（内存）、TGT 状态、alarm 续活调度 |
| Cloudflare Email | 注册验证邮件、密码重置邮件 |

## 消费方接入

### OAuth 2.0 Authorization Code + PKCE

消费方（如 schedule-cloudflare）通过标准 OAuth 流程接入：

1. 用户在消费方前端点"登录" → 跳转 `auth.cqu.moe/api/oauth/authorize`
2. 用户在 auth.cqu.moe 登录（邮箱 + 密码）
3. 授权页展示请求的 scope → 用户同意
4. 回调到消费方 → 消费方后端用 code 换 `access_token` + `refresh_token`
5. 后续 API 调用携带 `Authorization: Bearer <access_token>`

### Service Binding（可选）

Cloudflare Workers 消费方可通过 Service Binding 直接调用 auth Worker，走内部网络：

```jsonc
// 消费方 wrangler.jsonc
{ "services": [{ "binding": "AUTH", "service": "auth-cqu-moe" }] }
```

## CQU SSO 会话管理

### 核心机制

auth 服务充当 CQU SSO 会话中心，统一维护用户的 CAS 会话，按需为消费方出 Service Ticket。

### CQU SSO Cookie 结构（2026-05-23 实测）

| Cookie | 域 | 类型 | 用途 |
|---|---|---|---|
| `SOURCEID_TGC` | sso.cqu.edu.cn | httpOnly, session | TGT 凭证（JWT wrapping JWE，不是文档中的 CASTGC） |
| `SESSION` | sso.cqu.edu.cn | httpOnly, secure, session | SSO session |
| `rg_objectid` | sso.cqu.edu.cn | httpOnly, session | 加密的 objectId |

**SOURCEID_TGC 结构**：外层 JWT (HS512) 包裹内层 JWE (A128CBC-HS256 + DEFLATE 压缩)。内容加密，对我们不透明——只需原样存储和回传。

**过期方式**：Session cookie（无固定过期时间），服务端管理。

> ⚠️ **TODO: 实测 SOURCEID_TGC 实际超时行为**
> - idle timeout 具体多久？
> - hard timeout 是否存在？
> - `/onlineCheck` 是否重置 idle timer？
> - 出 ST 是否确认重置 idle timer？
> - 测试方法：登录后定时 `/onlineCheck` 探活，记录首次 401 的时间

### Durable Object 状态

```typescript
interface CquSessionState {
  userId: string;
  studentId: string;

  // CAS 会话核心 — 3 个 cookie (sso.cqu.edu.cn)
  cookies: {
    SOURCEID_TGC: string;  // JWT, TGT 凭证
    SESSION: string;        // SSO session
    rg_objectid: string;    // 加密 objectId
  };

  // /getUser 返回的身份信息
  objectId: string;         // LinkID 账号 ID
  tgt: string;              // TGT 全文 (如 "TGT-18421-...")

  // 状态追踪
  lastKeepAlive: number;    // 上次续活时间戳
  lastRequestedAt: number;  // 上次被消费方请求 ST 的时间
  status: 'active' | 'expired' | 'error';
}
```

### 续活机制

```
DO alarm 触发 (每 15 分钟)
  │
  ├─ GET /login?service=<dummy> + cookies (redirect: manual)
  │  → 出一张 ST = TGT 被"使用"，大概率重置 idle timer
  │
  ├─ 302 + ST? ─── ✅ TGT 有效，已续活 → 丢弃 ST，设下次 alarm
  │
  └─ 200 (登录页)? ── ❌ TGT 过期
                        → 从 D1 读加密密码
                        → GET /login 拿 execution + croypto
                        → POST /login 加密密码登录
                        → 更新 DO cookie 状态
                        → 失败? → status='error'
```

### 出 Service Ticket 流程

```
消费方: GET /api/cqu/service-ticket?service=jwxt
Authorization: Bearer <access_token with cqu:ticket:jwxt scope>

auth Worker:
  1. 验证 access_token 有效性
  2. 检查 token 包含 cqu:ticket:jwxt scope
  3. 路由到该用户的 CquSessionDO
  4. DO 用存储的 cookie 请求:
     GET sso.cqu.edu.cn/login?service=<jwxt_service_url> (redirect: manual)
  5. 从 302 Location 提取 ticket=ST-xxx
  6. 返回 ST 给消费方
```

## 安全：CQU Scope 权限控制

### Scope 设计

```
cqu:ticket:jwxt      # 教务网
cqu:ticket:jxpj      # 教学评价
cqu:ticket:library    # 图书馆
cqu:ticket:card       # 校园卡
cqu:ticket:*          # 所有子系统（谨慎授予）
```

### 验证流程

1. OAuth 客户端注册时，管理员指定允许的 CQU scope
2. 用户授权时，授权页展示请求的 scope
3. access_token 编码已授权的 scope
4. `/api/cqu/service-ticket` 端点检查 token 是否包含对应的 `cqu:ticket:<subsystem>` scope

### 管理员面板

管理员可在面板中为每个 OAuth 客户端精确配置可访问的 CQU 子系统。

## 数据模型

### Better Auth 管理的表

由 Better Auth + OIDC Provider plugin + Admin plugin 自动生成：
- `users` — 用户账号
- `sessions` — 登录会话
- `accounts` — 认证方式（email/password）
- `verifications` — 邮箱验证 token
- `oauth_applications` — OAuth 客户端
- `oauth_access_tokens` — OAuth access token
- `oauth_consents` — 用户授权记录

### 自定义表

```sql
-- CQU 凭证（加密存储）
CREATE TABLE cqu_credentials (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    student_id TEXT NOT NULL,
    encrypted_password TEXT NOT NULL,  -- AES-256-GCM
    iv TEXT NOT NULL,
    bound_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_login_at TEXT,
    status TEXT NOT NULL DEFAULT 'active'
);

-- OAuth 客户端 CQU scope 授权
CREATE TABLE oauth_client_cqu_scopes (
    client_id TEXT NOT NULL REFERENCES oauth_applications(id) ON DELETE CASCADE,
    scope TEXT NOT NULL,  -- 如 'cqu:ticket:jwxt'
    PRIMARY KEY (client_id, scope)
);
```

## RBAC 权限模型

```typescript
const statement = {
  user: ["read", "ban", "unban", "delete"],
  oauthClient: ["create", "read", "update", "delete"],
  cquScope: ["assign", "revoke"],
  auditLog: ["read"],
  role: ["assign", "revoke"],
} as const;

const ac = createAccessControl(statement);

const roles = {
  user: ac.newRole({}),
  admin: ac.newRole({
    user: ["read", "ban", "unban"],
    oauthClient: ["read"],
    auditLog: ["read"],
  }),
  superAdmin: ac.newRole({
    user: ["read", "ban", "unban", "delete"],
    oauthClient: ["create", "read", "update", "delete"],
    cquScope: ["assign", "revoke"],
    auditLog: ["read"],
    role: ["assign", "revoke"],
  }),
};
```

## CQU CAS 登录实现

直接在 auth 服务中实现（不依赖 cqu-sdk），参考 schedule-cloudflare 已验证的流程。

### 登录流程

1. `GET sso.cqu.edu.cn/login?service=<url>` — 提取 `execution`、`croypto`、`captchaId`
2. 用 `croypto` 作为 AES-ECB 密钥加密密码
3. `POST sso.cqu.edu.cn/login` — 提交 `username`、加密 `password`、`execution`、`croypto`、`captcha_payload`(加密的`"{}"`)
4. 成功 → 302 + `SOURCEID_TGC` cookie + ST
5. 失败 → 401 + 错误页面

### 注意事项

- 密码加密密钥 (`croypto`) 每次页面加载不同，不可缓存
- `execution` 与 session 绑定，不可跨会话复用
- Workers fetch 需带浏览器 User-Agent，否则被 SSO 拦截
- AES-ECB 在 Workers 中 IV 须传 `""` 而非 `null`
- 连续失败触发验证码 — 需妥善处理重试逻辑

## 前端页面

### 路由

| 路由 | 功能 |
|---|---|
| `/login` | 邮箱 + 密码登录 |
| `/register` | 注册（邮箱验证） |
| `/reset-password` | 密码重置 |
| `/oauth/authorize` | OAuth 授权页 |
| `/settings` | 个人设置（CQU 绑定、修改密码） |
| `/admin` | 管理面板（用户管理、OAuth 客户端、scope 配置） |

## 项目结构

```
auth/
├── src/
│   ├── index.ts                 # Hono 入口 + 路由挂载
│   ├── auth.ts                  # Better Auth 配置（OIDC + RBAC）
│   ├── db/
│   │   └── schema.ts            # Drizzle schema
│   ├── routes/
│   │   ├── cqu.ts               # CQU 凭证管理 + 出 ST
│   │   ├── admin.ts             # 管理员 API
│   │   └── oauth.ts             # OIDC 相关路由
│   ├── services/
│   │   ├── cqu-sso.ts           # CQU CAS 登录实现
│   │   └── crypto.ts            # AES-256-GCM 加解密
│   ├── durable-objects/
│   │   └── cqu-session.ts       # CQU SSO 会话 DO
│   └── types.ts                 # Env 接口
├── frontend/                    # React SPA (Vite)
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Login.tsx
│   │   │   ├── Register.tsx
│   │   │   ├── ResetPassword.tsx
│   │   │   ├── Settings.tsx
│   │   │   ├── OAuthAuthorize.tsx
│   │   │   └── Admin.tsx
│   │   └── ...
│   └── ...
├── wrangler.jsonc
├── drizzle.config.ts
└── package.json
```

## API 设计

### CQU 凭证管理

```
POST   /api/cqu/bind              # 绑定 CQU 账号（学号 + 密码）
DELETE /api/cqu/bind              # 解绑 CQU 账号
GET    /api/cqu/status            # 查询绑定状态和会话健康度
GET    /api/cqu/service-ticket    # 获取 Service Ticket
         ?service=jwxt|jxpj|...   # 目标子系统
```

### 管理员 API

```
GET    /api/admin/users           # 用户列表（分页）
GET    /api/admin/users/:id       # 用户详情
PATCH  /api/admin/users/:id       # 修改用户（ban/unban/角色）
GET    /api/admin/oauth-clients   # OAuth 客户端列表
POST   /api/admin/oauth-clients   # 创建 OAuth 客户端
PATCH  /api/admin/oauth-clients/:id          # 修改客户端
PUT    /api/admin/oauth-clients/:id/scopes   # 配置 CQU scope
```

### 错误响应格式

统一格式，与 schedule-cloudflare 保持一致：

```json
{
  "detail": {
    "error": {
      "code": "SCOPE_INSUFFICIENT",
      "message": "缺少 cqu:ticket:jwxt scope"
    }
  }
}
```
