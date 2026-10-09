## Parent

[Auth 安全与第一方接入升级 #41](https://github.com/cqu-moe/auth/issues/41)

## What to build

让选择 DPoP 的 OAuth 客户端完成签发、刷新及资源访问的密钥绑定和防重放，同时保持未启用 DPoP 的合法 Bearer 客户端可用。本票提供真实互操作能力，不强制迁移全部客户端，也不改变私有 Worker RPC。

## Acceptance criteria

- [ ] 注册与资源策略能够表达可选 DPoP，签发包含正确的绑定信息；refresh 必须证明持有同一密钥，S256 PKCE 仍生效。
- [ ] 相关资源入口使用按真实 Request 验证的框架能力，覆盖签名、key、method、公开 URL、iat、jti、ath 及 token 原有的 issuer/audience/scope 检查。
- [ ] 已绑定 token 的缺失 proof、错 key、错请求绑定、重复 proof、refresh 换 key 和 Bearer 降级全部拒绝；不能通过另一个旧验证入口绕过。
- [ ] AS 与 RS 的 replay store 覆盖多实例，优先使用原生 D1 verification 原子占位；并发重复 proof 最多一次成功，过期记录有清理行为。
- [ ] 公开 URL 与内部路由重写不造成绕过或误拒；认证头脱敏覆盖 DPoP 访问令牌与必要的敏感材料。
- [ ] 真实标准客户端完成一条 DPoP 登录/刷新/访问链路，未绑定 Bearer 仍能完成同类合法业务调用；状态撤销策略不因 DPoP 被绕过。
- [ ] 接入说明覆盖 opt-in、密钥持久化及丢失后重新登录；不新建通用 SDK、nonce 服务，不把 DPoP 当作 Passkey/MFA 或业务授权的替代。
