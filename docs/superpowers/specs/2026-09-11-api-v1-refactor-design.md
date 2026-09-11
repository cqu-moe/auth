# Auth 代码精简与 API v1 重构设计

状态：用户已于 2026-09-11 确认本方案。随后指定由 5.6-sol high 执行；当前任务仅交付迁移清单与验收标准，尚未修改运行代码。

## 目标与基线

合并重复实现、删除确定不可达或无调用的代码，建立独立、可描述和可验证的 HTTP API。新的应用接口统一使用 `/api/v1`，为后续 Cloudflare API Shield 和其他客户端提供契约。

2026-09-11 通过 `git ls-remote origin refs/heads/main` 核实，远端 main 为 `225d1c66d9b15ae13b9c710227649c1d47516aa4`。主目录仍为 `79026ba`，落后 9 个提交。最新源码已在 `.worktrees/email-verification-otp` 中只读检查；正式实现从核实后的远端 main 新建隔离工作区，不混入独立 QuickLogin 开发分支。

保持现有页面表现、OTP/onboarding 行为、数据库语义及 Service Binding RPC 契约。CLI、MCP 产品实现和 Cloudflare 线上规则配置不在本次范围。

## 已确认的问题

| 位置 | 事实 | 改动方向 |
| --- | --- | --- |
| `src/index.ts` | 未匹配 API 的请求进入 ASSETS，启用 SPA fallback | API 404/405 在 API 层结束，页面请求才进入 ASSETS |
| `src/routes/cqu.ts`、`src/routes/cqu-bind.ts`、`src/middleware/scope.ts` | Bearer 验证重复；取票请求会验证同一 JWT 两次 | 请求内验证一次，scope 校验消费验证后的身份 |
| `src/routes/cqu-bind.ts` | forward 模式被 return 拦截后仍有白名单构造代码 | 删除不可达创建分支，保留旧 forward 记录的读取和邮件处理 |
| `src/routes/admin.ts` | 960 行，混合用户、邀请、权益、OAuth 客户端及校验 | 按现有业务模块拆分，集中公共鉴权与错误转换 |
| `frontend/src/pages/Admin.tsx` | 2289 行，混合多个管理页面和请求实现 | 按管理功能拆分；页面通过统一 API 客户端访问服务 |
| Settings 与 CquBindWizard | 重复状态类型、WebSocket 地址/生命周期和请求错误处理 | 共享契约、绑定请求和事件订阅实现，保留各页面自身状态 |
| `frontend/src` | 5 处直接从后端 `src` 导入角色或能力定义 | 纯共享定义移到 `shared/`，禁止前端导入后端实现 |
| `src/routes/admin.ts` | action 请求体、rotate-secret 动词路径、部分删除返回成功 JSON | 明确资源与方法语义，v1 删除成功统一 204 |
| Better Auth OpenAPI 生成器 | 锁定的 1.6.11 实现输出 OpenAPI 3.1.1 | 生成完整契约并校验转换后的 Cloudflare 3.0.3 产物 |

自定义 CQU 与管理路由共有 33 个 HTTP 操作，此外还有 health、公开注册设置、注册拦截及 Better Auth 插件端点。Better Auth 的完整端点清单在实现中从实际启用的版本和配置生成，不凭前端调用推测可删除端点。

## 方案选择

| 方案 | 收益 | 代价 |
| --- | --- | --- |
| 全部应用接口迁到 v1，旧地址短期兼容（推荐） | 正式契约统一，已有调用方可逐步迁移 | 迁移期间保留集中管理的旧地址映射 |
| 只迁自定义业务接口，认证继续使用 `/api/auth` | 改动较小 | 长期留下两套接口前缀，无法完整达到本次目标 |
| 全部迁移并立即移除旧地址 | 立即只有一套地址 | 会破坏硬编码旧 OAuth 地址的客户端，需要跨仓库同步发布 |

采用第一种方案。完成状态区分“v1 实现与仓库内调用迁移完成”和“旧地址退役完成”；只要兼容地址仍然可调用，就不能声称所有 HTTP API 都只在 v1 下。

## HTTP 路由与契约

`/api/v1` 仅提供 API、协议回调及 WebSocket 握手，不提供 SPA 或 HTML 文档界面。OAuth 重定向、表单 token 请求和 WS 101 按协议保留，不能强制套 JSON 响应。

