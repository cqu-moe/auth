# AUTH-05 — 管理与人工账号恢复浏览器 E2E

状态：本地实现及验收完成，待父审/merger 整合。更新时间：2026-10-15 21:46 CST。

## 固定提交与范围

- 正式依据：工作区根 `docs/e2e/implementation-contract.md`、`docs/e2e/specs/auth.md`、`docs/e2e/tickets/AUTH-05.md`；沿用已批准的 to-spec → to-tickets → implement-spec，不重新采访、发布规格或创建远端票。
- Worktree：`/Users/uu/Developer/cqu-moe/.agent-worktrees/e2e-20261015/tickets/AUTH-05`；branch：`codex/e2e-20261015-auth-05`。
- 用户指定初始基线：`073c5ed066d49982c18372eff7d5afbc991879d9`。实施中 integration 更新至 `7a915b91ec85a594e0fc6310cd6dc359e89cd445`；本票执行 `git merge --ff-only codex/e2e-coverage-20261015` 同步，收尾再次执行同一命令返回 Already up to date。没有反向修改 integration。
- **实现签名 SHA：`f4a1a9bd524dc674f9cc6f7b279f6425e31b7a86`**，`test(auth): cover administration and account recovery in browser`；源树 Git tree：`223fce9d673c38b73e5fd6f178e137523d7eb4d7`。
- 两轮完整普通 E2E 均在该提交及干净源码上执行，所有 64 个正常 runtime 的 commit 都是上述 SHA；无 retries、skipped、interrupted、flaky。
- 有效 Git 身份原样使用 `User-Unauthorized <69748465+UserUnauthorized@users.noreply.github.com>`；现有 SSH signing 保持开启。`git verify-commit HEAD` exit 0，Good git signature，ED25519 fingerprint `SHA256:kFBsDXcJS4MSU8XzdxOS6OXw1GWgslmAJ01pZuIHgrg`。未覆盖 author、禁用签名或更改 Git 配置。
- 实现提交共 12 文件、1004 insertions / 98 deletions：生产代码 0；浏览器测试 596/78；测试支撑 379/17；文档 29/3。新增验收报告单独归档。
- 与同步后的 integration 比较，`src/`、`frontend/`、`shared/`、迁移、CI、`e2e/run.mjs`、`e2e/runtime.mjs`、`e2e/school/` 均无本票差异。保留 platform hooks、recipient OTP/reset mail 对象、expiry/secret controls、framework discovery 及每旅程隔离 runner。唯一 stash 冲突是双方已做相同修复的 title grep，精确保留 integration 的 runner，随后删除本票临时 stash。
- 测试及支撑源码仅写本票 worktree；按用户指定另写根 `docs/e2e/results/AUTH-05.md` 作为报告。未 push、未开 PR、未部署、未变更 issue 或 shared execution；未调用真实账号、实际 Resend 投递、学校外联或付费 AI。

## 正式 acceptance 对照

