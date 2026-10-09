# Auth 升级任务与依赖

父规格：[cqu-moe/auth #41](https://github.com/cqu-moe/auth/issues/41)。已创建并核对十个子 Issue（#42–#51），均使用 ready-for-agent；复用 #36、#37 作为已有依赖，不重复建漏洞票，不修改它们的正文或状态。父规格正文和状态也保持不变，只建立子问题关系。

每票交付一个可验证的业务行为，并包含对应持久化、协议/后端、必要界面与测试。[#42](https://github.com/cqu-moe/auth/issues/42) 是升级后实际登录/OAuth 的基线，[#51](https://github.com/cqu-moe/auth/issues/51) 是完成旧 Cookie 退役的收口，均不是仅修改配置或仅跑测试。

1. **[#42](https://github.com/cqu-moe/auth/issues/42) 升级与 D1 登录基线**。依赖：无。交付：现有登录、会话和 PKCE/OAuth 在新框架与无 KV 的 D1 下完整运行。[正文](./auth-security-upgrade-tickets/01-d1-auth-baseline.md)
2. **[#43](https://github.com/cqu-moe/auth/issues/43) 近期认证与管理员门禁**。依赖：[#42](https://github.com/cqu-moe/auth/issues/42)。交付：五分钟敏感操作验证、管理员强认证及邮箱第二因子退役。[正文](./auth-security-upgrade-tickets/02-sensitive-authentication.md)
3. **[#44](https://github.com/cqu-moe/auth/issues/44) Passkey**。依赖：[#43](https://github.com/cqu-moe/auth/issues/43)。交付：多个 Passkey 的添加、登录、再次验证和删除，服务端强制 UV。[正文](./auth-security-upgrade-tickets/03-passkey.md)
4. **[#45](https://github.com/cqu-moe/auth/issues/45) 设备访问撤销**。依赖：[#42](https://github.com/cqu-moe/auth/issues/42)、现有 #36。交付：全设备退出、改密/找回后的设备失效与后台继续，并提供应用可消费的退出契约。[正文](./auth-security-upgrade-tickets/04-device-revocation.md)
5. **[#46](https://github.com/cqu-moe/auth/issues/46) 管理员随机密码重置**。依赖：[#44](https://github.com/cqu-moe/auth/issues/44)、[#45](https://github.com/cqu-moe/auth/issues/45)。交付：一次作废全部旧认证并返回新密码，正常登录，后台继续。[正文](./auth-security-upgrade-tickets/05-admin-reset.md)
6. **[#47](https://github.com/cqu-moe/auth/issues/47) 可选 DPoP**。依赖：[#42](https://github.com/cqu-moe/auth/issues/42)。交付：选择启用的客户端完成签发、刷新、资源验证与多实例防重放，Bearer 兼容。[正文](./auth-security-upgrade-tickets/06-optional-dpop.md)
7. **[#48](https://github.com/cqu-moe/auth/issues/48) RPC 统一业务授权**。依赖：[#42](https://github.com/cqu-moe/auth/issues/42)。交付：保留服务身份与 userId 调用，Auth 集中拒绝不合权限、用户状态或绑定条件的请求。[正文](./auth-security-upgrade-tickets/07-rpc-authorization.md)
8. **[#49](https://github.com/cqu-moe/auth/issues/49) Schedule 独立会话迁移**。依赖：[#45](https://github.com/cqu-moe/auth/issues/45)、[#48](https://github.com/cqu-moe/auth/issues/48)。交付：课表端中央登录、本站会话、单站退出与后台同步完整运行。[正文](./auth-security-upgrade-tickets/08-schedule-session.md)
9. **[#50](https://github.com/cqu-moe/auth/issues/50) UC 独立会话迁移**。依赖：[#45](https://github.com/cqu-moe/auth/issues/45)。交付：在用 UC 的独立登录会话与退出，保留资源/文件权限。[正文](./auth-security-upgrade-tickets/09-uc-session.md)
10. **[#51](https://github.com/cqu-moe/auth/issues/51) 中央 Cookie 收口与联合验收**。依赖：[#46](https://github.com/cqu-moe/auth/issues/46)、[#47](https://github.com/cqu-moe/auth/issues/47)、[#49](https://github.com/cqu-moe/auth/issues/49)、[#50](https://github.com/cqu-moe/auth/issues/50)、现有 #37。交付：所有在用消费者准备后退役根域 Cookie，完成跨应用撤销、迁移与回滚条件验证。[正文](./auth-security-upgrade-tickets/10-cutover-and-acceptance.md)

## 依赖的理由

- [#43](https://github.com/cqu-moe/auth/issues/43)/[#47](https://github.com/cqu-moe/auth/issues/47)/[#48](https://github.com/cqu-moe/auth/issues/48) 消费升级后的框架及存储契约；它们之间没有人为串行依赖。
- [#44](https://github.com/cqu-moe/auth/issues/44) 复用 [#43](https://github.com/cqu-moe/auth/issues/43) 的实际近期认证规则；[#46](https://github.com/cqu-moe/auth/issues/46) 需要已实现的 Passkey 和设备撤销，才能证明旧认证确实全部失效。
- [#45](https://github.com/cqu-moe/auth/issues/45) 复用 #36 对现存 token 的权威状态检查，再完成不同设备事件的撤销范围。
- 两个第一方迁移任务消费 [#45](https://github.com/cqu-moe/auth/issues/45) 的退出契约，可以并行；Schedule 还需要以 [#48](https://github.com/cqu-moe/auth/issues/48) 的后台授权验证“设备退出但同步继续”。
- [#51](https://github.com/cqu-moe/auth/issues/51) 等待各功能分支及消费者准备好才移除旧 Cookie；#37 是学校解绑联合验收的现有前置问题。
- #36/#37 不因本次框架升级被强行添加新阻塞关系；若已有人在处理，可以继续独立修复。本次只让需要它们的任务等待。

## 核查依据与边界

- 父规格完整正文及评论已读取：本次核查时评论数为零，尚无子 Issue。
- 已核对 Schedule 的共享 Cookie + Auth RPC 接入；UC 本地存在同类接入，但 checkout 指向旧仓库，因此 [#50](https://github.com/cqu-moe/auth/issues/50) 明确先确认现行部署，不盲改退役代码。
- 本次未发现 jxpj/wag 的同类中央认证调用，不能仅凭同属第一方就安排无依据迁移；最终消费者清单仍是 [#51](https://github.com/cqu-moe/auth/issues/51) 的切换门槛。
- QuickLogin 已是 OAuth/PKCE 客户端，设备撤销由 [#45](https://github.com/cqu-moe/auth/issues/45) 覆盖、可选 DPoP 由 [#47](https://github.com/cqu-moe/auth/issues/47) 覆盖，不另开强制 DPoP 迁移票。
- 本组任务仅移除 Auth 的 KV，不自动删除 Schedule 的业务缓存或改变其无关数据缓存策略；当前授权时效须按父规格独立验证。
- 已按用户确认的粒度发布，使用 GitHub 原生 sub-issue 与 blocked-by 关系。十个子问题、十六条依赖、全部正文与标签均已读回核对；父规格及 #36/#37 的正文、标题和状态保持不变。
