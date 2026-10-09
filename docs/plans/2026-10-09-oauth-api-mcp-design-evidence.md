# OAuth、第一方应用与 API / MCP 设计依据

核查日期：2026-10-09（Asia/Shanghai）  
源码基线：`863bf099a9b829599434e78f3e8bc92f1ea5132c`。

本文记录可核查依据和设计约束。源码核查为只读，不代表线上部署、生产客户端配置或运行时验收结果。所有设计方案均待讨论，本文不宣布已接受的架构决策。

## 现状依据

### 1. OAuth 实现和资源身份已经有明确基线

- 锁文件中的 `better-auth` 和 `@better-auth/oauth-provider` 均为 **1.6.11**；仓库没有使用旧 `oidcProvider` 插件。证据：`package-lock.json:216`、`package-lock.json:2746`、`src/auth.ts:9`。
- 对外协议路径为 `/api/v1/auth`，issuer 特意保留 `${origin}/api/auth`；路径迁移并不等于 issuer 迁移。证据：`shared/api-paths.ts:2`、`src/auth-config.ts:3`。
- JWT 配置使用 Ed25519；OAuth `validAudiences` 只有稳定 issuer。普通 Bearer 和 QuickLogin 的本地 JWT 验证都要求 `issuer` 与 `audience` 等于该稳定 issuer。证据：`src/auth.ts:196`、`src/auth.ts:202`、`src/middleware/authentication.ts:57`、`src/services/auth-access-token.ts:21`。
- 设计含义：增加独立 API / MCP 资源身份时，需要明确新资源 URI、发行规则和各资源服务器的 audience 校验，不能只增加一个路由。

### 2. OAuth 能力、客户端配置与实际授权需要分开确认

- 当前 provider 应用配置没有覆盖 access-token TTL、refresh-token TTL、grantTypes 或动态客户端注册开关。已安装 1.6.11 实现默认 access token 为 3600 秒、refresh token 为 2592000 秒，支持 authorization_code / client_credentials / refresh_token，默认关闭动态及未认证客户端注册。证据：`src/auth.ts:202`；依赖实现 `node_modules/@better-auth/oauth-provider/dist/index.mjs:2810`。
- 管理 API 的客户端创建契约允许 `skip_consent`、`require_pkce`、web/native/user-agent-based 类型及 `metadata`，客户端认证方式为 none / client_secret_basic / client_secret_post。证据：`src/api/v1/admin/oauth-clients.schema.ts:6`。
- 已注册的生产客户端值未读取；不能从“支持 PKCE”推断每个 confidential client 都被强制 PKCE，也不能从库支持某种 grant 推断现有业务已采用它。

### 3. 第一方浏览器 SSO 以共享根域 cookie 为边界

- 生产域开启 `crossSubDomainCookies`，Domain 为 `cqu.moe`；`trustedOrigins` 为 `https://*.cqu.moe`。本地开发会省略跨子域 cookie 配置。证据：`src/auth.ts:303`。
- `AuthService.verifySession(cookieHeader)` 验证用户会话后返回 user、全部 subsystem caps 及 CQU 绑定状态；不要求 caller client 身份。证据：`src/rpc.ts:61`。
- 现有指南推荐同账户子域 Worker 采用 cookie + RPC，不经过 OAuth 跳转；跨域第一方使用 OAuth 并由管理员设置 `skipConsent`。证据：`docs/subsystem-integration-guide.md:33`、`docs/subsystem-integration-guide.md:148`。
- 待决策：是否继续把全部第一方子域和已绑定 Worker 视为共同信任边界，还是要求应用隔离及独立撤销。

### 4. 第一方后台 RPC 是机器信任，不是逐用户委托令牌

- `getCaps`、`getCquTicket`、`cquHarvest` 接受调用方提供的 `userId`，验证 OAuth client secret 哈希并拒绝 disabled client；请求不需要该用户的 cookie 或 OAuth access token。证据：`src/rpc.ts:94`、`src/rpc.ts:121`、`src/rpc.ts:150`、`src/rpc.ts:223`。
- `getCquTicket` 额外查询调用方在 `oauth_client_cqu_scopes` 的授权，再进入用户的 CQU Session DO。`cquHarvest` 没有此 client-scope 查询，代码和指南明确把业务权益门禁交给调用方。证据：`src/rpc.ts:163`、`src/rpc.ts:205`、`docs/subsystem-integration-guide.md:92`。
- 待决策：后台代表用户持续访问 CQU 的权限是否仍来自机器信任，还是要求可撤销、限定应用和能力的用户授权记录。