| 正式验收 | 实际证据 |
| --- | --- |
| 真实登录/强认证进入；普通用户与不足认证管理员页面和接口拒绝 | 真实注册/验证后密码 + TOTP 登录管理端；完整恢复使用真实 UV Passkey 登录及 admin-purpose step-up。普通用户页面回账户设置、canonical API 403 FORBIDDEN；无强认证管理员显示验证页且 API 403 STRONG_AUTH_REQUIRED。普通 admin 的 superAdmin 负例先真实取得 strong=true、admin verified=true，避免因缺证明得到伪拒绝。 |
| 用户、封禁/恢复、邀请、权益、OAuth 配置保存后重开读回并影响实际访问 | 用户角色、ban/unban、邀请码/预设、注册政策/默认权益、个人权益、设备额度、OAuth 客户端/回调/CQU scopes/secret 均通过真实管理 UI 写入；重开 UI 与独立 public API 读回。实际登录、注册、capability、device policy 及 native OAuth provider 结果随配置变化。权益/客户端/角色/政策/恢复/设备权限遵守 superAdmin 边界。 |
| 完整人工恢复使旧认证失效并保留业务数据 | 同一真实 UI reset 作废旧密码、注册过的 Passkey、旧 MFA pending cookie/TOTP/恢复码、信任设备、交互 session、OAuth access/refresh、pending authorization code 及应用邮件生成的 reset token。随机密码只在内存传递，真实结果框关闭/重开已清空。新密码可登录，原 id、昵称、邮箱登录标识、admin 角色、feed 权益及 OAuth 客户端配置保留；恢复后的 admin 仍要重建/完成强认证。 |
| 管理员设备操作与用户自有设备边界；独立数据和证据 | 真 account DO 执行 quota preview/apply；正额度打开真实准入，用户关闭自己的 master 后额度归零关闭准入。管理员只撤销目标真实 session，另一台及管理员 session 存活；普通用户的原生 non-owner revoke 返回 200/no-op 后独立读回他人仍在线，不能凭 HTTP 200 当成功。强认证普通 admin 的 session list/revoke 权限仍 403。 |

九条新增 AUTH-05 主旅程：

1. 管理员角色保存/重开读回，普通用户与弱管理员页面/API 准入。
2. 管理 UI ban/unban 改变实际登录及旧 cookie，UI 和原生 self-ban 拒绝且管理员保持可用。
3. 已真实强认证及近期 admin 证明的普通 admin：可读管理数据、创建普通邀请；不能赋 superAdmin、写权益/预设/政策/客户端/设备额度、恢复认证、封禁其他管理员或操作他人 session。
4. UI 新建权益预设和携带预设的邀请；真实注册后获得权益；读回 used/目标用户；UI 撤销另一邀请后真实注册拒绝。
5. 用户权益 grant/revoke、重开读回；真实 QuickLogin account DO 额度 0→2→0、预览/确认/读回及用户准入变化，拒绝 generic entitlement 绕过专用额度流程。
6. 真实登录得到两台 session；自有 session 列表只含本人；用户不能撤销其他 owner；有权限的管理员撤销一台后其他 session 保留，UI 设备列表同步变化。
7. OAuth UI create/reopen/edit/CQU scope/rotate/delete；真实 S256 code/token/userinfo 验证新配置，旧 callback、旧 secret、已删 client 被正确协议错误拒绝，scope 删除读回为空。
8. 完整人工恢复：真实建立旧认证及交互凭据，取消确认和取消 step-up 都不改变访问；真实确认+Passkey 管理证明后重置；全部旧材料拒绝，新密码/业务保留、管理员重新强认证、旧信任 cookie 不能跳过新因子。
9. UI 保存默认权益、关闭邀请码政策；不 seed 邀请的真实注册得到默认权益；UI 重新开启政策并重开读回后无邀请码注册显示拒绝，既有用户权益保留。

主测试：`e2e/admin.e2e.ts`、`e2e/admin-recovery.e2e.ts`；复用支撑：`auth-fixture.ts`、`admin-fixture.ts`、`oauth-fixture.ts`、`recovery-fixture.ts`、secret holder/config。AUTH-02 六条原安全旅程的断言保留，仅抽出共用 helper；错误 TOTP enrollment 仍由原 AUTH-02 主测试拥有，AUTH-05 setup 不重复该负例。

## 执行环境与测试边界

Node `v22.22.3`，前端锁定 pnpm `11.19.0`；tester-army/e2e `0.21.0`、web engine `0.15.0`、Miniflare `4.20260521.0`、Playwright core `1.64.0`。未升级依赖/锁文件。根执行 `npm ci --no-audit --no-fund`；本机 Corepack 版本不符、镜像 DNS 和只读 store 导致前端安装尝试失败，随后 `cmp frontend/pnpm-lock.yaml ../AUTH-02/frontend/pnpm-lock.yaml` exit 0，使用 `cp -R ../AUTH-02/frontend/node_modules/. frontend/node_modules/` 复用相同锁文件的已安装依赖，实际 build/type/lint 全部通过。未读取开发者 `.dev.vars`。

