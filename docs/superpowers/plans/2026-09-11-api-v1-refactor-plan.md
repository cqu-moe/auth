# Auth API v1 与代码精简 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox syntax for tracking. 用户指定由 **5.6-sol、high** 在后续任务执行；设计已经批准，不再询问执行方式，也不要自行调度其他模型。

**Goal:** 合并重复实现、删除确定无用的代码，将正式应用 HTTP 接口统一至 `/api/v1`，交付规范契约、旧地址兼容和可复核的回归证据。

**Architecture:** 保留 Hono、Better Auth、Cloudflare Worker/DO 和 React SPA；把 HTTP 装配、业务实现、纯共享定义、前端调用分开。自定义接口通过同一组 schema 完成运行时校验和 OpenAPI 生成；旧地址集中委托新实现，OAuth/OTP/2FA 保留原生协议。

**Tech Stack:** 当前锁定 Better Auth/OAuth Provider 1.6.11、Hono 4.12.22、Zod 4.4.3、Drizzle/D1、Workers/DO、React 19、Vite、Vitest 4、Workers pool。新增 `@hono/zod-openapi`、`openapi-typescript`、OpenAPI 校验工具时核对与现有锁定版本兼容；不顺带升级框架。

**Spec:** [批准设计](../specs/2026-09-11-api-v1-refactor-design.md)；[逐端点迁移清单](2026-09-11-api-v1-refactor/01-migration-inventory.md)；[独立验收标准](2026-09-11-api-v1-refactor/02-acceptance.md)。三个文档均为执行输入。

## Global Constraints

- 工作目录：`/Users/uu/Developer/cqu-moe/auth`；执行必须从核实后的最新远端 main 建隔离工作区。文档审阅基线是 `225d1c66d9b15ae13b9c710227649c1d47516aa4`，主目录 main 尚停在 `79026ba`。
- 用户已经确认设计，并要求完整执行稿交给 5.6-sol high。本轮只有文档准备，没有实现、提交、部署或线上验证。
- 正式应用 API `/api/v1`；API 子树不得返回 SPA 或 HTML 文档。OAuth 302、WebSocket 101、标准 discovery 是显式协议例外。
- 保持现有 issuer=`https://auth.cqu.moe/api/auth` 的身份含义；生产 Cookie Domain=`cqu.moe`、Path=`/`；本地开发仍是原来的 host-only Cookie。
- 保持 OTP：6位、300秒、3次尝试、hashed、resend rotate、注册验证；保持2FA、可信设备、恢复码和其限频。customSession 最后执行，返回 user/session/caps，排除 caps.cqu。
- 保持 cqu_credentials 优先的绑定真值、已有 forward 记录、DO唯一出票闸、token/client scope、access/consent两个flag、邀请码原子占用、权益事务语义、Schedule RPC。
- CQU scope 写入补齐 cquScope:assign/revoke，delete+insert改D1 batch；这是明确列出的修复，不伪装成纯重命名。不得复制现有缺失ACL的行为到legacy。
- 前端不得导入后端 `src/`；共享目录只放纯定义/纯逻辑和生成类型。页面布局、中文文案、交互顺序与已有视觉参考保持，必要的 `/auth/error` 页面复用当前布局。
- 不恢复 QuickLogin 独立开发分支的 devices/refresh/export 接口，不删除历史 DO 导出、SQL/DO migrations、NODE_RETIRED 防线和冻结参考。
- 不访问生产D1/KV/真实凭据，不发送真实邮件，不上传CF schema、不改WAF/Endpoint Management、不push、不部署。推送任何分支都会触发现有CI上传/部署，不能当普通备份动作。
- Git 使用现有 user.name/user.email；缺失时才询问。不覆盖作者身份，不禁用签名绕过1Password。可以本地逐任务提交；签名受阻时保留可审阅diff并明确记录。
- 文档/库查询按 AGENTS：Context7 skill优先；工具不可用时Exa读取官方文档。测试不依赖网络查询。

## 0. 如何执行和留下证据

按 T00→T17 顺序推进。每项先完成对应失败测试或迁移前行为刻画，再改代码、跑针对性检查、查看diff、填写记录、提交。一次只标记已经验证的项。运行失败若来自环境，保留命令/退出码/原因，不能改测试断言、删除测试或冒充功能通过。

在执行工作区创建 `docs/superpowers/plans/2026-09-11-api-v1-refactor/execution-log.md`。每任务一行：`任务ID | 状态 | 改动文件 | red命令/失败原因 | green命令/结果 | 关联验收ID | commit或未提交原因`。状态只用 `未开始/进行中/通过/失败/环境阻塞`。任务未通过时不得写“已完成”。日志只保存摘要；不持久化测试生成的密码、Cookie、OTP、token或secret。

所有本文代码块是目标接口或具体测试例子，不是整文件替换脚本。测试片段中的 `f` 统一由 `const f = await createApiFixture()` 创建，并在 afterEach/finally 中 close；it/expect/vi 来自 vitest，各schema/helper从本任务列出的目标文件导入。实现可使用已核实等价的库API，但名称/外部行为/验收ID不能随意漂移；如需改名，更新全部使用点及三份执行文档。

依赖：T00基线→T01共享→T02 HTTP合同→T03身份→T04路由边界→T05认证迁移→T06/07 CQU→T08/09/10/11管理→T12契约/类型→T13/14/15前端→T16清理门禁→T17总验收。后续任务依赖前项的真实接口，禁止提前创建空实现占位。

## 1. 文件与接口责任

详细移动见迁移清单第7节。以下是新文件的固定职责：

| 文件 | 职责 / 对外接口 |
| --- | --- |
| `src/app.ts` | `createApp(): Hono<HonoEnv>`；组装v1、legacy、discovery、页面fallback，不导入WorkerEntrypoint/DO类 |
| `src/api/v1/index.ts` | `createV1Api()`；基址`/api/v1`的OpenAPIHono实例，按业务模块注册 |
| `src/api/auth-operations.generated.ts` | T05从本地auth配置生成的纯方法/路径列表，供无env的createApp注册auth路由；T12纳入确定性生成/漂移检查 |
| `src/api/operations.ts` | `listHttpOperations(app, authEndpoints)`；最终方法/路径清单、Allow和覆盖对照；过滤middleware，不制造通配业务端点 |
| `src/api/problem.ts` | `problem(c, code, detail, status): Response`；Problem Details、安全状态映射 |
| `src/api/legacy.ts` | `createLegacyRouter(forwardToV1)`；精确映射并转换请求/响应 |
| `src/auth-config.ts` | `authUrls(origin)`；集中canonical basePath、stable issuer与JWKS地址 |
| `src/middleware/authentication.ts` | `getRequestAuth(c)`、`requireSession`、`requireBearer`、`requireSessionOrBearer`、`requireAdmin` |
| `src/services/oauth-scopes.ts` | 原`scopeSatisfies`纯逻辑；HTTP与RPC共用，不引用Hono或Worker运行时 |
| `src/api/v1/{cqu-binding,cqu-service-tickets,cqu-quicklogin}.ts`及`.schema.ts` | 对应CQU资源handler及输入/输出schema |
| `src/api/v1/admin/{users,invitations,entitlements,oauth-clients}.ts`及`.schema.ts` | 对应管理资源handler及schema |
| `src/services/oauth-clients.ts` | 从旧admin提取OAuth序列化、合并校验、adapter写入；不引入新的仓储框架 |
| `src/api/openapi/{auth,document,cloudflare}.ts` | 分别校正BA schema、合并完整契约、生成CF投影 |
| `scripts/{generate-api,check-api,check-boundaries}.ts` | 确定性生成、漂移/覆盖校验、跨端导入检查；不触网或连生产数据库 |
| `shared/{capabilities,user-roles,cqu-events,api-response}.ts` | 纯领域定义；保留原名字和序列化协议 |
| `shared/api-types.generated.ts` | 从完整OpenAPI生成的类型；只被消费，禁止手改 |
| `frontend/src/lib/api/{http,admin,cqu,registration,binding-events}.ts` | 规范请求/错误/响应、领域调用与WS transport |
| `frontend/src/features/admin/` | UsersSection、InvitationsSection、EntitlementsSection、OAuthClientsSection及随功能变化的表单 |