### 5. 用户权益与 OAuth scope 是两个现有授权轴

- 普通取票 HTTP 入口必须有 Bearer principal，并同时满足 token scope 与数据库中该 client 的 CQU scope；浏览器 cookie 不能替代该 Bearer。证据：`src/middleware/scope.ts:17`。
- 用户权益事实源是 `user_entitlement`。SPA session 返回 caps 但移除 cqu；OAuth access token 按 client metadata 中的 subsystem 限定 caps；RPC `getCaps` 当前固定只返回 calendar。证据：`src/services/entitlements.ts:141`、`src/auth.ts:215`、`src/auth.ts:297`、`src/services/entitlements.ts:43`。
- 设计含义：API / MCP 的授权模型需要明确区分“用户已开通的业务能力”“客户端可请求的 scope”“此次用户授权”和“请求实际目标资源”，不能把现有 caps 快照当成完整授权凭证。

### 6. 登录与敏感操作已经具备部分安全机制

- 已启用密码登录、当前邮箱 OTP 验证、TOTP、邮件二次验证码、恢复码；OTP 采用哈希存储、次数限制和轮换重发，信任设备期限为 30 天。证据：`src/auth.ts:99`、`src/auth.ts:161`、`src/auth.ts:241`、`src/auth.ts:269`。
- 密码重置启用会话撤销；前端改密码显式请求撤销其他会话。封禁用户会撤销 OAuth refresh 能力，refresh grant 还会检查用户封禁状态。证据：`src/auth.ts:101`、`frontend/src/components/SecuritySection.tsx:35`、`src/auth.ts:111`、`src/services/oauth-tokens.ts:62`、`src/services/oauth-tokens.ts:92`。
- 当前普通 Bearer principal 路径只做 JWT 和必要 claims 验证，不读取用户封禁状态或会话撤销记录。已发行 JWT 的即时失效因此不能仅由 refresh 撤销推得。证据：`src/middleware/authentication.ts:48`。

### 7. 会话存储和撤销一致性值得单独建模

- 配置向 `withCloudflare` 同时传入 D1 与 KV；库把 KV 接入 Better Auth secondaryStorage，默认 geolocationTracking 又强制 `storeSessionInDatabase=true`。因此现状不是“只存在 KV 中的会话”。证据：`src/auth.ts:91`；依赖实现 `node_modules/better-auth-cloudflare/dist/index.mjs:108`、`:123`、`:161`。
- Better Auth 限流也使用 secondary-storage；OTP 与 2FA 的端点另有较严的限流参数。证据：`src/auth.ts:323`。
- 待决策：登出、封禁、改密、解绑、撤销某个应用授权分别需要什么失效时限，以及敏感操作是否需要查询权威状态或重新认证。源码配置本身不能证明跨地域撤销时延。

### 8. HTTP API 已有契约基础，MCP 尚未实现

- 已建立 `/api/v1` 路由装配、共享 principal middleware、路由 operation 列表及合并 Better Auth 的 OpenAPI；OAuth/OIDC discovery 单独挂载。证据：`src/api/v1/index.ts:39`、`src/middleware/authentication.ts:74`、`src/app.ts:71`、`src/app.ts:83`、`src/app.ts:94`。
- 在当前源码路由和依赖声明中未发现 MCP server、MCP transport 或 Protected Resource Metadata 端点；2026-09-11 的 API 重构设计也明确把 MCP 产品实现排除在当次范围。证据：`src/app.ts:18`、`src/api/v1/index.ts:39`、`package.json:30`、`docs/superpowers/specs/2026-09-11-api-v1-refactor-design.md:11`。
- 设计含义：MCP 可以复用领域操作与授权策略，但其 transport、资源元数据、客户端兼容方式、交互授权和工具粒度需要新设计。

## 历史材料与当前代码的差异