真实构建 SPA → 原 Worker bundle → workerd/Miniflare → 全部真实 SQL migration 后 D1；设备额度经过真实 account DO。浏览器仅允许当前独占 localhost origin，Worker 外部请求仅允许受控 Resend delivery；public API helper 固定本地 canonical origin 且不跟随重定向。只替换邮件投递，不 mock 内部 Auth/HTTP/DB/DO，不 seed 被测成功 user/session、因子、证明、权益、客户端、token 或恢复结果。seed 仅用于未使用邀请/初始注册环境和 manager 初始 superAdmin 权限；第二用户角色、业务权益及配置均从 UI 写入。

真实生成的 OTP、TOTP URI/恢复码、reset URL、cookie/session token、OAuth code/verifier/access/refresh/client secret、WebAuthn private key 和恢复密码仅在内存及 secret/control 保护通道传递；运行时文本产物扫描命中即失败。展示码和一次性结果的真实 UI 保持活动，敏感文本被遮蔽；Secret fill 后不绕过框架截图限制。故障截图均在填 Secret 前产生。

完整恢复会越过原有 30/min session-read 窗口；测试用安全 GET 的 `expect.poll` 等待真实 429 自然恢复，最多 70 秒，其他状态/传输错误仍立即失败。没有改限流行、阈值、认证证明或设备状态。两轮恢复在每个视口均实际经过这一流程，单例约 73 秒。

OAuth callback 注册为合法 `https://client.example.test/...`，协议验证只读取真实 provider 返回的 callback/code 并调用真实 token/userinfo，不访问该外部域，不宣称运行了下游 callback 服务。完整 OAuth 浏览器/扩展设备授权链仍归 AUTH-04。

## 实际命令与结果

以下命令均在上述 AUTH-05 worktree；`.e2e/` 是本地忽略产物，不入 Git。普通测试共 17 条：2 AUTH-01 + 6 AUTH-02 + 9 AUTH-05；每视口 16 runtime，AUTH-01 两条按原约定共用一份，其余每条独立。

| 实际命令 | 退出与证据 |
| --- | --- |
| `AUTH_E2E_EXPECT_COMMIT=f4a1a9bd524dc674f9cc6f7b279f6425e31b7a86 AUTH_E2E_OUTPUT=.e2e/auth05-round-1 npm run test:e2e > .e2e/auth05-round-1.command.log 2>&1` | exit 0；桌面/手机各 17/17；32/32 cleanup passed；无失败/跳过/中断/重试。 |
| `AUTH_E2E_EXPECT_COMMIT=f4a1a9bd524dc674f9cc6f7b279f6425e31b7a86 AUTH_E2E_OUTPUT=.e2e/auth05-round-2 npm run test:e2e > .e2e/auth05-round-2.command.log 2>&1` | exit 0；第二轮全新状态同样双视口 17/17、32/32 cleanup passed。 |
| `AUTH_E2E_EXPECT_COMMIT=f4a1a9bd524dc674f9cc6f7b279f6425e31b7a86 node e2e/self-check.mjs > .e2e/auth05-negative-pinned.log 2>&1` | 外层 exit 0；注册/管理 × 桌面/手机共四次内层 exit 1，唯一失败均为指定 ASSERTION_FAILED；截图/原报告保留、cleanup passed。 |
| `AUTH_E2E_EXPECT_COMMIT=f4a1a9bd524dc674f9cc6f7b279f6425e31b7a86 AUTH_E2E_OUTPUT=.e2e/auth05-zero-selection AUTH_E2E_MOBILE=1 node e2e/run.mjs --grep '^AUTH05_MUST_NOT_EXIST$' > .e2e/auth05-zero-selection.command.log 2>&1` | 实际 exit 1；discovered 17、selected/executed 0、runtime 0，明确拒绝零用例。 |
| `AUTH_E2E_EXPECT_COMMIT=f4a1a9bd524dc674f9cc6f7b279f6425e31b7a86 node e2e/account-smoke.mjs > .e2e/auth05-account-smoke-pinned.log 2>&1` | exit 0；下游 prepareAccount 及独立真实 sign-in 通过，独立 Worker/D1 清理。 |
| `npm run check:ci > .e2e/auth05-check-ci.log 2>&1` | exit 0；typecheck、DO typecheck、API/边界、lint/design；Node Vitest 105 文件/954 用例；真实 D1/DO 45 文件/435 用例全部通过。 |
| `WRANGLER_LOG_PATH=.e2e/auth05-wrangler-build.log WRANGLER_SEND_METRICS=false npm run build:ci > .e2e/auth05-build-ci-2.log 2>&1` | exit 0；实际前端构建、Docker image 构建及 Wrangler dry-run；终止于 --dry-run: exiting now，没有上传/部署。 |
| `npm run typecheck:e2e`、`node --check e2e/self-check.mjs`、`git diff --cached --check`、`git verify-commit HEAD` | 均 exit 0；完整普通 E2E 命令也再次执行 E2E typecheck/build。 |