`/.well-known/oauth-authorization-server` 与 `/.well-known/openid-configuration` 保留标准发现地址。它们是明确登记的协议例外，返回 JSON；页面继续使用 `/login`、`/oauth/authorize` 等页面路径。

主要映射如下。未列出语义变化的资源仅迁移前缀。

| 当前入口 | v1 入口 | 行为 |
| --- | --- | --- |
| `GET /api/health` | `GET /api/v1/health` | 健康状态；移除写死的历史修复版本标签 |
| `GET /api/auth/registration-settings` | `GET /api/v1/registration-settings` | 公开读取 invitationRequired |
| `/api/auth/*` | `/api/v1/auth/*` | 使用 Better Auth basePath；保留插件自身协议 |
| `POST /api/auth/sign-up/email` | `POST /api/v1/auth/sign-up/email` | 邀请码原子占用仍先于 auth handler |
| `GET /api/cqu/service-ticket` | `POST /api/v1/cqu/service-tickets` | JSON 传 service 或 serviceUrl，签发成功 201；响应 no-store |
| `GET, POST, DELETE /api/cqu/binding` | 同方法 `/api/v1/cqu/binding` | 单用户绑定；创建 201、已存在 200、删除 204 |
| `PUT /api/cqu/binding/credentials` | `PUT /api/v1/cqu/binding/credentials` | 保存凭据及原有登录流程 |
| `GET /api/cqu/binding/events` | `GET /api/v1/cqu/binding/events` | WebSocket；不作为 JSON body 校验覆盖项 |
| `GET, PUT /api/cqu/quicklogin` | 同方法 `/api/v1/cqu/quicklogin` | 保持仅 session 可操作 |
| `GET /api/admin/users[/:id]` | `GET /api/v1/admin/users[/{id}]` | 现有分页与用户详情 |
| `PATCH /api/admin/users/:id` | `PATCH /api/v1/admin/users/{id}` | body 改为 `{ banned: boolean }` 或 `{ role: ... }`，每次仅允许一类变更 |
| `PATCH /api/admin/users/:id/cqu-binding` | `PATCH /api/v1/admin/users/{id}/cqu-binding` | 保留 active/revoked 状态语义 |
| `GET, POST, DELETE /api/admin/registration-invitations[/:code]` | 同方法 `/api/v1/admin/registration-invitations[/{code}]` | 邀请列表、创建与撤销；鉴权不变 |
| `GET, PUT /api/admin/registration-settings` | 同方法 `/api/v1/admin/registration-settings` | 注册策略 |
| `GET, PUT /api/admin/users/:id/entitlements` | 同方法 `/api/v1/admin/users/{id}/entitlements` | PUT 仍原子替换整组权益 |
| `POST /api/admin/users/:id/entitlements/preset` | `PATCH /api/v1/admin/users/{id}/entitlements` | `{ preset: string }` 仅合并预设覆盖的键，保留无关权益 |
| `DELETE /api/admin/users/:id/entitlements/:subsystem/:capability` | `DELETE /api/v1/admin/users/{id}/entitlements/{subsystem}/{capability}` | 删除一项权益，204 |
| `/api/admin/entitlement-presets[/:name]` | `/api/v1/admin/entitlement-presets[/{name}]` | 保留 GET/PUT/DELETE 资源语义 |
| `GET, PUT /api/admin/entitlement-default` | 同方法 `/api/v1/admin/entitlement-default` | 默认预设配置 |
| `/api/admin/oauth-clients[/:id]` | `/api/v1/admin/oauth-clients[/{id}]` | 列表、创建、更新、删除；删除 204 |
| `GET, PUT /api/admin/oauth-clients/:id/scopes` | 同方法 `/api/v1/admin/oauth-clients/{id}/scopes` | scope 白名单；原子替换 |
| `POST /api/admin/oauth-clients/:id/rotate-secret` | `POST /api/v1/admin/oauth-clients/{id}/secrets` | 生成并返回新 secret 一次，旧 secret 失效；201、no-store |
| 无 | `GET /api/v1/openapi.json` | 完整机器可读 API 契约 |

自定义 JSON 资源成功时采用 `{ data: ... }`；列表分页维持 `{ data, pagination }`。错误采用 RFC 9457 Problem Details，包含 `type`、`title`、`status`、`detail` 及稳定业务 `code`。保留现有业务 code，避免页面逻辑依赖中文提示。Better Auth/OAuth 的既有请求与响应格式保持协议要求；前端由各自客户端处理。