保持 T01 移动后的类型可用：

```ts
export const API_BASE_PATH = '/api/v1' as const;
export const AUTH_BASE_PATH = '/api/v1/auth' as const;
export type UserRole = 'user' | 'admin' | 'superAdmin';
export type Principal =
  | { kind: 'session'; user: { id: string; role?: string } }
  | { kind: 'bearer'; userId: string; clientId: string; scopes: string[] };
```

常量放 `shared/api-paths.ts`，Principal放后端 `src/types.ts`。迁移清单第2节的ApiSuccess/ApiProblem/PageInfo通用类型放`shared/api-response.ts`；后端schema需满足这些类型。领域DTO由后端schema生成，前端在`frontend/src/lib/api/types.ts`通过`components["schemas"]["BindingSnapshot"]`等类型索引导出别名，不重写字段。验证后的Bearer claims只能由requireBearer写入请求context。缓存限定单请求；禁止模块级缓存auth实例/用户/session。

## 2. 任务清单

### T00：隔离工作区、固定基线和测试夹具

**Files:** 创建执行日志、`test/do/api-fixture.ts`、`src/test-utils/http.ts`、`src/auth-metadata.test.ts`；读取所有既有测试配置。消除夹具重复时可提取现有 `src/auth-two-factor.test.ts` 的内存auth构造函数，不能改其断言。

**Consumes:** 批准设计、基线225d1c6、当前Git状态。**Produces:** 可运行的同一假环境、基线结果、实际auth方法/path/配置摘要。

- [ ] 读取适用AGENTS/CLAUDE；使用`superpowers:using-git-worktrees`。若已在正确隔离工作区则复用；否则从主目录执行下面的核对/创建命令，任何已有同名目录先检查归属，不删除重建。

```bash
git status --short
git worktree list
git config user.name
git config user.email
git fetch origin main
git log -5 --oneline origin/main
git check-ignore .worktrees
git worktree add -b codex/api-v1-refactor .worktrees/api-v1-refactor origin/main
```

- [ ] 把主目录本次设计稿、执行计划及同名执行目录复制进新工作区；这些文档还未提交，不能假设origin/main已包含它们。保留原目录和其他worktree不动。工作区变更权限按工具沙箱流程申请，不额外询问架构设计。
- [ ] 在新工作区`npm ci`、`npm --prefix frontend ci`；记录Node/npm版本。按验收稿命令表跑基线，先记现有失败再开始改动。不要把历史506/89计数当本次结果。
- [ ] 建立两个夹具：Node下stub外部依赖的HTTP合同夹具、workerd下真实D1/KV/Auth/DO夹具。workerd用`applyD1Migrations`加载现有SQL；禁用remoteBindings，Resend与CQU容器出站由mock拦截，未声明出站应失败。
- [ ] 夹具提供固定接口：`createHttpFixture()`返回`{env, assetsFetch, doFetch, close}`；`createApiFixture()`返回`{request, signIn, issueToken, database, close}`。`request(path, init?)`跨真实app HTTP入口；`signIn(role): Promise<Headers>`生成测试登录Cookie headers；`database`类型为D1Database，`request`接收RequestInit并使用该夹具env；`issueToken({scopes, clientId, userId})`经本地OAuth provider签发用户token，返回headers。测试值只留内存，不写日志。负例JWT可用本地测试私钥签名，不能省略真正验签。
- [ ] 刻画issuer与Cookie，并把最终getEndpoints集合和disabled/server-only集合写入执行日志附件，脱敏规则见验收稿。下面的探针应通过并对照清单里的81个操作：

```ts
const ctx = await auth.$context;
const { api } = getEndpoints(ctx, auth.options);
const operations = Object.values(api)
  .filter(e => e.path && !e.options.metadata?.SERVER_ONLY)
  .filter(e => !auth.options.disabledPaths?.includes(e.path));
expect(new URL(ctx.baseURL).pathname).toBe('/api/auth');
expect(operations.find(e => e.path === '/get-session')?.options.method).toBe('GET');
```

- [ ] 以上是迁移前刻画测试，不伪造red。给T02开始的变化写新的失败断言。验证夹具关闭database/WS/计时器后提交`test: capture auth API migration baseline`。

**Gate:** BASE-01至BASE-04；完成后知道真实基线、精确操作集合，尚无业务变化。

### T01：共享纯定义与前后端导入边界

**Files:** 移动`src/capabilities.ts`/`src/user-roles.ts`及对应纯测试至`shared/`；创建`shared/api-paths.ts`、`shared/api-response.ts`；修改所有引用、root tsconfig/vitest include、frontend tsconfig。

**Consumes:** 原CAPABILITIES/PRESETS/USER_ROLE_OPTIONS。**Produces:** 同名纯共享导出，无后端实现被前端导入。

- [ ] 先跑角色/能力现有测试。新增边界fixture：前端import后端实现、共享importWorker运行时应被检查器拒绝；合法shared import应通过。检查器的完整实现与CI在T16完成，当前至少用TypeScript AST记录违规基线。
- [ ] `git mv`纯定义和测试，更新精确引用；CAPABILITIES键和值不能改。将API_BASE_PATH/AUTH_BASE_PATH放共享文件，不引入浏览器或后端依赖。

```ts
import { USER_ROLE_OPTIONS, canAccessAdmin } from './user-roles';
expect(USER_ROLE_OPTIONS.map(v => v.value)).toEqual(['user', 'admin', 'superAdmin']);
expect(canAccessAdmin('admin')).toBe(true);
expect(canAccessAdmin('user')).toBe(false);
```

