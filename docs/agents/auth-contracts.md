# 认证与数据约定

## Better Auth 与角色

- Better Auth 自有表走 `withCloudflare` 的 `d1Native` / Kysely adapter；应用自有表走 `drizzle-orm/d1`。修改 OAuth client 等自有表时用 `auth.$context` 的 adapter；SQLite 中数组/JSON 按字符串存取。
- 自定义 admin access control 保留 `defaultStatements` 与相应 `adminAc.statements`，否则插件内置动作会返回 FORBIDDEN。前端管理入口同时处理 admin 与 superAdmin。
- 权益写入仅限 superAdmin，路由还需校验 `entitlement` 的 assign/revoke 权限。
- 管理员直写 OAuth client secret 复用 `src/utils/oauth-secret.ts` 的哈希；插件 rotate/delete 的 owner 检查不能代替管理员权限判断。
- `withCloudflare` 的 Better Auth 顶层选项放在第二参数中；`createAuth(env, req)` 为函数式配置，迁移按根 AGENTS.md 手写。

## OAuth 与权益

- `shared/capabilities.ts` 是能力键与预设的定义；`user_entitlement` 行是用户权益事实源，预设只用于赋值。
- OAuth access token 的能力使用 `customAccessTokenClaims`，按客户端 subsystem 最小披露；没有映射时不披露能力，不能返回全量。`jwt.definePayload` 不是 OAuth access token 的注入点。
- `customSession` 位于插件数组末尾，显式返回 `{user, session, caps}`，SPA caps 排除 `cqu`。
- OAuth 客户端 API 使用 snake_case（如 `client_id`），consent 响应读取 `{redirect, url}`。
- 中央 Auth 使用 host-only cookie，第一方应用各自持有隔离会话；保持 `isolatedAuthCookies` 与精确来源边界，不能恢复跨子域会话共享。迁移按 [会话隔离 ADR](../adr/0002-first-party-session-isolation.md) 和 [切换清单](../auth-cutover.md) 执行。
- Service Binding RPC 验证服务凭证、允许的业务操作和目标用户状态；自报 clientId 不构成身份凭证，私有 RPC 不等于任意 userId 授权。遵循 [服务身份 ADR](../adr/0009-private-rpc-service-identity.md)。

## 安全能力与生命周期

会话、verification 和限流以 D1 为事实源。变更设备退出、改密或撤销时读 [设备生命周期](../device-session-lifecycle.md)；变更 Passkey 或账号恢复时分别读 [Passkey](../passkey.md) 和 [账号恢复](../account-recovery.md)，并读取对应 ADR。