所有自定义输入在 HTTP 层完成 JSON、路径、查询、枚举和分页校验。畸形 JSON 返回 400，媒体类型不支持返回 415；已知路径方法错误返回 405 和 Allow；未知 API 返回 JSON 404。枚举与可接受字段在 schema 中明确，避免仅靠 TypeScript 类型断言。受保护接口维持原有鉴权顺序，schema 校验不能成为绕过权限检查的路径。

## 鉴权与迁移约束

集中 `requireSession`、`requireBearer` 和确有需要的 session-or-Bearer 中间件。管理员角色和细粒度权益权限分别保留。scope 逻辑接收已经验签的 claims，并继续校验 token scope 与客户端白名单；会话不能替代取票所需的 Bearer。

迁移 auth basePath 时，先在本地记录旧配置产生的 issuer、audience、JWKS、Cookie 名称/Path/Domain 和重置密码回调，再设置可比较的迁移约束。源码显示 OAuth 默认 issuer/audience 会引用 auth baseURL，因此只替换 URL 字符串不足以证明兼容。保持现有身份发行者语义及会话 Cookie，发现文档指向新端点；验证迁移前后签发的 token、已有 session、2FA、OTP 和重置密码流程。

旧地址兼容集中在一个模块中，只登记本次迁移清单里的方法和路径。旧请求直接委托同一个处理实现，必要时转换旧请求体/响应形状，不复制业务逻辑；有请求体的请求不使用 HTTP 重定向。未知旧路径返回 API 404，禁用的 Better Auth 端点仍然禁用。

两个明确的外部依赖：本机 QuickLogin 源码硬编码 `/api/auth/oauth2/token` 和 `/api/auth/oauth2/authorize`；Schedule 当前通过 `AUTH.verifySession` 等 RPC 接入。QuickLogin 开发分支的 device 路由不是 main 已存在的能力，本次不能因兼容之名恢复这些路由。

接口清单分别标记 canonical、legacy、discovery 与 websocket。Cloudflare 迁移期端点清单必须包括仍可调用的兼容地址。仓库内前端直接迁到 v1；旧入口退出前核对所有已知客户端和未过期回调，并检查按路由聚合的访问证据。发布时另定退役日期，不擅自假设其他客户端已完成升级。

## 代码组织

```text
src/index.ts                 Worker fetch/email/queue 与必要导出
src/app.ts                   API、协议发现、页面 fallback 的装配
src/api/v1/                  正式 HTTP 路由、请求与响应 schema
src/api/legacy.ts            有限旧地址映射与格式转换
src/middleware/              session、Bearer、scope、admin 校验
src/services/                可供 HTTP 和 RPC 共用的业务实现
shared/                      纯角色、能力目录和跨端契约定义
frontend/src/lib/api/        请求、错误、API 类型与绑定事件订阅
frontend/src/features/admin/ 用户、邀请、权益、OAuth 客户端界面
frontend/src/pages/          页面组合与页面自身导航状态
```

保留现有 Hono/React 技术栈，不搬动数据库和容器部署目录。自定义 HTTP 路由使用 `@hono/zod-openapi` 让参数校验和 OpenAPI 来自同一份 schema。前端只导入 `shared/` 或生成的 API 类型；构建检查禁止其导入后端 `src/`。Better Auth 继续通过官方客户端调用。

依赖扫描覆盖后端、前端、测试、Worker 导出、容器入口和配置引用。删除结论需同时检查静态引用和运行时入口。重复 UI 控件在行为、无障碍与视觉一致时合并。DO 保持状态所有权集中，按可验证的重复逻辑提取辅助函数，避免为降低单文件行数引入跨模块状态操作。

以下内容有明确用途，不能按普通未引用符号删除：Durable Object 历史兼容导出、append-only 迁移、旧持久 browser route 的 `NODE_RETIRED` 拒绝分支、旧 forward 绑定读取、冻结设计/回滚证据、仍有引用的 `cqu-node-protocol.ts`。

## OpenAPI 与 Cloudflare

保留完整 API 契约供开发者和客户端使用，生成独立 OpenAPI 3.0.3 文件供 Cloudflare 导入。Better Auth 1.6.11 的生成结果是 3.1.1，转换必须处理实际出现的 schema 语义，不能只修改版本字段。无法可靠转换的字段应使生成失败并给出定位，不能静默丢弃约束。

