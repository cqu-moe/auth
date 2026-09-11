# API v1 重构执行日志

基线：`225d1c66d9b15ae13b9c710227649c1d47516aa4`（2026-09-11 fetch 后的 `origin/main`）

工作区：`/Users/uu/Developer/cqu-moe/auth/.worktrees/api-v1-refactor`

分支：`codex/api-v1-refactor`

Node/npm：`v22.22.3` / `10.9.8`

| 任务ID | 状态 | 改动文件 | red命令/失败原因 | green命令/结果 | 关联验收ID | commit或未提交原因 |
| --- | --- | --- | --- | --- | --- | --- |
| T00 | 通过 | 四份执行输入、`src/test-utils/{auth,http}.ts`、`test/do/api-fixture.ts`、auth元数据刻画 | 迁移前刻画不伪造red；基线 `typecheck:do` 因既有 `ownerBrowserRouteVersion` 类型错误 exit 2；沙箱内 Workers 测试监听127.0.0.1为EPERM | `npm ci` exit 0；`npm --prefix frontend ci` exit 0；`npm run typecheck` exit 0；`npm test` 53 files/506 tests exit 0；获准本地监听后 `npm run test:do` 3 files/89 tests exit 0（保留既有Containers警告）；frontend `tsc -b`/lint/build均exit 0；`npm test -- src/auth-metadata.test.ts` 2/2；`npm run test:do -- test/do/api-fixture.test.ts` 1/1 | BASE-01–BASE-04 | `37bd1c2 test: capture auth API migration baseline` |
| T01 | 通过 | `shared/{capabilities,user-roles,api-paths,api-response}.ts`、两端引用与tsconfig/vitest include | 现有角色/能力/RPC测试先通过；纯移动不伪造red；移动前AST扫描记录前端5处后端导入 | `npm test -- shared` 5/5；RPC/entitlements 59/59；root typecheck、frontend `tsc -b`、lint均exit 0；AST解析57个前端TS/TSX且后端import为0 | CLEAN-01、CLEAN-02、RPC-01 | `57fa1ac refactor: isolate shared auth domain definitions` |
| T02 | 通过 | `src/api/{problem,validation}.ts`及测试、package/lock | 初跑9项中8项按预期失败：旧错误媒体/形状、默认validation错误媒体、415纯文本 | `npm test -- src/api/problem.test.ts src/api/validation.test.ts` 9/9；`npm run typecheck` exit 0；`npm ls`确认zod-openapi 1.6.3复用Hono 4.12.22/Zod 4.4.3 | HTTP-05–HTTP-08（分页/路径类HTTP-09由T08/T10） | `fdbf771 feat(api): define validated v1 response contracts` |
| T03 | 通过 | `src/middleware/authentication.ts`、scope纯服务、CQU/admin路由与RPC引用 | `npm test -- src/middleware/authentication.test.ts`：同一Bearer验签2次；缺client身份继续进入DO并500，2/2按预期失败 | targeted 30/30；root typecheck exit 0；完整Node 57 files/519 tests exit 0；扫描确认路由不再直接验JWT/session（RPC内部session合同保留） | AUTH-01–AUTH-06、RPC-01 | `bcc19e2 refactor(auth): share request authentication and scope checks` |
| T04 | 通过 | `src/app.ts`、`src/api/{v1,legacy,operations}`、精简index及测试 | app边界初跑11项有7项按预期失败：未知API/版本进入ASSETS、canonical health缺失、错误方法返回页面；新增WS HEAD用例先暴露Hono HEAD→GET导致500 | app+operations 14/14；root typecheck exit 0；完整Node 59 files/533 tests exit 0；Worker email/queue及5个命名导出扫描保留 | HTTP-01–HTTP-04、HTTP-10基础、LEG-01–LEG-04基础（逐模块配对在T05–T11） | `255b9b9 refactor(api): separate versioned routes from SPA fallback` |
| T05 | 进行中 | stable `authUrls`、BA v1配置、81操作生成清单、新旧auth有限路由、D01–D05、Workers迁移测试 | `auth-config` 2/2先按预期失败（旧basePath/旧endpoint）；迁移后旧测试helper直交旧path产生7个404，确认必须迁canonical并另测legacy；OTP共享限频初次因无测试IP得到4个200，补固定IP后才验证第4次429 | auth配置/元数据/app/OTP/2FA/profile 29/29；完整Node 60 files/537 tests；新旧auth 81×2集合相等；生成两次SHA稳定；Workers auth迁移4/4（session、discovery、签名、OTP桶）；两端typecheck exit 0 | AUTH-07–AUTH-18、LEG-05–LEG-08；完整OAuth PKCE/旧reset正向回调仍需T17组合复核 | `f42effb refactor(auth): mount auth v1 with stable OAuth identity`；任务最终状态待T17正向组合 |
| T06 | 通过 | v1 CQU binding adapter/schema、严格canonical输入、dead forward创建分支清理、Workers API测试 | v1 Workers初跑2/2因路径不存在而404；identity injection新增用例观察到201而非400 | Workers v1/legacy/auth/注入/forward/幂等/解绑 4/4；既有binding/邮件链42/42；两端typecheck exit 0 | CQU-01–CQU-10、LEG-02、LEG-03（真实WS对象随最终Workers全套复核） | `254849f refactor(api): migrate CQU binding resources to v1` |
| T07 | 通过 | v1 service-tickets/quicklogin schema与适配、POST/201/no-store、session-only测试 | ticket测试初跑2/2因路径不存在而404；双目标红灯确认必须在验签/DO前校验 | ticket/auth/service矩阵32/32；QuickLogin Workers 1/1；完整Node 61 files/541 tests；两端typecheck exit 0 | CQU-11–CQU-18、AUTH-01–AUTH-06、LEG-04 | `56bca4e refactor(api): version ticket issuance and quicklogin preferences` |
| T08 | 通过 | `api/v1/admin/users` schema/handlers、严格分页、属性式PATCH、CQU状态适配、测试fixture角色刷新 | Workers初跑因v1路径缺失返回404；首次管理员用例因fixture沿用角色变更前session得到403，改为角色更新后重新登录 | Workers users 2/2（匿名、分页负例、ban、双字段、admin升权拒绝）；root typecheck exit 0 | ADMIN-01–ADMIN-05、LEG-09 | `f9e2520 refactor(api): model admin user updates as resource changes` |
| T09 | 通过 | v1公开/管理注册设置、邀请schema/handler、严格可选body与权限 | 初跑公开v1设置404；坏JSON行数用例先固定无写入要求 | Workers邀请/设置2/2；既有邀请并发事务26项连同新API共27/27；Node服务9/9；root typecheck exit 0 | ADMIN-06–ADMIN-10、AUTH-13、OAS-04 | 待提交 |
| T10 | 未开始 | — | — | — | ADMIN-11–ADMIN-18、LEG-10 | — |
| T11 | 未开始 | — | — | — | ADMIN-19–ADMIN-28、LEG-11、LEG-12 | — |
| T12 | 未开始 | — | — | — | OAS-01–OAS-14、CLEAN-02 | — |
| T13 | 未开始 | — | — | — | WEB-01–WEB-08、AUTH-13–AUTH-18、CLEAN-01 | — |
| T14 | 未开始 | — | — | — | WEB-09–WEB-13、ADMIN-19–ADMIN-28、CLEAN-03 | — |
| T15 | 未开始 | — | — | — | WEB-14–WEB-18、CQU-07–CQU-10、CLEAN-04 | — |
| T16 | 未开始 | — | — | — | CLEAN-01–CLEAN-08、GATE-01 | — |
| T17 | 未开始 | — | — | — | RPC-01–RPC-03、GATE-01–GATE-05 | — |

## T00 元数据附件

- Better Auth 1.6.11：80个非SERVER_ONLY、未禁用endpoint定义，81个实际HTTP操作；精确集合由 `src/auth-metadata.test.ts` 固定。
- `GET /get-session` 是唯一实际方法；生成器额外的POST不属于运行时。
- 禁用后缀6个：`/token`、`/sign-in/email-otp`、`/email-otp/request-password-reset`、`/forget-password/email-otp`、`/email-otp/reset-password`、`/verify-email`。
- SERVER_ONLY 4个：两个discovery helper、`adminCreateOAuthClient`、`adminUpdateOAuthClient`。
- 迁移前issuer/baseURL：`https://auth.cqu.moe/api/auth`。Cookie只记录名称与属性，不记录值。
- 本轮没有访问生产D1/KV、真实凭据或邮件；没有push、部署、上传schema或修改Cloudflare规则。