原 `check:ci`/build 执行于相同生产源码的工作副本；随后固定实现提交，两轮普通测试与四个业务故障控制均固定于 `f4a1a9bd524dc674f9cc6f7b279f6425e31b7a86`。本票与 integration 的生产/原测试/锁文件无差异，不把本地命令结果当远端 CI。

### 两轮原始报告

| 轮次/视口 | 实际执行 | 清理 | 原始 aggregate report | SHA-256 |
| --- | --- | --- | --- | --- |
| 1 / desktop | 17/17 | 16/16 | [report.json](/Users/uu/Developer/cqu-moe/.agent-worktrees/e2e-20261015/tickets/AUTH-05/.e2e/auth05-round-1/desktop/report.json) | `1c793f9b22f8c634890ed3f4e91584d25cee4afa87e48057b7edc217d2040389` |
| 1 / mobile | 17/17 | 16/16 | [report.json](/Users/uu/Developer/cqu-moe/.agent-worktrees/e2e-20261015/tickets/AUTH-05/.e2e/auth05-round-1/mobile/report.json) | `14aa4c0cbf250c2c8e3c21fc661bfff6011f9d6d67f23f540d23584437bc5634` |
| 2 / desktop | 17/17 | 16/16 | [report.json](/Users/uu/Developer/cqu-moe/.agent-worktrees/e2e-20261015/tickets/AUTH-05/.e2e/auth05-round-2/desktop/report.json) | `1457240c030e9928a3c82e29b4c63e5937e1e35c35bad007a9a357486a77b4de` |
| 2 / mobile | 17/17 | 16/16 | [report.json](/Users/uu/Developer/cqu-moe/.agent-worktrees/e2e-20261015/tickets/AUTH-05/.e2e/auth05-round-2/mobile/report.json) | `9c5c8c8d9f739e38fa471adc23cce64fc7ecc9928eace0bccd8f0f46d72ad417` |

独立证据核验重新读取框架 discovery 及全部 per-group 原始 report：每视口 selected/executed ID 的并集与 17 个 discovery ID 完全相等、没有重复执行，所有 attempt 只有一次且通过、每组 commit 等于固定 SHA、status/cleanup 正常。总计 **68/68 正常 case-target，64/64 runtime cleanup**。

### 指定故障控制