- [ ] 前端5处后端import全部改shared；root vitest增加`shared/**/*.test.ts`，否则移动测试会悄悄少跑。
- [ ] 执行`npm test -- shared src/capabilities.test.ts src/user-roles.test.ts`时只选实际存在的路径；删除旧文件后改为`npm test -- shared`。执行两端typecheck，确认没有依赖副作用、没有仅重导出的旧壳。
- [ ] 对照API键、角色标签、RPC caps fixture通过后提交`refactor: isolate shared auth domain definitions`。

**Gate:** CLEAN-01、CLEAN-02、RPC-01。

### T02：HTTP schema、响应与错误基础

**Files:** 新增`src/api/problem.ts`、`src/api/problem.test.ts`、`src/api/validation.ts`、`src/api/validation.test.ts`；修改package/lock；不更改DO/RPC错误协议。

**Consumes:** 第2节合同。**Produces:** problem helper、统一验证hook和OpenAPIHono工厂`createApiRouter()`。

- [ ] 先为无效JSON、非JSON媒体、null/array、未知字段、空可选body与安全500写具体失败测试。
- [ ] 查询Context7/官方Hono文档，选择兼容现有Hono/Zod的`@hono/zod-openapi`精确版本；记录实际版本。安装后核对锁文件没有无关框架升级。用真实zod schema驱动handler验证。

```ts
const Body = z.strictObject({ enabled: z.boolean() });
expect(Body.safeParse({ enabled: true }).success).toBe(true);
expect(Body.safeParse({ enabled: 'true' }).success).toBe(false);
expect(Body.safeParse({ enabled: true, userId: 'other' }).success).toBe(false);
```

- [ ] 实现Problem Details与安全映射。测试使用真实Hono响应而非源码匹配：

```ts
const app = new Hono();
app.get('/failure', c => problem(c, 'INVALID_BODY', '请求体无效', 400));
const res = await app.request('/failure');
expect(res.headers.get('content-type')).toContain('application/problem+json');
expect(await res.json()).toEqual({
  type: 'about:blank', title: 'Bad Request', status: 400,
  detail: '请求体无效', code: 'INVALID_BODY',
});
```

- [ ] 保留每个资源特定业务code映射。通用语法错误INVALID_BODY，media错误UNSUPPORTED_MEDIA_TYPE；zod validation错误不能回显password值或全量输入。
- [ ] `npm test -- src/api/problem.test.ts src/api/validation.test.ts`先red后green；`npm run typecheck`。查看新增依赖与错误媒体类型diff后提交`feat(api): define validated v1 response contracts`。

**Gate:** HTTP-05至HTTP-09。

### T03：请求内一次身份验证与权限组合

**Files:** 新增`src/middleware/authentication.ts`/`.test.ts`、`src/services/oauth-scopes.ts`/`.test.ts`；修改`src/types.ts`、`src/middleware/scope.ts`、`src/rpc.ts`和引用。

**Consumes:** Env、Principal、现有ACL/verifyAccessToken。**Produces:** getRequestAuth及四个身份中间件；scope中间件只消费已验签principal。

- [ ] 先测试缺Cookie/Bearer、坏Bearer同时带好Cookie、缺sub/clientId、错issuer/audience、过期token以及普通admin/superAdmin。坏Bearer在S/B路径不得退回Cookie。
- [ ] 建立请求context的auth实例缓存，session认证读一次；Bearer仅调用verifyAccessToken一次。sub和azp/client_id必须是非空string，scope必须可解析为string列表，不把任意payload强转user。
- [ ] 保留session-only语义：只有Bearer无session应401；如果存在有效session，使用该session用户，Bearer不能覆盖它。requireAdmin之后仍执行插件/资源细粒度ACL。

```ts
expect(scopeSatisfies(['cqu:ticket:*'], 'cqu:ticket:jwxt')).toBe(true);
expect(scopeSatisfies(['cqu:ticket:any'], 'cqu:ticket:jwxt')).toBe(false);
expect(scopeSatisfies(['cqu:ticket:jwxt'], 'cqu:ticket:any')).toBe(false);
```

- [ ] 将HTTP/RPC共用纯scope函数移到service文件，RPC方法/返回形状不变。scope检查继续查client白名单，缺client身份不跳过白名单。旧资源验证器把根origin当issuer的配置错误在T05统一修正；不能允许从未验证的token自行选择issuer。
- [ ] 对两条同用户请求断言隔离，用户A请求的principal不会进入B请求。对一条取票请求断言验签一次、数据库授权一次、最终DO调用一次。
- [ ] 运行`npm test -- src/middleware src/services/oauth-scopes.test.ts src/rpc.test.ts`及typecheck后提交`refactor(auth): share request authentication and scope checks`。

**Gate:** AUTH-01至AUTH-06、RPC-01。

### T04：API/页面分界与版本路由装配

**Files:** 新增`src/app.ts`、`src/app.test.ts`、`src/api/v1/index.ts`、`src/api/operations.ts`/`.test.ts`、`src/api/legacy.ts`/`.test.ts`；精简`src/index.ts`。

**Consumes:** createApiRouter、旧app、ASSETS。**Produces:** createApp/createV1Api、有限legacy转发、JSON404/405、health C01。

- [ ] 先建立真实ASSETS spy的失败测试；未知API、方法错误不能请求ASSETS，页面必须请求ASSETS。

```ts
const f = createHttpFixture();
const app = createApp();
const res = await app.request('/api/v1/does-not-exist', {}, f.env);
expect(res.status).toBe(404);
expect(res.headers.get('content-type')).toContain('json');
expect(f.assetsFetch).not.toHaveBeenCalled();
await app.request('/login', {}, f.env);
expect(f.assetsFetch).toHaveBeenCalledTimes(1);
await f.close();
```

- [ ] 把HTTP装配移出index；fetch/email/queue/所有Worker导出不变。Node测试导入app，不导入含cloudflare:workers的index。
- [ ] 实现v1 health、API错误fallback、路径匹配和Allow。只对真实GET提供HEAD，排除C07；OPTIONS合法预检无业务副作用。全局CORS迁入API/协议需要的作用域，保留现有客户端可用的来源策略，不为cookie允许任意Origin凭证。
- [ ] legacy router接受一个forwardToV1回调，按精确方法/模板匹配，避免循环依赖；只为已迁移模块替换原挂载。此时旧未迁移模块继续工作；后续每项迁移都移除对应旧handler，不留两份业务实现。
- [ ] JSON响应转换不得破坏原status/headers；101直接返回；Set-Cookie逐条保留。增加请求method/query/raw-body/Origin/Authorization/cf的保留测试。
- [ ] `npm test -- src/app.test.ts src/api/operations.test.ts src/api/legacy.test.ts`、typecheck通过后提交`refactor(api): separate versioned routes from SPA fallback`。

**Gate:** HTTP-01至HTTP-04、HTTP-10、LEG-01至LEG-04。

### T05：Better Auth v1、稳定issuer与真实协议兼容

