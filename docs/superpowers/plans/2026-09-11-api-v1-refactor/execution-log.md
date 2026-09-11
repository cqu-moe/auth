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
| T04 | 通过 | `src/app.ts`、`src/api/{v1,legacy,operations}`、精简index及测试 | app边界初跑11项有7项按预期失败：未知API/版本进入ASSETS、canonical health缺失、错误方法返回页面；新增WS HEAD用例先暴露Hono HEAD→GET导致500 | app+operations 14/14；root typecheck exit 0；完整Node 59 files/533 tests exit 0；Worker email/queue及5个命名导出扫描保留 | HTTP-01–HTTP-04、HTTP-10基础、LEG-01–LEG-04基础（逐模块配对在T05–T11） | 待提交 |
| T05 | 未开始 | — | — | — | AUTH-07–AUTH-18、LEG-05–LEG-08、OAS-02、OAS-03 | — |
| T06 | 未开始 | — | — | — | CQU-01–CQU-10、LEG-02、LEG-03 | — |
| T07 | 未开始 | — | — | — | CQU-11–CQU-18、AUTH-01–AUTH-06、LEG-04 | — |
| T08 | 未开始 | — | — | — | ADMIN-01–ADMIN-05、LEG-09 | — |
| T09 | 未开始 | — | — | — | ADMIN-06–ADMIN-10、AUTH-13、OAS-04 | — |
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