| 场景 | 内层退出 | 报告 | 截图 |
| --- | --- | --- | --- |
| identity / desktop | 1，预期断言失败 | [report.json](/Users/uu/Developer/cqu-moe/.agent-worktrees/e2e-20261015/tickets/AUTH-05/.e2e/negative-identity-desktop-1792071391748/desktop/report.json) | [001-failure.png](/Users/uu/Developer/cqu-moe/.agent-worktrees/e2e-20261015/tickets/AUTH-05/.e2e/negative-identity-desktop-1792071391748/desktop/01-identity/results/identity-register-verify-persist-sign-out-b286a9deb63f49a4/attempt-1/screenshots/001-failure.png) |
| identity / mobile | 1，预期断言失败 | [report.json](/Users/uu/Developer/cqu-moe/.agent-worktrees/e2e-20261015/tickets/AUTH-05/.e2e/negative-identity-mobile-1792071405620/mobile/report.json) | [001-failure.png](/Users/uu/Developer/cqu-moe/.agent-worktrees/e2e-20261015/tickets/AUTH-05/.e2e/negative-identity-mobile-1792071405620/mobile/01-identity/results/identity-register-verify-persist-sign-out-453fcf8278c5bac2/attempt-1/screenshots/001-failure.png) |
| admin / desktop | 1，预期断言失败 | [report.json](/Users/uu/Developer/cqu-moe/.agent-worktrees/e2e-20261015/tickets/AUTH-05/.e2e/negative-admin-desktop-1792071419327/desktop/report.json) | [001-failure.png](/Users/uu/Developer/cqu-moe/.agent-worktrees/e2e-20261015/tickets/AUTH-05/.e2e/negative-admin-desktop-1792071419327/desktop/01-90b56a11c521-administrator-users-and-roles-persist-while-ordi/results/admin-administrator-users-and-roles-90b56a11c521ecb8/attempt-1/screenshots/001-failure.png) |
| admin / mobile | 1，预期断言失败 | [report.json](/Users/uu/Developer/cqu-moe/.agent-worktrees/e2e-20261015/tickets/AUTH-05/.e2e/negative-admin-mobile-1792071433141/mobile/report.json) | [001-failure.png](/Users/uu/Developer/cqu-moe/.agent-worktrees/e2e-20261015/tickets/AUTH-05/.e2e/negative-admin-mobile-1792071433141/mobile/01-d0f66d2fbaa0-administrator-users-and-roles-persist-while-ordi/results/admin-administrator-users-and-roles-d0f66d2fbaa0db53/attempt-1/screenshots/001-failure.png) |

完整原报告、日志及截图的摘要见 [auth05-evidence.json](/Users/uu/Developer/cqu-moe/.agent-worktrees/e2e-20261015/tickets/AUTH-05/.e2e/auth05-evidence.json)；该索引 SHA-256：`b8a0b2f2029212b0ec6f3ddbb9545e59271b5c9041f28357f565b9c2fdfae736`。索引还包含每个截图及验证日志的 SHA-256。启动/无用例/其他断言失败不能满足四个故障控制；self-check 检查具体错误码、断言文字、唯一失败数及清理。

## 开发阶段失败与修正记录

这些实验不算正常通过；最终验收以上述固定提交两轮及控制为准。