**Files:** 新增`src/auth-config.ts`/`.test.ts`、`src/api/auth-operations.generated.ts`、`src/api/v1/auth.ts`、`src/api/discovery.ts`、`test/do/auth-api-migration.test.ts`；修改`src/auth.ts`、app/legacy；前端AuthError页面及App路由在T13消费，当前错误入口可先返回固定302至该路径。

**Consumes:** T00元数据与B01–B81、disabled/server-only列表。**Produces:** 认证新旧入口同一实现、D01–D05、固定issuer/audience策略。

- [ ] 将T00刻画保存在测试fixture中，再写迁移后期望；首次应因basePath/端点URL尚未迁移失败。旧issuer/Cookie字段作为固定基线保留；旧ctx.baseURL断言只对legacy配置fixture运行，不继续拿它断言已经迁移的生产createAuth。legacy签发fixture仅用本地betterAuth选项覆写basePath模拟原配置，不保留第二份生产auth实现。

```ts
expect(authUrls('https://auth.cqu.moe')).toEqual({
  basePath: '/api/v1/auth',
  issuer: 'https://auth.cqu.moe/api/auth',
  jwksUrl: 'https://auth.cqu.moe/api/v1/auth/jwks',
});
```

- [ ] createAuth设置新的basePath；配置jwt发行者与oauth-provider validAudiences保持原身份语义。核对1.6.11本地类型/source，不以两factor的issuer选项代替JWT issuer。JWKS key不轮换，session/Cookie storage namespace不重建。
- [ ] 用T00本地auth配置的最终getEndpoints生成`src/api/auth-operations.generated.ts`，内容仅方法/路径，供createApp在无请求env时装配；测试独立对比真实getEndpoints，禁止手写列表成为第二事实源。此生成入口在T12并入generate:api。按这些实际方法/path注册auth入口。disabledPaths保留6个原值；SERVER_ONLY不挂HTTP；动态`:id`/`:token`按单段匹配。注册拦截必须仍在对应sign-up handler之前，新旧路径共用handleInvitationSignup。
- [ ] 把新旧请求规范为同一个rate-limit路径；保留原始form-urlencoded token/introspect/revoke处理。补D01–D05，metadata指向v1且issuer不变。默认HTML/error改受控302，绝不转发任意错误description/URL。
- [ ] 同一个真实本地D1/KV中：用旧配置签发session/token、生成重置回调；切新配置后使用；再反向用旧地址调用新实现。用真实签名验证旧/新token、wrong issuer/audience拒绝，验证old refresh token仍能refresh且token scope/caps不扩大。
- [ ] 新旧OTP地址交替发送达到同一限频；验证限频key没有因前缀拆成两份。注册并发、OTP复用、2FA临时Cookie、trust-device和恢复码继续通过。
- [ ] 运行`npm test -- src/auth-config.test.ts src/auth-two-factor.test.ts src/auth-profile.test.ts src/auth-metadata.test.ts`；运行`npm run test:do -- test/do/auth-api-migration.test.ts test/do/registration-invitations.do.test.ts`及两端相关类型检查。旧预置token失败不能通过放宽验签来消除。
- [ ] 更新当前测试helper硬编码basePath，并保留专门的legacy用例后提交`refactor(auth): mount auth v1 with stable OAuth identity`。

**Gate:** AUTH-07至AUTH-18、LEG-05至LEG-08、OAS-02、OAS-03。

### T06：CQU绑定资源和WebSocket迁移

**Files:** 新增v1 cqu-binding handler/schema与`test/do/cqu-binding-api.test.ts`；迁移既有`src/routes/cqu-bind.test.ts`至新位置；修改legacy；保留`src/services/cqu-binding.ts`为绑定真值实现。

**Consumes:** C04–C08、session/Bearer中间件、getCquBinding、CquSessionDO。**Produces:** 规范响应的绑定API和可用旧地址。

- [ ] 把现有凭证/地址优先级8种状态矩阵保留，添加v1 envelope、用户隔离、坏输入、只一次身份验证断言；运行应先因新地址不存在/响应形状不同失败。

```ts
const res = await f.request('/api/v1/cqu/binding', { headers: await f.signIn('user') });
expect(res.status).toBe(200);
expect(await res.json()).toMatchObject({
  data: { bindStatus: 'unbound', sessionStatus: expect.any(Object) },
});
```

- [ ] 移动创建/状态/凭证/删除handler并接schema。C04空body继续可用；forward明确返回原403 code；删return后的白名单构造，不删服务层旧forward读取或邮件校验。
- [ ] 保留并发创建幂等、pending先写、仅回滚本次插入凭证ID、旧凭证更新失败保留、激活两表batch、DO非JSON/失败处理、BIND_ACTIVATE_FAILED/503。解除绑定维持现有可重试及DO best-effort语义，不宣称D1和DO跨服务原子。
- [ ] WS仍要求Upgrade和与BETTER_AUTH_URL完全相同的Origin；无Origin/恶意Origin403，非upgrade426。真实workerd检验101+webSocket对象及原有消息/ping-pong，新旧路径都可连接且不能访问另一个用户DO。
- [ ] 实现C04–C08 legacy映射，前端未迁移时应继续可用。禁止把101响应读成JSON或重建成普通Response。
- [ ] `npm test -- src/api/v1/cqu-binding.test.ts`、`npm run test:do -- test/do/cqu-binding-api.test.ts test/do/cqu-session.do.test.ts`和typecheck通过后提交`refactor(api): migrate CQU binding resources to v1`。

**Gate:** CQU-01至CQU-10、LEG-02、LEG-03。

### T07：出票改POST与快捷登录开关

**Files:** 新增v1 cqu-service-tickets/cqu-quicklogin的handler/schema/测试；修改legacy、scope；删除迁移完的旧cqu/cqu-quicklogin路由。

**Consumes:** C03/C09/C10、认证principal、现有service URL校验/DO。**Produces:** 不可由GET铸票的新接口、同语义session-only开关。

- [ ] 为POST合法目标、缺目标、双目标、恶意URL、GET/HEAD无副作用写red；旧GET双目标serviceUrl优先单独测试。

```ts
expect(TicketTargetSchema.safeParse({ service: 'jwxt' }).success).toBe(true);
expect(TicketTargetSchema.safeParse({ service: 'jwxt', serviceUrl: 'https://sso.cqu.edu.cn/' }).success).toBe(false);
const res = await f.request('/api/v1/cqu/service-tickets', { method: 'GET' });
expect(res.status).toBe(405);
```

