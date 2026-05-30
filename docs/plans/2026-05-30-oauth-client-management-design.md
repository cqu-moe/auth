# OAuth 客户端管理 — 设计文档

- 日期：2026-05-30
- 状态：已确认，待实现
- 范围：在 admin 后台为 superAdmin/admin 提供完整的 OAuth 客户端管理（新建 / 编辑配置 / 删除 / 轮换密钥），替代当前"只能分配 CQU scope"的受限界面。

## 背景

当前 admin 控制台的 OAuth 客户端区只实现了 CQU scope 勾选 + 保存（`PUT /api/admin/oauth-clients/:id/scopes`）。
没有任何入口创建客户端、编辑客户端配置（名称 / 回调 URI / 密钥 / 授权类型）或删除客户端。
底层能力在 `@better-auth/oauth-provider` 插件已具备，缺的是项目这一层的路由 + UI。

## 关键技术约束（已核实源码）

- `adminCreateOAuthClient`（`/admin/oauth2/create-client`）、`adminUpdateOAuthClient`（`/admin/oauth2/update-client`）是 **`SERVER_ONLY`**：只能服务端 `auth.api.*` 调用，不能浏览器直连。
- **secret 哈希存储**：`storeClientSecret` 默认 = `disableJwtPlugin ? "encrypted" : "hashed"`；项目启用 `jwt()` 插件且未禁用 → `"hashed"`。**明文不可回显**，只能轮换。
- `client_secret` **仅在创建时返回一次**。
- `deleteClientEndpoint` / `rotateClientSecretEndpoint` 内部有 `client.userId === session.user.id` 的 owner 硬校验，**没有 admin 版**。
  → admin 删除 / 轮换需在 admin 层直接走 adapter，不能用插件这两个 owner 限定端点。
- `oauth_client_cqu_scopes` 表按**公开 `client_id`** 关联（与 scope 中间件 `payload.azp ?? payload.client_id` 对齐）。

## 设计决策（与用户对齐）

1. **字段渐进展开**：表单默认显示精简实用集，提供「展开完整配置」露出 RFC 7591 全集。
2. **密钥不回显 + 可重置**：编辑表单不显示旧 secret；提供「重新生成密钥」轮换，新 secret 弹出展示一次。
3. **方案 A**：包装插件 SERVER_ONLY admin 端点做 create/update；delete/rotate 在 admin 层走 adapter。复用底层密钥哈希 / 回调校验 / 字段规范，不重造轮子。

## 后端路由（`src/routes/admin.ts`，均过 admin 中间件）

| 方法 | 路由 | 实现 |
|---|---|---|
| GET | `/oauth-clients` | 已有，全量列表 |
| POST | `/oauth-clients` | `auth.api.adminCreateOAuthClient` → 返回 `client_id` + `client_secret`（仅一次） |
| PATCH | `/oauth-clients/:id` | `auth.api.adminUpdateOAuthClient` |
| POST | `/oauth-clients/:id/rotate-secret` | adapter：生成新 secret → 复用插件 secret 存储（哈希）→ update，返回新 secret 一次 |
| DELETE | `/oauth-clients/:id` | adapter 删 `oauthClient` 行 + 级联删 `oauth_client_cqu_scopes` |
| GET / PUT | `/oauth-clients/:id/scopes` | 已有，CQU scope |

所有新 handler 包 try/catch，把插件抛的 `APIError` 转成规范 JSON（顺手消灭"异常冒泡成 500"的隐患）。

### 精简区字段
名称（`client_name`）、回调 URI（`redirect_uris`，多条）、允许的 scope、授权类型（`grant_types`）、客户端类型（`type`：web/native/user-agent-based）、跳过同意页（`skip_consent`）。

### 完整配置区字段
`client_uri`、`logo_uri`、`tos_uri`、`policy_uri`、`contacts`、`require_pkce`、`token_endpoint_auth_method`、`response_types`、`post_logout_redirect_uris`、`metadata`。

## 前端 UI（`frontend/src/pages/Admin.tsx` OAuth tab）

- 客户端列表 + 右上「新建客户端」。
- 点客户端 / 新建 → 编辑抽屉（或弹窗）：
  - 精简区（默认） + 「展开完整配置」。
  - **CQU 服务权限区**：现有 scope 勾选框收编进编辑器（复用 `/scopes` 端点）。
  - **密钥区**：不回显，「重新生成密钥」按钮（轮换后弹新 secret 一次，可复制）。
  - **删除**：二次确认。
- 创建成功 → 弹出 `client_id` + `client_secret`（复制按钮 + "仅显示一次"警示）。

## 数据流

浏览器 fetch → `admin.ts`（role 校验）→ 服务端 `auth.api.*` / adapter → D1。
secret 全程哈希存储，前端永不持有旧 secret。

## 错误处理

redirect_uri 非法、scope 越界、client 不存在等 → 后端返结构化错误码，前端就地提示。

## 测试

vitest 覆盖新路由 create / update / rotate / delete 正常流 + 权限（superAdmin 通过、普通 user 403）。

## 待实现阶段确认的细节

- rotate 在 admin 层的具体落地：复用插件内部 `storeClientSecret` 哈希函数是否可从包外调用；若不可，备选为创建时把 `userId` 记为操作管理员以复用 `rotateClientSecret`，或在 admin 层复制 generate+hash+update 逻辑。
- 编辑抽屉 vs 弹窗的具体交互形态。