- `.e2e/dev-users-2`、`dev-users-3`、`dev-users-4`：过长混合管理场景触发真实 security status/session-read 限流。按独立用户业务拆成角色准入与 ban/unban，去掉重复读取/重复 TOTP setup 负例；未提高限流或伪造证明。
- `.e2e/dev-permissions`：URL-only `browser.waitForResponse` 将后台 GET 200 当作 invitation POST 201。只对 method+URL 过滤使用安装 engine 公开的 Playwright surface；仍以 tester-army/e2e 操作 UI，没有替换响应。
- `.e2e/dev-invitations`：用户宽 grep 被重复 OR 进每组，实际一组跑了两条并污染隔离。integration `7a915b9` 已独立修好相同问题；冲突时保留该版本。`.e2e/dev-final-slices` 在修复后四个选择旅程分别独立运行并双视口通过。
- `.e2e/dev-invitations-2`：一次 public API transport 报 other side closed，按失败保留，没有给写请求加隐藏重试；之后同旅程定点与固定提交两轮完整运行通过，未追认该次失败为产品缺陷或通过。
- OAuth fixture 探针先触发 web+HTTP callback 被真实 provider 拒绝；native+机密 client 可创建、编辑时现有校验拒绝该组合。最终选择当前受支持的 web+HTTPS 代表成功路径；native+机密编辑不一致未改，未声称覆盖全部配置排列。provider 返回授权错误 URL 时可为 HTTP 200，最终断言明确检查 `invalid_redirect`、`invalid_client` 及无 code，并以实际 token/userinfo 验证成功。
- `.e2e/dev-recovery`：首个完整恢复在旧材料拒绝后遇到真实 get-session 429；增加显式 safe-GET 窗口等待而非绕过限流。一次开发重跑把 PollOptions 拼为 intervals，typecheck 明确 exit 2；误启动的开发测试子进程随后中止、exit 130。已改为当前版本的 interval，该次未计入验收。遗留的两份本票独占开发 runtime 目录核验无进程后移除。
- 初始本地 runner 在受限沙箱监听 loopback 报 EPERM；初次 build:ci 也因沙箱日志/Docker CLI 访问失败而 exit 1。所需本地端口/Docker 权限提升后实际运行通过；没有降低业务 guard。`auth05-build-ci.log` 保留首败，`auth05-build-ci-2.log` 为真实成功。
- 正常运行日志有 workerd 的 Broken pipe/Connection reset 诊断及预期无效密码警告；没有把这些日志当业务成功证据。最终实际断言、文本秘密扫描、进程退出及清理全部通过。

## 审查、清理与明确限制

按 test-audit authoring gate 审核观察行为、可信回归、既有覆盖归属和生产 seam；按 code-review 的 Standards/Spec 两轴做本地审查。新增断言位于真实 UI/public API；没有源文本检查、mock 自证、复制生产计算或新增生产测试出口。共用 helper 只抽出已有真实流程，未删除 AUTH-01/02 有效断言。Standards 与正式 Spec 在上述代表核心旅程内无未解决项。当前工具集没有 spawn_agent，未执行独立子代理审查；没有调用 GLM 或 e2e agent/付费模型。

收尾：64 个正常 runtime 与 4 个故障 runtime 均有成功清理记录；工作目录 `.auth-e2e-*` 数量为 0；以 cwd 核验本票无残留 Node/workerd/Chromium 测试进程。本票临时 stash 已删除；保留忽略的脱敏 `.e2e/` 证据和已构建依赖供父审，不删除隔离 worktree。

- 本地 Chromium 桌面 1440×900/手机 390×844 是 viewport 测试，非物理手机；Firefox/WebKit、真实生物识别/PIN/硬件 Passkey 未验证。
- 本票人工恢复覆盖 Auth 管理与账号认证；真实学校绑定/学校恢复/完整 Queue/Workflow/容器旅程仍归 AUTH-03，按指令未重跑完整 school suite。本票未 seed 学校绑定来冒充成功；业务数据浏览器证明限于身份/角色/权益/客户端，原 D1/DO 恢复测试继续覆盖学校数据保留。
- 管理员设备证明覆盖真实 account-DO 额度与真实交互 session 的权限/持久化/撤销。带实际已安装扩展设备的保留/停用名单、OAuth 浏览器 callback 及完整设备链由 AUTH-04 拥有，本票不自扩或冒称通过。
- 未使用真实测试账号、生产 D1/部署、外部真实邮件、学校网络或付费模型；远端 CI、PR、合并和生产验收未执行。原上游 Auth01/02 push/CI 不代表 AUTH-05 CI。
- 根报告是用户明确指定的交付文件；未修改根 shared execution、其他票或 integration checkout。