- [ ] 正式handler验证B principal→目标→token/client scope→DO；把clientId、source=route及规范化serviceUrl交给DO。201只含ticket，不向客户端回显原始serviceUrl；保持no-store和既有取票业务错误code。
- [ ] 对票据失败，mock DO返回含秘密的error/message，断言客户端只得到安全固定说明与稳定code；对限频返回429，不吞成500。
- [ ] 快捷登录仅session用户可读写自己的flag；无access时GET eligible=false、PUT403；两flag不互相替代。Bearer带另一人的sub不能替换有效session的主体。
- [ ] 检查失败请求不会触发DO；通过请求只调用DO一次。迁移legacy GET及旧裸JSON响应，继续调用同一handler，不保留旧cqu业务实现。
- [ ] `npm test -- src/api/v1/cqu-service-tickets.test.ts src/api/v1/cqu-quicklogin.test.ts src/services/service-url.test.ts src/middleware`、DO原有出票测试及typecheck通过后提交`refactor(api): version ticket issuance and quicklogin preferences`。

**Gate:** CQU-11至CQU-18、AUTH-01至AUTH-06、LEG-04。

### T08：用户管理、角色与CQU吊销

**Files:** 新增`src/api/v1/admin/users.ts`/`.schema.ts`/`.test.ts`；从admin.ts移走C11/C12/C13/C19；更新legacy。

**Consumes:** A中间件、BetterAuth用户API、CQU DO。**Produces:** 属性式用户更新和明确分页合同。

- [ ] 为`page=abc|0|-1|1.5|1e3`、`limit=101`及双字段update写red，断言请求不触发写入。

```ts
expect(UserPatchSchema.safeParse({ banned: true }).success).toBe(true);
expect(UserPatchSchema.safeParse({ role: 'admin' }).success).toBe(true);
expect(UserPatchSchema.safeParse({ banned: true, role: 'admin' }).success).toBe(false);
expect(UserPatchSchema.safeParse({ action: 'ban' }).success).toBe(false);
```

- [ ] 分页校验后再调用listUsers。保留用户字段和pagination结构；将APIError显式映射，不让用户权限失败变成500。
- [ ] `banned`调用原ban/unban；`role`调用setRole，权限交给已配置插件判断。普通admin可ban，不能升角色；superAdmin保留权限。
- [ ] CQU状态变更保持凭据及地址，不等同DELETE binding。DO非2xx返回原CQU_BINDING_UPDATE_FAILED/500，不谎报成功；写日志不含原始秘密。
- [ ] legacy `{action:'ban'|'unban'}`保持原优先级和原成功返回，不允许新属性式协议意外破坏旧页面。
- [ ] `npm test -- src/api/v1/admin/users.test.ts src/api/legacy.test.ts`加真实auth权限integration与typecheck，通过后提交`refactor(api): model admin user updates as resource changes`。

**Gate:** ADMIN-01至ADMIN-05、LEG-09。

### T09：邀请与注册策略

**Files:** 新增admin/invitations handler/schema/测试、v1 registration-settings；修改legacy及注册handler的应用schema metadata；保留registration-invitations service。

**Consumes:** C02/C14–C18、handleInvitationSignup及原注册策略。**Produces:** 新旧管理接口、公开设置和一致邀请码合同。

- [ ] 为无权限创建、畸形JSON不能生成邀请、preset不存在、公开响应不泄露名单写red。

```ts
const res = await f.request('/api/v1/registration-settings');
expect(res.status).toBe(200);
expect(Object.keys((await res.json()).data)).toEqual(['invitationRequired']);
```

- [ ] 创建邀请仍可空body，默认preset=null，8位code和7天有效期不变；新建201、撤销204。公开设置只有invitationRequired；写策略仍需EA。
- [ ] signup原字段是`code`，不是invitationCode。OpenAPI添加可选code格式，注明invitationRequired为真时由业务强制必填；schema不能永远强制code从而破坏公开注册。
- [ ] 真实测试新旧注册并发争同一code只有一条成功路径，claim失败释放/失效语义保持；邀请码preset优先于全局preset；策略关闭时无码可注册；有坏码仍按原错误拒绝。
- [ ] 验证注册拦截剥掉code后传给BA，保留email/密码/OTP/回跳。不为测试创建真实邮件，不记录code/OTP等真实输入。
- [ ] `npm test -- src/api/v1/admin/invitations.test.ts src/services/registration-invitations.test.ts`、`npm run test:do -- test/do/registration-invitations.do.test.ts test/do/auth-api-migration.test.ts`通过后提交`refactor(api): version invitation and registration resources`。

**Gate:** ADMIN-06至ADMIN-10、AUTH-13、OAS-04。

### T10：权益资源与预设合并

**Files:** 新增admin/entitlements handler/schema/测试；从admin.ts迁移C20–C28；按需要在现有entitlements service提取实际复用的批量写函数；更新legacy。

**Consumes:** shared能力目录、validateEntitlementItems、EA/ER。**Produces:** 原子replace、按键merge、预设CRUD及默认配置。

- [ ] 写red区分PUT整组替换与PATCH预设合并；模拟insert失败读回原数据，不能只spy断言调用batch。

```ts
const before = [
  { subsystem: 'calendar', capability: 'share', value: '1' },
  { subsystem: 'calendar', capability: 'sync', value: '0' },
];
const preset = [{ subsystem: 'calendar', capability: 'sync', value: '1' }];
const headers = await f.signIn('superAdmin');
headers.set('content-type', 'application/json');
const session = await f.request('/api/v1/auth/get-session', { headers }).then(r => r.json());
const path = `/api/v1/admin/users/${session.user.id}/entitlements`;
expect((await f.request(path, {
  method: 'PUT', headers, body: JSON.stringify({ items: before }),
})).status).toBe(200);
expect((await f.request('/api/v1/admin/entitlement-presets/merge-case', {
  method: 'PUT', headers, body: JSON.stringify({ items: preset }),
})).status).toBe(200);
expect((await f.request(path, {
  method: 'PATCH', headers, body: JSON.stringify({ preset: 'merge-case' }),
})).status).toBe(200);
const body = await f.request(path, { headers }).then(r => r.json());
const items = body.data.map((row: EntitlementItem) => ({
  subsystem: row.subsystem, capability: row.capability, value: row.value,
}));
expect(items).toHaveLength(2);
expect(items).toEqual(expect.arrayContaining([before[0], preset[0]]));
```

- [ ] 复用目录校验，新增HTTP对象/字段校验，不写第二份flag/quota语义。未知键/重复复合键400；失效数据库preset409 INVALID_PRESET；未知preset400 UNKNOWN_PRESET。
- [ ] PUT delete+insert仍一个batch；空数组只delete。PATCH只替换preset涵盖的复合键，保留其他子系统/能力；批内失败全部回滚。
- [ ] C24/C25中文和百分号预设名只解码一次；删除默认预设时清配置。GET/PUT默认preset允许null，但v1缺preset不是静默清空；legacy旧省略语义放适配器。
- [ ] 普通admin只能读；EA/ER分别按资源要求执行。针对每个写方法跑401/403和无写入断言。
- [ ] `npm test -- src/api/v1/admin/entitlements.test.ts src/services/entitlements.test.ts`，真实D1的batch失败集成测试和typecheck通过后提交`refactor(api): unify entitlement resource operations`。

**Gate:** ADMIN-11至ADMIN-18、LEG-10。

