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
| T05 | 通过 | stable `authUrls`、BA v1配置、81操作生成清单、新旧auth有限路由、D01–D05、Workers迁移测试 | `auth-config` 2/2先按预期失败（旧basePath/旧endpoint）；迁移后旧测试helper直交旧path产生7个404；OTP共享限频补固定IP后验证第4次429；PKCE consent首次缺signed oauth_query为400，按真实页面协议补齐 | auth配置/元数据/OTP/2FA；Workers auth迁移6项：session、discovery、签名、OTP桶、canonical PKCE+legacy refresh、迁移前verification旧reset callback+POST | AUTH-07–AUTH-18、LEG-05–LEG-08 | `f42effb refactor(auth): mount auth v1 with stable OAuth identity` + T17提交 |
| T06 | 通过 | v1 CQU binding adapter/schema、严格canonical输入、dead forward创建分支清理、Workers API测试 | v1 Workers初跑2/2因路径不存在而404；identity injection新增用例观察到201而非400 | Workers v1/legacy/auth/注入/forward/幂等/解绑 4/4；既有binding/邮件链42/42；两端typecheck exit 0 | CQU-01–CQU-10、LEG-02、LEG-03（真实WS对象随最终Workers全套复核） | `254849f refactor(api): migrate CQU binding resources to v1` |
| T07 | 通过 | v1 service-tickets/quicklogin schema与适配、POST/201/no-store、session-only测试 | ticket测试初跑2/2因路径不存在而404；双目标红灯确认必须在验签/DO前校验 | ticket/auth/service矩阵32/32；QuickLogin Workers 1/1；完整Node 61 files/541 tests；两端typecheck exit 0 | CQU-11–CQU-18、AUTH-01–AUTH-06、LEG-04 | `56bca4e refactor(api): version ticket issuance and quicklogin preferences` |
| T08 | 通过 | `api/v1/admin/users` schema/handlers、严格分页、属性式PATCH、CQU状态适配、测试fixture角色刷新 | Workers初跑因v1路径缺失返回404；首次管理员用例因fixture沿用角色变更前session得到403，改为角色更新后重新登录 | Workers users 2/2（匿名、分页负例、ban、双字段、admin升权拒绝）；root typecheck exit 0 | ADMIN-01–ADMIN-05、LEG-09 | `f9e2520 refactor(api): model admin user updates as resource changes` |
| T09 | 通过 | v1公开/管理注册设置、邀请schema/handler、严格可选body与权限 | 初跑公开v1设置404；坏JSON行数用例先固定无写入要求 | Workers邀请/设置2/2；既有邀请并发事务26项连同新API共27/27；Node服务9/9；root typecheck exit 0 | ADMIN-06–ADMIN-10、AUTH-13、OAS-04 | `27f09c8 refactor(api): version invitation and registration resources` |
| T10 | 通过 | v1权益replace/merge/单项删除、预设CRUD、默认配置与权限 | Workers首个PUT因路径缺失404；首次green断言未投影DB元数据而失败，改为只比较公开Item字段 | Workers真实D1 replace+merge 1/1；服务/能力目录57/57；root typecheck exit 0 | ADMIN-11–ADMIN-18、LEG-10 | `e3bb488 refactor(api): unify entitlement resource operations` |
| T11 | 通过 | v1 OAuth适配、正式snake_case视图、secret 201/no-store、scope ACL与D1 batch | 首次Workers因v1路径缺失404；旧实现经清单确认普通admin可写scope且delete/insert非原子 | Workers OAuth 2/2（新旧admin拒绝、创建、无别名/secret列表、scope替换/重复拒绝、轮换、删除清理）；Node OAuth/scope/app 24/24；两端typecheck exit 0 | ADMIN-19–ADMIN-28、LEG-11、LEG-12 | `5e75c5e refactor(api): normalize OAuth client administration` |
| T12 | 通过 | OAS3.1.1/CF3.0.3/endpoints/coverage/generated types、运行时文档端点、生成/漂移/lint脚本 | 完成声明审计发现BA仍是通用骨架，改为调用1.6.11官方generator；其输出含nullable/string[]/json、缺path参数和幻影POST get-session，规范化/裁剪/应用约束后再生成 | 238 runtime operations、211 paths、POST get-session=0；BA真实schema+signup.code+customSession.caps；OpenAPI 4/4；generate/check/lint零warning exit 0 | OAS-01–OAS-14、CLEAN-02 | `c53da2d feat(api): generate verified OpenAPI contracts and client types` + T17提交 |
| T13 | 通过 | frontend api/http/registration/cqu/types、auth basePath、AuthError、安全页面与普通CQU页面迁移、Vite WS | API client测试先因模块缺失红；页面改v1 envelope后Wizard 11项旧fixture全部失败，更新fixture为canonical envelope后通过 | API/continuation/OTP/Wizard 76/76；frontend `tsc -b`、lint、build均exit 0 | WEB-01–WEB-08、AUTH-13–AUTH-18、CLEAN-01 | `713acba refactor(frontend): centralize v1 API access` |
| T14 | 通过 | admin v1 transport、action/preset/secret适配、四功能Section与共享UI拆分、38行页面组合 | 浏览器移动fixture发现表格右列裁切，按既有视觉改为mobile卡片+desktop表格 | admin transport 2/2；frontend `tsc -b`/lint/build；同一fixture桌面/390px截图；移动复验documentWidth=viewport=390、table无可见布局盒、4操作按钮可见 | WEB-09–WEB-13、ADMIN-19–ADMIN-28、CLEAN-03 | `2f6c741 refactor(frontend): split admin features around v1 resources` + T17/最终浏览器提交 |
| T15 | 通过 | shared CQU event parser、单一binding transport、Settings/Wizard策略接入、单一CopyButton与admin compact wrapper | transport首跑因Node无window失败，切jsdom后验证；控件机械合并首轮误删相邻类型/STEP_LABELS，按HEAD恢复后通过 | transport/page/copy 14/14；frontend `tsc -b`、lint、build exit 0；Workers canonical+legacy真实WS 101/webSocket对象5/5 | WEB-14–WEB-18、CQU-07–CQU-10、CLEAN-04 | `68ab005 refactor(frontend): share binding events and clipboard behavior` |
| T16 | 通过 | AST边界脚本/测试、CI API/Workers/frontend门禁、package清理、当前文档、cleanup ledger | sandbox内tsx IPC为EPERM，获准本地IPC后通过；违规fixture由测试确认会报告非零错误 | `check:boundaries` exit 0、fixture 1/1；两端typecheck、frontend lint/build exit 0；迁移/DO导出/NODE_RETIRED diff与引用扫描保留 | CLEAN-01–CLEAN-08、GATE-01 | `d5d1799 chore: enforce API contracts and remove migrated code` |
| T17 | 通过 | acceptance-results、BA schema/协议补验、响应式修复、最终门禁与桌面/移动截图 | 初次移动截图暴露裁切；修复后按用户“继续”重新取得同一TaskSpace并完成可见性/溢出断言 | root/frontend `npm ci`；typecheck×2；Node 68 files/554；Workers 11 files/109；frontend tsc/lint/build；generate/check/lint/boundaries/diff均exit 0；WEB-13复验通过 | RPC-01–RPC-03、GATE-01–GATE-05、WEB-13 | `74b67fa test: record local API v1 acceptance` + 最终浏览器提交；未push/未部署 |

## T00 元数据附件

- Better Auth 1.6.11：80个非SERVER_ONLY、未禁用endpoint定义，81个实际HTTP操作；精确集合由 `src/auth-metadata.test.ts` 固定。
- `GET /get-session` 是唯一实际方法；生成器额外的POST不属于运行时。
- 禁用后缀6个：`/token`、`/sign-in/email-otp`、`/email-otp/request-password-reset`、`/forget-password/email-otp`、`/email-otp/reset-password`、`/verify-email`。
- SERVER_ONLY 4个：两个discovery helper、`adminCreateOAuthClient`、`adminUpdateOAuthClient`。
- 迁移前issuer/baseURL：`https://auth.cqu.moe/api/auth`。Cookie只记录名称与属性，不记录值。
- 本轮没有访问生产D1/KV、真实凭据或邮件；没有push、部署、上传schema或修改Cloudflare规则。
