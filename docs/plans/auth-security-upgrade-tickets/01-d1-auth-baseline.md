## Parent

[Auth 安全与第一方接入升级 #41](https://github.com/cqu-moe/auth/issues/41)

## What to build

升级 Better Auth 及配套包，让现有注册、密码/TOTP 登录、会话查询与 OAuth 授权码流程在无 KV 的 D1 环境中完整工作。交付可运行的升级基线，而不是仅更新依赖。保留持久账号、学校绑定、权益、必要客户端数据及稳定 issuer。

## Acceptance criteria

- [ ] 核对实施时的稳定版本与 Cloudflare 适配器兼容性，前后端相关包一致；不把研究时的 1.7.7 当永久最新版本。
- [ ] 移除 Auth 的 KV 注入与绑定，session/verification 使用 D1、cookie cache 关闭；数据库限流有真实 schema 且能拒绝超限请求，不回退成无操作或实例内 Map。
- [ ] 沿用手写顺序 SQL 迁移，核对 OAuth 客户端字段和资源模型；迁移现有数据后账号、绑定、权益与客户端仍可用，不重建全库或更换业务 ORM。
- [ ] 注册、密码及 TOTP 登录、会话查询/删除、OAuth consent 与 refresh 的既有正常行为通过 HTTP 集成验证；正式 discovery 和 issuer 保持连续。
- [ ] 授权码流程强制 S256 PKCE，缺失/错误 verifier、非 S256、错误回调或登录事务被拒；合法客户端不会被误伤。
- [ ] 在 workerd/测试 D1 下验证授权码并发单次消费、验证码时效、限流并发与过期 verification 清理；不能以配置字符串或串行内存测试替代。
- [ ] 更新受影响的客户端管理、配置及集成说明；允许一次重新登录/连接，但本票不切换所有站点 Cookie，也不新增 API/MCP 平台。