### T11：OAuth客户端、secret和scope事务

**Files:** 新增admin/oauth-clients handler/schema/测试、`src/services/oauth-clients.ts`/`.test.ts`；迁移C29–C35；更新legacy。admin.ts完成清空后删除旧文件。

**Consumes:** 现有OAuth adapter、权限、secret helper、CQU scopes表。**Produces:** 单一正式字段集、201创建/204删除、严格权限和原子scope替换；`serializeOAuthClient(row: OAuthClientRow): OAuthClientView`保留原读取容错但不泄露secret。

- [ ] 为列表不得含secret/hash、admin不得写scope、scope插入失败回滚、公开client不可轮换、public/confidential切换写red。
- [ ] 提取实际重复helpers，保留snake_case↔模型字段映射和SQLite字符串数组兼容。新列表删除id/clientId/name别名；legacy负责补回，不让新schema带重复字段。
- [ ] create复用plugin实际输入校验，返回201；patch拒任意secret直写，使用最终合并配置校验URI/type/grants/scopes；返回client_id以及本次必要的secret。secret明文只出现在创建/轮换/切换本次响应；一律no-store。

```ts
const view = serializeOAuthClient({ clientId: 'local-client', clientSecret: 'hash-not-for-output' });
expect(view.client_id).toBe('local-client');
expect(view).not.toHaveProperty('client_secret');
expect(view).not.toHaveProperty('clientSecret');
expect(view).not.toHaveProperty('clientId');
```

- [ ] scope PUT显式检查CS权限，duplicate400，delete+insert走同一D1 batch；失败后查询确认原行保留。记录这是修复原实现，不写“原来就是原子”或“权限完全没变”。
- [ ] secret POST到/secrets仍使用现有哈希；旧rotate-secret映射到这里。测试新secret能完成token请求、旧secret不能；public→confidential生成一次，反向清除。
- [ ] 删除顺序保留accessToken→refreshToken→consent→client→scope；重复删除204；不能因无外键级联留下自有scope。检查异常不返回200。
- [ ] `npm test -- src/api/v1/admin/oauth-clients.test.ts src/services/oauth-clients.test.ts src/utils/oauth-secret.test.ts`、真实D1/OAuth集成及typecheck通过后提交`refactor(api): normalize OAuth client administration`。

**Gate:** ADMIN-19至ADMIN-28、LEG-11、LEG-12。

### T12：完整契约、Cloudflare投影和生成类型

**Files:** 新增`src/api/openapi/{auth,document,cloudflare}.ts`及对应测试；新增scripts/generate-api/check-api、`docs/api/openapi.json`、`docs/api/cloudflare.openapi.json`、`docs/api/endpoints.json`、`docs/api/coverage.json`、`shared/api-types.generated.ts`；修改package scripts。

**Consumes:** C01–C35、M01、B01–B81、D01–D05的最终runtime定义和schema。**Produces:** 机器可读完整文档、可检查的CF3.0.3投影、前端类型与漂移门禁。`toCloudflareSchema(schema: Record<string, unknown>, pointer: string): Record<string, unknown>`转换单个schema节点；`buildCloudflareSchema(document)`负责文档结构和有记录的覆盖投影。

- [ ] 先写集合比较red：runtime有而schema没有、schema多出POST/get-session、重复operationId、未定义ref、误挂SERVER_ONLY、错误auth policy均应使check失败。不能只断言schema路径数大于0。
- [ ] 自定义schema在route注册位置唯一声明，固定component名ApiProblem/PageInfo/BindingSnapshot/CquSessionStatus/EntitlementItem/EntitlementPreset/RegistrationInvitation/OAuthClientView；T01通用类型与schema用TypeScript一致性检查约束。BA通过openAPI插件server API生成。禁止公开默认HTML reference，生成helper不自动增加额外HTTP入口；最终仅M01公开完整契约。
- [ ] 完整文档固定OAS3.1.1。把BA遗留nullable语义和自定义3.0 schema规范化为3.1语义；组件命名加Auth前缀避免User等冲突，递归重写内部ref，裁剪不再被引用的内部模型。
- [ ] 以最终getEndpoints覆盖集合为准修正BA：去掉幻影POST/get-session，补customSession.user/session/caps及signup.code，按真实middleware/测试设置security；匿名OTP/登录不能标成Bearer-only，session-only不能写Bearer OR cookie。
- [ ] 生成endpoints.json：每个host/method/path/operationId及kind（canonical/legacy/discovery/websocket）。legacy JSON schema按旧输入形状独立投影，不能把新POST body复制给旧GET query。D03/D04是永久discovery例外，不随legacy开关删除。
- [ ] buildCloudflareSchema转换实际schema：类型+null→nullable，const→单值enum，数值exclusiveMinimum/Maximum→3.0 bound+布尔，内部ref保留。多种非null类型用有明确type的分支；不支持且可能改变校验含义的关键字抛含JSON pointer的错误。不能只改openapi版本。

```ts
const cf = toCloudflareSchema({
  type: ['string', 'null'],
}, '#/components/schemas/Status');
expect(cf).toEqual({ type: 'string', nullable: true });
expect(toCloudflareSchema({ type: 'string', const: 'active' }, '#/Status'))
  .toEqual({ type: 'string', enum: ['active'] });
expect(() => toCloudflareSchema({
  type: 'object', unevaluatedProperties: false,
}, '#/components/schemas/Unsupported')).toThrow('#/components/schemas/Unsupported');
```

- [ ] 对CF不能验证的form body/WS消息/响应，完整文档保留协议；CF投影可只保留method/path/参数，但必须在coverage.json逐项记录“body不受schema校验”和原因。不得把这种显式投影当成全覆盖；也不得无记录地移除JSON约束。
- [ ] CF文档OAS3.0.3，绝对server URL、无外部ref、实际method/path；节点/参数必须满足CF文档限制。针对当前结构运行独立OpenAPI validator。转换前后用合法/非法样本对同一JSON body做语义一致测试。
- [ ] `generate:api`本地确定性生成，不查询生产；`check:api`在临时目录重生成逐字比较，修改产物/缺少端点/多余端点时非零退出。openapi-typescript只生成types；生成文件不含后端运行时import。
- [ ] `npm run generate:api`连续两次无diff、`npm run check:api`、`npm test -- src/api/openapi`及typecheck通过后提交`feat(api): generate verified OpenAPI contracts and client types`。

**Gate:** OAS-01至OAS-14、CLEAN-02。

### T13：前端API客户端、认证配置与普通页面迁移

**Files:** 新增`frontend/src/lib/api/{http,registration,cqu,types}.ts`及测试、`frontend/src/pages/AuthError.tsx`；修改auth-client、Register/Settings/CquBindWizard、App和Vite代理；消费generated类型。

**Consumes:** v1契约和shared/api-types.generated。**Produces:** 原生认证客户端+集中自定义API请求，普通页面不直接拼旧路径。