生成时合并自定义 schema 与启用的 Better Auth 端点，补充邀请码等应用层约束，过滤 disabledPaths。Cloudflare 文件使用绝对 server URL、内部引用、明确方法/参数/body；随文件导出实际保护覆盖清单。

Cloudflare 当前支持 OAS 3.0.x，未支持 3.1；不验证响应，JSON 以外的 body 校验和 WebSocket 消息也不能算作已覆盖。应用自身始终保留校验。若以后增加文档 UI，放在 API 路由之外，并关闭 Better Auth 默认的 HTML reference。

当前没有可调用的 Context7 MCP，按项目规则使用 Exa 查询官方来源，并核对本地锁文件和实际生成器源码：

- [Hono Zod OpenAPI](https://hono.dev/examples/zod-openapi)
- [Better Auth 1.6 OpenAPI](https://better-auth.com/docs/1.6/plugins/open-api)
- [Cloudflare Schema Validation](https://developers.cloudflare.com/api-shield/security/schema-validation/)
- [Cloudflare Schema Validation API 配置](https://developers.cloudflare.com/api-shield/security/schema-validation/api/)
- [RFC 9457 Problem Details](https://www.rfc-editor.org/rfc/rfc9457.html)

## 实施顺序与验收

1. 在最新 main 的隔离工作区记录测试基线，建立方法/路径、认证方式与契约清单。
2. 先用测试固定 API/SPA 分界、未知路径、405、旧入口兼容，以及迁移前后 auth 元数据/Cookie/token 行为，再建立 v1 路由装配。
3. 分模块迁移 CQU 和管理 API，统一校验与错误；保留绑定、出票及权益原子操作语义。合并 JWT/session 验证和确定的重复实现。
4. 迁移前端 API 调用与共享定义，拆分管理页面，合并绑定状态请求和事件连接；保留现有 UI 与 onboarding 回跳。
5. 生成完整契约及 Cloudflare 产物，检查路由覆盖、schema 有效性和产物漂移；删除验证过的死代码，更新当前接入文档与开发说明。
6. 完成后端/前端类型检查、常规测试、Workers/DO 测试、前端 lint 与构建；只在修改容器实现时追加对应 Python 测试。

关键回归包括未登录与权限不足、合法/失效 Bearer、客户端 scope、session-only 开关、旧账号绑定真值、邀请码并发、OTP/2FA、密码重置回调、CQU WebSocket 重连、权益批量写失败回滚、旧/新 OAuth 发现与 token 使用。测试要通过实际路由和业务行为断言，不能只检查源码含某个字符串。

完成报告分别列出代码精简结果、实际测试证据、v1 覆盖与例外、旧地址退役状态。Cloudflare 文件生成通过不等于已经上线防护；本次不上传 schema、不调整规则、不部署。

## 执行稿补充核对

执行入口为 `../plans/2026-09-11-api-v1-refactor-plan.md`，逐端点契约与验收矩阵在同名目录内。本节将设计阶段的概括收紧为已核实约束，不重复开启设计审批。

- 用锁定的 Better Auth/OAuth Provider 1.6.11 和本地假环境生成元数据，实际 issuer 为 `https://auth.cqu.moe/api/auth`。v1 使用新路由地址但保留这个 issuer；同时保留必要的 issuer discovery 地址。这里是本地配置证据，没有读取生产 token 或 Cookie。
- 有 80 个已挂载、非 SERVER_ONLY 且未列入 disabledPaths 的 endpoint 定义，共 81 个 HTTP 操作。自动 OpenAPI 多列了 `POST /get-session`，必须以最终运行时路由为准删除这个误报；`GET /get-session` 需要补上 customSession 的 caps 形状。
- `/api/auth/error` 是 Better Auth 自带 HTML 页面。v1 将该入口改为到 `/auth/error` 页面的受控重定向，API 子树不返回 HTML。旧入口也转到该页面。
- `PUT .../oauth-clients/{id}/scopes` 当前源码是先 delete 再 insert，并非注释所称的原子替换。执行稿明确改为 D1 batch，并按既有角色声明补齐 cquScope:assign 与 cquScope:revoke 检查；普通 admin 在新旧入口均不得写。这个权限收紧和事务修复必须单独记录，不能称为零行为变化。
- 取票旧接口允许 serviceUrl 优先于 service；v1 明确仅允许一个目标。兼容适配器继续保留旧请求的优先级。不能把所有旧请求原样送进新的严格 schema 后就声称兼容完成。