- 接入指南示例 `audience: YOUR_CLIENT_ID`（`docs/subsystem-integration-guide.md:193`）与 auth 资源服务器实际要求的 `audience: issuer`（`src/middleware/authentication.ts:59`）不同。客户端身份、OIDC ID token audience 和资源 access-token audience 必须分别解释，不能直接复制该示例作为新的 API / MCP 契约。
- 较早讨论若仍假设“CQU binding 接受普通 Bearer”“封禁不会影响 OAuth refresh”“密码重置不撤销 session”，应以现状重核：`src/routes/cqu-bind.ts:31`、`src/services/oauth-tokens.ts:62`、`src/auth.ts:101` 已存在相关控制。
- 所有库默认值均按本地锁定版本实现核查，依赖源码取自主工作区已安装的 node_modules；不代表截至核查日的上游最新功能或生产运行配置。

## 官方规范与升级依据

- Better Auth 官方 changelog 核查时最新稳定条目是 **1.7.7（2026-09-30）**。1.7 升级涉及 OAuth client 字段、protected resources、resource-bound tokens 等配置和 schema；本库已经使用 oauth-provider，不能误套仅针对旧 oidcProvider/oauthApplication 的数据迁移。Drizzle 应生成并审查 schema，再用项目自己的迁移流程。来源：[Changelog](https://better-auth.com/changelog)、[1.7 升级指南](https://better-auth.com/docs/guides/1-7-upgrade-guide)。
- OAuth 2.1 核查时仍是 `draft-ietf-oauth-v2-1-16`。已发布的 [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html#section-2) 可作为安全基线：PKCE、防授权码重放、public client refresh-token 轮换或发送方约束、audience 限定和最小权限。来源：[IETF 状态](https://datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/)。
- MCP 官方 current 版本为 **2026-07-28**；HTTP 授权要求受保护资源元数据、resource 请求参数和资源服务器 audience 校验。CIMD 为 SHOULD，DCR 已弃用但可作为兼容路径，预注册仍适用。来源：[版本页](https://modelcontextprotocol.io/specification/versioning)、[授权规范](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)、[客户端注册](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration)。
- MCP 调用独立上游 API 时，不得透传从 MCP 客户端收到的 token，应使用独立的上游访问凭据。来源：[MCP 安全要求](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)。
- **架构推论**：REST 与 MCP 是否拆 audience 应由逻辑资源服务器和安全边界决定，不能仅按协议名称断定。RFC 8707 允许 resource URI 表示一个完整 API 或资源集合；统一域名也不等于统一权限。来源：[RFC 8707 §2](https://www.rfc-editor.org/rfc/rfc8707.html#section-2)。
- 第一方 Web 可采用 BFF 与每应用 host-only session，把 OAuth token 留在后端。浏览器应用指南仍属草案；host-only 和 SameSite 不能代替 CSRF 防御。来源：[OAuth 浏览器应用指南](https://datatracker.ietf.org/doc/draft-ietf-oauth-browser-based-apps/)。
- 当前 Cloudflare 适配器官方文档明确把 KV 标为可选项，并说明 KV 会话缓存的撤销延迟和活跃会话索引竞争；严格批量撤销应省略 secondary session cache 并关闭 cookie cache。Better Auth 1.7 的验证与限流需要原子操作，KV 的 get/set/delete 不满足相应接口，官方建议数据库存储。来源：[适配器 README](https://github.com/zpg6/better-auth-cloudflare/blob/main/README.md)、[配置说明](https://github.com/zpg6/better-auth-cloudflare/blob/main/docs/configuration.md)。这描述上游当前文档，不能当成已安装 0.3.0 的运行行为。

## KV 是否必需：针对当前版本的专项核查

**结论：不必保留 KV。** 全部运行代码中唯一的 KV 接入点是 `src/auth.ts:94`，它把 KV 交给 Better Auth；未发现 CQU、QuickLogin 或权益服务直接使用 KV 作为业务缓存。绑定和类型另外位于 `wrangler.jsonc:38`、`src/types.ts:4`。

| 用途 | 当前路径 | 移除 KV 后的路径与必要处理 |
| --- | --- | --- |
| 用户会话及附带用户快照 | KV 优先，session 同时存 D1 | 直接用原生 D1 session/user 查询；保持 cookie cache 关闭 |
| OTP、2FA challenge、密码重置、信任设备、OAuth code 等 verification 数据 | 未设置 storeInDatabase，默认只存 KV | 走已有 D1 verification 表；旧 KV 中待完成流程需重新发起或制定切换策略 |
| 请求限流 | 显式 secondary-storage | 必须显式改数据库存储并补 rateLimit 表；只删 kv 会让当前限流静默失效 |
| TOTP secret、恢复码、OAuth refresh 数据 | D1 | 不受 KV 移除影响 |
| 独立业务缓存 | 未发现 | 无需替代存储 |

- **实际适配器路径**：Auth 运行时使用 `d1Native: env.DATABASE`（`src/auth.ts:93`），经 Better Auth 内置 Kysely D1 路径；业务代码另用 Drizzle，项目迁移也保留现有 SQL 工作流。不能把整个 Auth 运行时误述为 Drizzle adapter。
- **会话与 verification 回落**：`better-auth-cloudflare/dist/index.mjs:161` 在不传 kv 时令 secondaryStorage 为 undefined；Better Auth `db/internal-adapter.mjs:159`、`:221`、`:571-636` 提供数据库分支。已有 verification 表见 `drizzle/migrations/0000_init_better_auth.sql:54`。
- **限流迁移不可省略**：`src/auth.ts:327` 固定 secondary-storage；`better-auth/dist/api/rate-limiter/index.mjs:67-79` 在 secondaryStorage 缺失时读取为空、写入无操作。直接删除 storage 配置则默认实例内存，不能当成多实例统一限流。当前 schema/migrations 没有 rateLimit 表。
- **原子消费**：OAuth code 使用 `consumeVerificationValue`；当前 KV adapter 只有 get/set/delete，走实例内锁与分开的读取/删除。无 KV 时 D1 分支复用原生 consumeOne，SQLite 实现使用单条 DELETE RETURNING。依据：`@better-auth/oauth-provider/dist/index.mjs:606`、`better-auth-cloudflare/dist/index.mjs:83`、`better-auth/dist/db/internal-adapter.mjs:638-699`、`@better-auth/kysely-adapter/dist/index.mjs:428-463`。这不需要另建一个授权码 DO。
- **正确性限制**：锁定 1.6.11 的数据库限流仍有读后写计数，OTP/2FA 也有读后更新路径。移除 KV 不等于解决所有并发问题；升级后的实际适配器与关键流程仍需验证。
- **撤销限制**：移除会话缓存不会自动撤销已签发的自包含 JWT；60 秒目标需要单独落实到 access-token 与授权状态的验证策略。无需为满足该目标预先引入另一层缓存。

以上依赖源码版本已核对 installed 与 lock 一致：better-auth、core、oauth-provider、drizzle-adapter 为 1.6.11，better-auth-cloudflare 为 0.3.0。本节没有生产查询或运行时验收。

## Passkey 与近期强认证：固定 v1.7.7 实现核查

- `@better-auth/passkey` 新增 passkey 表，并复用 verification 保存 challenge。实现使用 adapter 和 WebCrypto，具备在 Workers/D1 集成的依据，但本项目尚未做组合验收。来源：[Passkey schema](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/passkey/src/schema.ts)、[WebCrypto 路径](https://github.com/MasterKale/SimpleWebAuthn/blob/v13.3.1/packages/server/src/helpers/iso/isoCrypto/getWebCrypto.ts)。
- 登录选项为 `userVerification: "preferred"`，服务端登录校验为 `requireUserVerification: false`。注册时设置 authenticatorSelection.userVerification 不会改变该登录校验。不能把“安装插件”或“认证成功”自动等同于完成用户验证。来源：[登录选项](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/passkey/src/routes.ts#L486-L500)、[服务端验证](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/passkey/src/routes.ts#L896-L910)。
- `authentication.afterVerification` 在密码学验证成功之后、创建 session 之前被 await，可在此拒绝 `verification.authenticationInfo.userVerified !== true`。该字段来自签名覆盖的 authenticator flags，而非任意客户端声明。来源：[hook 时序](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/passkey/src/routes.ts#L911-L958)、[SimpleWebAuthn UV 结果](https://github.com/MasterKale/SimpleWebAuthn/blob/v13.3.1/packages/server/src/authentication/verifyAuthenticationResponse.ts#L242-L258)。
- twoFactor 的登录后 hook 只匹配 email/username/phone-number 登录，Passkey 登录不会额外触发该 hook。因此通过验证的 UV 是本方案接受其独立强认证的必要条件。来源：[twoFactor 登录 hook](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/better-auth/src/plugins/two-factor/index.ts#L431-L449)。
- Passkey 注册默认使用 freshSessionMiddleware；删除仅检查 session 与 credential ownership。freshSession 只比较会话创建时间，不证明用户近期完成了指定因子。添加/删除凭据的强认证门禁不能只依赖这些默认值。来源：[注册](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/passkey/src/routes.ts#L163-L172)、[删除](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/passkey/src/routes.ts#L1062-L1076)、[freshSession](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/better-auth/src/api/routes/session.ts#L598-L616)。
- **实现约束**：原生 Passkey 登录会新建会话，并按提交的 credential 确定用户，不能直接把它当成“当前会话再次验证”。敏感操作验证必须关联当前用户、当前会话、用途和有效期，并检查 credential ownership 与 UV。来源：[认证用户解析](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/passkey/src/routes.ts#L867-L884)、[新建会话](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/passkey/src/routes.ts#L938-L958)。
- **建议**：Passkey 仪式仅在中央 auth.cqu.moe 进行，固定相应 rpID 与 origin；第一方应用通过中央登录跳转获得自己的会话，无需扩展 Passkey RP 到整个根域。配置依据：[官方选项](https://www.better-auth.com/docs/plugins/passkey#options)。这是本项目的架构建议，并非框架强制要求。

## 后台离线授权与设备退出：固定 v1.7.7 实现核查

- provider 的 session 删除 hook 保留带 `offline_access` 的 refresh token，撤销关联 access token并发送 back-channel logout；refresh grant 不要求原 session 仍存在。可以用原生 OAuth 授权表达后台访问，不必另建授权框架。来源：[logout.ts](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/oauth-provider/src/logout.ts)、[token.ts](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/oauth-provider/src/token.ts)。
- 本项目 `drizzle/migrations/0001_oauth_provider.sql:50` 的 refresh token session 外键为 ON DELETE SET NULL；目标版也允许 sessionId 为空。这里只核实源码和迁移文件，生产实际 schema 未检查。来源：[v1.7.7 schema](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/oauth-provider/src/schema.ts)。
- 原生退出全部会话、启用 revokeOtherSessions 的改密和启用 revokeSessionsOnPasswordReset 的重置均经过 session 删除路径。人工恢复须显式保留后台用途凭据，不能直接复用封禁时撤销全部 OAuth token 的逻辑。来源：[session.ts](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/better-auth/src/api/routes/session.ts)、[update-user.ts](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/better-auth/src/api/routes/update-user.ts)、[password.ts](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/better-auth/src/api/routes/password.ts)。
- **设计约束**：设备客户端若也申请 offline_access，原生退出同样会保留其 refresh token。因此必须用平台控制的客户端用途区分后台与设备，并验证设备凭据确实撤销；不能只按 scope 名称判断是否保留。
- **验收边界**：session 自然过期但尚未删除，与删除触发外键置空不同。refresh 可能沿用旧 sid，而 introspection 会拒绝过期 session；长期后台同步必须覆盖这一路径，不能只测试显式退出。来源：[token.ts](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/oauth-provider/src/token.ts)、[introspect.ts](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/oauth-provider/src/introspect.ts)。
- **替代方案的取舍**：专用系统身份加业务 scope、userId，并在 Auth 查询用户状态、权益和绑定，可以不增加逐用户 token 存储；若攻击者取得该身份并能调用其私有入口或借用转发入口，影响范围覆盖该服务获准访问的用户。仅泄露密钥不等于已经具备调用私有 RPC 的条件。两种方案都必须在业务入口检查当前封禁和学校绑定，原生 OAuth 不理解学校解绑的业务含义。

上述离线 token 调研只作为比较依据。本次已选定保留私有 RPC 服务身份，不据此建立后台逐用户 refresh token 系统，见 [ADR 0009](../adr/0009-private-rpc-service-identity.md)。

## 私有 RPC 的安全边界

Cloudflare 官方说明 Service Binding RPC 不经公共 URL，调用方需在相应账户声明目标 Worker/entrypoint 的 binding；同一 binding 也可通过 fetch 调用 HTTP handler。来源：[Service Binding RPC](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc)、[Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings)。

**本项目的威胁判断**：外部攻击者只有服务密钥、没有已授权的 binding 或可借用的转发入口时，不能直接调用私有 RPC。这不保证调用链安全：持有 binding 的 Worker 失陷，或公网 handler 暴露不受控的转发，均可能让后台权限被滥用。若同一同步 Worker 持有所有用户的 refresh token，完整 Worker 失陷也可能暴露全部凭据，因此逐用户 token 的主要额外收益在于单个凭据泄露及错误身份绑定的隔离，而非抵御整个后台失陷。

## PKCE 与 DPoP：固定 v1.7.7 实现核查

- PKCE 客户端字段为 require_pkce/requirePKCE，默认开启，public client 始终要求；授权端只接受 S256，token 端检查 challenge/verifier 一致性。当前 QuickLogin 注册也已要求 PKCE；其余现存客户端配置仍需核查。来源：[PKCE 默认策略](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/oauth-provider/src/utils/index.ts#L1112-L1138)、[S256](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/oauth-provider/src/authorize.ts#L763-L775)、[兑换检查](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/oauth-provider/src/token.ts#L1551-L1627)，本地 `src/services/quicklogin/client-registration.ts:118`。
- DPoP client 字段为 dpop_bound_access_tokens/dpopBoundAccessTokens；resource 可设置 dpopBoundAccessTokensRequired；授权请求可提供 dpop_jkt。配置 dpop 对象主要设置算法与 proof 时间等参数，不能将其理解为唯一的启用开关。签发返回 token_type=DPoP 与 cnf.jkt，refresh 保持原 key 绑定。来源：[绑定检查](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/oauth-provider/src/token.ts#L778-L833)、[JWT confirmation](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/oauth-provider/src/token.ts#L285-L292)。本次选定可选支持，不强制现有客户端。
- RS 需用 request-aware 的 verifyAccessTokenRequest；verifyBearerToken 会拒绝已绑定 token。验证涉及 proof 签名、绑定 key、HTTP 方法、目标 URL、iat、jti、ath，以及 token 自身的 issuer/audience/scope。来源：[请求验证](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/core/src/oauth2/verify.ts#L595-L652)、[禁止降级](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/core/src/oauth2/dpop.ts#L525-L561)。当前 `src/middleware/authentication.ts:52` 和 `src/middleware/quicklogin-device-auth.ts:29` 只接受 Bearer；`src/services/auth-access-token.ts:21` 仅接收 token，必须纳入适配。
- DPoP replayStore 提供 reserve({key, expiresAt, now})，默认进程内 Map 不足以覆盖多实例 Workers。框架的 createDpopReplayStore(internalAdapter) 复用 verification 表，reserveVerificationValue 用确定性主键 INSERT 完成原子占位；AS 已接入，RS 须显式接共享存储。来源：[接口与工厂](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/core/src/oauth2/dpop.ts#L51-L112)、[注入位置](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/core/src/oauth2/verify.ts#L619-L652)、[原子占位](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/better-auth/src/db/internal-adapter.ts#L1510-L1580)。优先复用该路径，不重新实现协议或增加存储服务。
- 在本次核查的 v1.7.7 接口中未发现原生 DPoP-Nonce challenge/校验机制；RFC 9449 的服务器 nonce 是可选机制，本轮不承诺该模式。可使用 proof 时间窗口与共享 jti 去重。来源：[固定实现](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/core/src/oauth2/dpop.ts)、[RFC 9449 §8](https://www.rfc-editor.org/rfc/rfc9449.html#section-8)。
- Better Auth 自身前端 oauth-provider client 插件不等于任意消费方都已具备 DPoP 签名。客户端可参考支持浏览器与 Workers 的 oauth4webapi；QuickLogin 如选择启用，密钥必须跨扩展 service worker 重启保留。来源：[Better Auth client](https://github.com/better-auth/better-auth/blob/v1.7.7/packages/oauth-provider/src/client.ts)、[官方 DPoP 示例](https://github.com/panva/oauth4webapi/blob/main/examples/dpop.ts)。本次不强制改造全部客户端，不为未来客户端另建通用 SDK。
- DPoP 降低被盗 token 在其他执行环境中的重放风险，不防已经控制客户端并能使用其签名密钥的攻击者，不签请求正文，也不代替 TLS 或授权检查。来源：[RFC 9449](https://www.rfc-editor.org/rfc/rfc9449.html#section-11.4)。