- [ ] 为标准D<T>、分页完整返回、204不解析JSON、Problem错误、上游HTML错误、AbortSignal写red。API client不重试写请求，不自动吞401，也不把错误默认成成功/未绑定。
- [ ] 固定HTTP函数签名：`apiRequest<T>(path: string, init?: RequestInit): Promise<T>`返回完整解析响应；204返回undefined。路径是以`/`开头的资源相对路径，拒绝绝对URL和`//host`，最终前缀取API_BASE_PATH。domain wrapper解包data；listUsers保留pagination。

```ts
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}
// cqu.ts 的公开接口从生成类型选择DTO，不能重复手写BindingSnapshot。
export async function getBinding(signal?: AbortSignal): Promise<BindingSnapshot> {
  const body = await apiRequest<ApiSuccess<BindingSnapshot>>('/cqu/binding', { signal });
  return body.data;
}
```

- [ ] 对非JSON上游错误返回安全ApiError，不把HTML插入页面；AbortError原样上抛，让卸载/取消不闪错误。凭据设置credentials:'include'；body有JSON时再设置Content-Type，不能给GET/WS乱加body。
- [ ] authClient显式basePath，插件及twoFactorPage/onTwoFactorRedirect保持；验证Register读取D<{invitationRequired}>，不用旧错误链`detail.error.message`。OTP/ChangeEmail/2FA继续使用官方客户端，不重写插件API。
- [ ] 新增安全AuthError页面和App route；保留现有Layout、简体中文和回登录链接。Vite的/api代理开启ws；本地WebSocket使用当前站点URL且后端BETTER_AUTH_URL与页面origin相配，不放宽生产Origin检查。
- [ ] 登录→OTP→2FA→绑定→返回Schedule的嵌套redirect、encode规则和会话refresh顺序保持。getBinding临时错误必须沿用现有waiting/retry，不变成unbound。
- [ ] `npm test -- frontend/src/lib/api frontend/src/pages/auth-continuation.test.tsx frontend/src/pages/VerifyEmail.test.tsx frontend/src/pages/CquBindWizard.test.tsx`及frontend build/lint通过后提交`refactor(frontend): centralize v1 API access`。

**Gate:** WEB-01至WEB-08、AUTH-13至AUTH-18、CLEAN-01。

### T14：管理台按功能拆分并迁移全部调用

**Files:** 新增`frontend/src/lib/api/admin.ts`及测试；新增features/admin四个Section和必要的共置Modal/表单；精简pages/Admin.tsx；复用现有EntitlementFields/MenuSelect。

**Consumes:** C11–C35、OAuthClientView正式字段、现有管理页面UI。**Produces:** 管理页面只组合模块，所有请求经admin client。

- [ ] 在原UI上记录用户列表、邀请、预设、OAuth编辑/secret展示的基线fixture；新增真实点击/提交测试，mock HTTP而不是mock整个组件。禁止只断言渲染一段静态文字。
- [ ] 按现有符号移动：UsersSection保留同名；RegistrationInvitationsSection移为InvitationsSection；PresetsSection移为EntitlementsSection，PresetEditor随其共置；OAuthClientsSection保留同名，OAuthClientEditor/CredentialModal/DeleteConfirmModal随其共置；EntitlementPanel作为用户权益面板保留其当前调用关系。保留现有tab和布局，不为拆分引入新路由状态管理库。
- [ ] 建立typed admin methods：listUsers、updateUser、listInvitations、createInvitation、revokeInvitation、getRegistrationSettings、updateRegistrationSettings、getUserEntitlements、replaceUserEntitlements、mergeEntitlementPreset、listPresets、replacePreset、deletePreset、getDefaultPreset、setDefaultPreset、listOAuthClients、createOAuthClient、updateOAuthClient、deleteOAuthClient、getOAuthClientScopes、replaceOAuthClientScopes、createOAuthClientSecret。参数/结果均从生成类型选择，不新增字符串拼接工具层。
- [ ] 用户ban调用新banned属性、预设应用改PATCH、轮换改POST secrets、删除成功不读JSON。列表使用client_id，去掉对id/clientId/name旧别名的依赖；保留普通admin的只读UI和后台403状态反馈。

```ts
const fetchMock = vi.fn().mockResolvedValue(Response.json({ data: { id: 'local-user', banned: true } }));
vi.stubGlobal('fetch', fetchMock);
await updateUser('local-user', { banned: true });
expect(fetchMock).toHaveBeenCalledWith(
  '/api/v1/admin/users/local-user',
  expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ banned: true }) }),
);
vi.unstubAllGlobals();
```

- [ ] OAuth完整表单字段、数组空值省略、scope、public/confidential切换和secret只显示本次结果保持。提交失败不关闭弹窗、不清空用户输入；取消和切tab不触发写请求。
- [ ] `npm test -- frontend/src/features/admin frontend/src/lib/api/admin.test.ts`，frontend build/lint；本地浏览器对比desktop/mobile管理页面及主要弹窗后提交`refactor(frontend): split admin features around v1 resources`。

**Gate:** WEB-09至WEB-13、ADMIN-19至ADMIN-28、CLEAN-03。

### T15：绑定事件transport与重复控件合并

**Files:** 新增shared/cqu-events、frontend/lib/api/binding-events及测试；修改Settings/CquBindWizard；新增共用CopyButton及必要行为测试。

**Consumes:** 原DO WS消息、两页面各自的生命周期约束。**Produces:** 一个可关闭的连接实现，页面仅保留消费策略和展示。

- [ ] 使用fake WebSocket+fake timer写red，覆盖StrictMode重挂、主动close、异常close、延迟onopen/onmessage、pong/畸形消息、重试定时器清理；再用workerd真实WS证明协议仍可通。
- [ ] 固定transport接口如下；它在调用时建一次连接，close()幂等且阻止晚到回调。retry/ping来自调用者现有行为，不偷偷统一成不同产品策略。

```ts
type BindingConnectionOptions = {
  onEvent: (event: CquBindingEvent) => void;
  onState: (state: 'connecting' | 'open' | 'closed' | 'error' | 'failed') => void;
  shouldReconnect: () => boolean;
  retry: { delayMs: number; maxAttempts: number | null };
  heartbeatMs: number | null;
};
export function openBindingEvents(options: BindingConnectionOptions): { close(): void };
```

- [ ] Settings保持展开才连接、折叠即关闭、30秒ping、3秒重试且最多5次、成功后清重试次数；Wizard保持3秒重试、收到code后不再重连、卸载停止，maxAttempts=null/heartbeatMs=null对应基线。页面处理login_2fa/bind_code的过滤、最多卡片数/倒计时保持。
- [ ] 共享parse函数拒绝畸形非对象消息，忽略pong，不输出code到日志；WS URL只在transport构造，使用/api/v1/cqu/binding/events。旧forward恢复页面仍能消费绑定事件。
- [ ] 合并三处CopyButton重复的剪贴板/复位计时器逻辑，保留各处label、大小、样式、aria；卸载清timer，复制失败有现有反馈。只有确认所有支持的调用环境都不需要时才删旧fallback。
- [ ] `npm test -- frontend/src/lib/api/binding-events.test.ts frontend/src/pages/CquBindWizard.test.tsx frontend/src/components/CopyButton.test.tsx`、frontend build/lint与真实WS测试通过后提交`refactor(frontend): share binding events and clipboard behavior`。

**Gate:** WEB-14至WEB-18、CQU-07至CQU-10、CLEAN-04。

### T16：删除已迁出的实现、修正文档和CI门禁

**Files:** 删除无调用旧routes/error helper/共享转发壳；更新`package.json`/lock、scripts/check-boundaries、`tsconfig`/vitest、`frontend/eslint.config.js`、`.github/workflows/deploy.yml`、CLAUDE.md/HANDOFF.md/当前接入文档；新建`docs/api/README.md`说明契约和例外。

**Consumes:** T01–T15全部替代实现与证据。**Produces:** 无业务重复实现、自动导入边界/契约漂移/实际前端typecheck门禁。

- [ ] 全仓rg/TypeScript引用扫描包括配置、测试、Worker导出、容器入口；建立`cleanup-ledger.md`：每个删除项写删除原因、调用证据、替代位置或确为不可达、对应测试。不能把目录中没有import当成入口无用。
- [ ] 清除剩余前端旧路径、重复fetch/error/schema/type/鉴权；保留legacy明确列表。更新过时注释：scope事务真实状态、LOGIN_NODE测试说明、keepalive当前时长等。历史设计与冻结参考保持原样。
- [ ] 删除危险db:generate脚本和无意义package初始化字段（仅删除确认不供工具消费的description/main/directories等）；新迁移仍手写，本次不创建SQL迁移。build:frontend只调用已安装前端的build，不在build阶段隐式npm install。
- [ ] 完成AST导入边界检查：按tsconfig解析relative/alias、import/export/dynamic-import；frontend不得解析到后端src，shared不得引Worker/DB/Hono/React实现。用临时fixture验证违规非零、正常零退出，不能只扫`../../../src`字符串。
- [ ] CI增加check:api/check:boundaries、frontend lint、Workers typecheck/test；前端类型检查改真实`tsc -b`或直接使用既有build内的`tsc -b`。避免仅对references根执行`tsc --noEmit`然后宣称前端通过。
- [ ] 更新CI路径过滤使`docs/api/**`产物变化也触发门禁，普通设计Markdown仍可忽略。保留main部署/其他分支上传的现有语义；本轮不push来触发它们。
- [ ] 记录净源代码行数/文件责任/消除的重复点，允许schema与测试增加总行数；不为了负增长删合同、权限或测试。不能制造只转发一行的多层抽象。
- [ ] 完成check:boundaries、check:api、两端检查和删除影响测试后提交`chore: enforce API contracts and remove migrated code`。

**Gate:** CLEAN-01至CLEAN-08、GATE-01。

### T17：逐项验收与最终交付

**Files:** 更新execution-log、新增`acceptance-results.md`、cleanup-ledger；不修改生产配置或外部客户端仓库。

**Consumes:** 所有已通过任务、独立验收稿。**Produces:** 本地已验证重构和清楚标记的未发布/兼容期状态。

- [ ] 按验收稿命令表执行最终质量门禁，逐个记录exit code/测试数/范围/commit。没有代码变更、失败或新问题时，不反复重跑同一整套检查。
- [ ] 逐条勾验收ID，关联测试名/文件/命令/结果；真实用户流程用本地mock邮件与CQU出站、真实HTTP/auth/session/WS组合验证，并做现有页面的浏览器交互回归。
- [ ] 运行runtime↔OpenAPI↔CF投影↔legacy映射集合比较；检查CF覆盖例外，确认未发布secret或带真实凭据的截图/日志。
- [ ] 验证原RPC方法/返回、email/queue/DO命名导出和迁移图不变。不能仅靠TypeScript通过推断已有部署状态兼容。
- [ ] 汇总与设计的差异：明确列出新增strict输入、scope ACL/事务修复、service-ticket POST、响应规范化、旧地址保留、永久discovery例外。
- [ ] 最终报告给出工作区/branch/基线与HEAD/提交列表、迁移覆盖、清理成果、通过/失败/环境阻塞验收ID。必须写明“未push、未部署、未启用Cloudflare防护；旧地址尚未退役”。如果存在必需用例未通过，结论只能是未完成。

**Gate:** RPC-01至RPC-03、GATE-01至GATE-05，以及所有必需验收项。

## 3. 执行边界与恢复

每任务本地commit是恢复点，提交前查看目标文件diff和测试结果。只stage本任务文件，不使用`git add .`混入他人工作。中途失败保留现状和日志，继续不依赖失败项的文档整理；不要撤销他人的修改、清空其他worktree、批量删stash或reset主目录。

遇到以下情况才需要外部输入：用户身份缺失导致无法确定提交作者、签名工具要求解锁、真实沙箱/网络权限拒绝且无本地替代、最新main产生无法判断的业务冲突。失败不能成为取消测试或改变安全合同的理由。无需再次请求设计批准。

这份计划不包含旧地址的实际退役，也不包含CF上传/线上规则启用。退役的前置证据在验收稿单列，执行者不得偷偷添加一个日期自动停用。

## 4. 文档/工具入口

查文档先读取`context7:context7-mcp`；不可调用时按AGENTS使用Exa官方来源。验证库安装的精确版本及锁文件，记录到日志。

- Hono schema：[Zod OpenAPI](https://hono.dev/examples/zod-openapi)。
- BA 1.6：[OpenAPI](https://better-auth.com/docs/1.6/plugins/open-api)及已安装1.6.11源码；源码证据包括生成器硬编码bearerAuth、幻影POST/get-session和HTML/error。
- CF：[Schema Validation](https://developers.cloudflare.com/api-shield/security/schema-validation/)。
- 错误格式：[RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html)。
- 文档校验使用`@redocly/cli`，从[minimal ruleset](https://redocly.com/docs/cli/rules/ruleset-templates)起步，struct/no-unresolved-refs/operation-operationId-unique/path-parameters-defined/security-defined设error；风格warning不代替schema失败。

T12增加dev依赖`tsx`、`openapi-typescript`、`@redocly/cli`并锁定实际安装版本。推荐script合同如下，脚本以非零退出报告失败，不在check中覆盖tracked产物：

```json
{
  "generate:api": "tsx scripts/generate-api.ts",
  "check:api": "tsx scripts/check-api.ts",
  "check:boundaries": "tsx scripts/check-boundaries.ts",
  "lint:api": "redocly lint docs/api/openapi.json docs/api/cloudflare.openapi.json"
}
```

`check:api`包括临时重生成对比和运行时覆盖；`lint:api`独立验证OpenAPI结构，两者都必需。read-only的元数据生成可用临时本地DB，但不能要求生产secrets、真实注册或互联网。
