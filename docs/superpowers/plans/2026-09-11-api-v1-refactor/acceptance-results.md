# API v1 refactor acceptance results

范围：本地隔离工作区，仅假邮件、假 CQU 出站、真实本地 HTTP/Auth/D1/KV/DO/WS。未访问生产 D1/KV、真实学校凭据或真实邮件。

原 T00–T17 结论：代码、协议、契约、全部命令门禁和 WEB-13 浏览器验收均通过。Admin 使用同一固定 fixture 完成桌面与 390px 移动截图；移动端初次发现表格裁切后改为卡片布局，复验确认页面宽度等于 viewport、无横向溢出、隐藏表格无布局盒，姓名、角色、状态、日期及4个操作按钮全部可达。下表是该时间点的验收记录；2026-09-12 QuickLogin 补充状态见其后的独立小节。

| ID | 状态 | 当前证据 |
| --- | --- | --- |
| BASE-01 | 通过 | T00: git/fetch/install baseline, auth metadata 2/2, API fixture 1/1 |
| BASE-02 | 通过 | T00: git/fetch/install baseline, auth metadata 2/2, API fixture 1/1 |
| BASE-03 | 通过 | T00: git/fetch/install baseline, auth metadata 2/2, API fixture 1/1 |
| BASE-04 | 通过 | T00: git/fetch/install baseline, auth metadata 2/2, API fixture 1/1 |
| HTTP-01 | 通过 | app/problem/validation tests; final Node 68 files/554 tests |
| HTTP-02 | 通过 | app/problem/validation tests; final Node 68 files/554 tests |
| HTTP-03 | 通过 | app/problem/validation tests; final Node 68 files/554 tests |
| HTTP-04 | 通过 | app/problem/validation tests; final Node 68 files/554 tests |
| HTTP-05 | 通过 | app/problem/validation tests; final Node 68 files/554 tests |
| HTTP-06 | 通过 | app/problem/validation tests; final Node 68 files/554 tests |
| HTTP-07 | 通过 | app/problem/validation tests; final Node 68 files/554 tests |
| HTTP-08 | 通过 | app/problem/validation tests; final Node 68 files/554 tests |
| HTTP-09 | 通过 | app/problem/validation tests; final Node 68 files/554 tests |
| HTTP-10 | 通过 | app/problem/validation tests; final Node 68 files/554 tests |
| AUTH-01 | 通过 | auth config/metadata/2FA/profile tests; Workers auth migration 6 cases incl PKCE, legacy refresh/reset |
| AUTH-02 | 通过 | auth config/metadata/2FA/profile tests; Workers auth migration 6 cases incl PKCE, legacy refresh/reset |
| AUTH-03 | 通过 | auth config/metadata/2FA/profile tests; Workers auth migration 6 cases incl PKCE, legacy refresh/reset |
| AUTH-04 | 通过 | auth config/metadata/2FA/profile tests; Workers auth migration 6 cases incl PKCE, legacy refresh/reset |
| AUTH-05 | 通过 | auth config/metadata/2FA/profile tests; Workers auth migration 6 cases incl PKCE, legacy refresh/reset |
| AUTH-06 | 通过 | auth config/metadata/2FA/profile tests; Workers auth migration 6 cases incl PKCE, legacy refresh/reset |
| AUTH-07 | 通过 | auth config/metadata/2FA/profile tests; Workers auth migration 6 cases incl PKCE, legacy refresh/reset |
| AUTH-08 | 通过 | auth config/metadata/2FA/profile tests; Workers auth migration 6 cases incl PKCE, legacy refresh/reset |
| AUTH-09 | 通过 | auth config/metadata/2FA/profile tests; Workers auth migration 6 cases incl PKCE, legacy refresh/reset |
| AUTH-10 | 通过 | auth config/metadata/2FA/profile tests; Workers auth migration 6 cases incl PKCE, legacy refresh/reset |
| AUTH-11 | 通过 | auth config/metadata/2FA/profile tests; Workers auth migration 6 cases incl PKCE, legacy refresh/reset |
| AUTH-12 | 通过 | auth config/metadata/2FA/profile tests; Workers auth migration 6 cases incl PKCE, legacy refresh/reset |
| AUTH-13 | 通过 | auth config/metadata/2FA/profile tests; Workers auth migration 6 cases incl PKCE, legacy refresh/reset |
| AUTH-14 | 通过 | auth config/metadata/2FA/profile tests; Workers auth migration 6 cases incl PKCE, legacy refresh/reset |
| AUTH-15 | 通过 | auth config/metadata/2FA/profile tests; Workers auth migration 6 cases incl PKCE, legacy refresh/reset |
| AUTH-16 | 通过 | auth config/metadata/2FA/profile tests; Workers auth migration 6 cases incl PKCE, legacy refresh/reset |
| AUTH-17 | 通过 | auth config/metadata/2FA/profile tests; Workers auth migration 6 cases incl PKCE, legacy refresh/reset |
| AUTH-18 | 通过 | auth config/metadata/2FA/profile tests; Workers auth migration 6 cases incl PKCE, legacy refresh/reset |
| CQU-01 | 通过 | ticket/auth/service Node tests; binding/quicklogin/DO Workers tests and real WS 101 |
| CQU-02 | 通过 | ticket/auth/service Node tests; binding/quicklogin/DO Workers tests and real WS 101 |
| CQU-03 | 通过 | ticket/auth/service Node tests; binding/quicklogin/DO Workers tests and real WS 101 |
| CQU-04 | 通过 | ticket/auth/service Node tests; binding/quicklogin/DO Workers tests and real WS 101 |
| CQU-05 | 通过 | ticket/auth/service Node tests; binding/quicklogin/DO Workers tests and real WS 101 |
| CQU-06 | 通过 | ticket/auth/service Node tests; binding/quicklogin/DO Workers tests and real WS 101 |
| CQU-07 | 通过 | ticket/auth/service Node tests; binding/quicklogin/DO Workers tests and real WS 101 |
| CQU-08 | 通过 | ticket/auth/service Node tests; binding/quicklogin/DO Workers tests and real WS 101 |
| CQU-09 | 通过 | ticket/auth/service Node tests; binding/quicklogin/DO Workers tests and real WS 101 |
| CQU-10 | 通过 | ticket/auth/service Node tests; binding/quicklogin/DO Workers tests and real WS 101 |
| CQU-11 | 通过 | ticket/auth/service Node tests; binding/quicklogin/DO Workers tests and real WS 101 |
| CQU-12 | 通过 | ticket/auth/service Node tests; binding/quicklogin/DO Workers tests and real WS 101 |
| CQU-13 | 通过 | ticket/auth/service Node tests; binding/quicklogin/DO Workers tests and real WS 101 |
| CQU-14 | 通过 | ticket/auth/service Node tests; binding/quicklogin/DO Workers tests and real WS 101 |
| CQU-15 | 通过 | ticket/auth/service Node tests; binding/quicklogin/DO Workers tests and real WS 101 |
| CQU-16 | 通过 | ticket/auth/service Node tests; binding/quicklogin/DO Workers tests and real WS 101 |
| CQU-17 | 通过 | ticket/auth/service Node tests; binding/quicklogin/DO Workers tests and real WS 101 |
| CQU-18 | 通过 | ticket/auth/service Node tests; binding/quicklogin/DO Workers tests and real WS 101 |
| ADMIN-01 | 通过 | Workers admin users/invitations/entitlements/OAuth tests with D1 readback; service tests |
| ADMIN-02 | 通过 | Workers admin users/invitations/entitlements/OAuth tests with D1 readback; service tests |
| ADMIN-03 | 通过 | Workers admin users/invitations/entitlements/OAuth tests with D1 readback; service tests |
| ADMIN-04 | 通过 | Workers admin users/invitations/entitlements/OAuth tests with D1 readback; service tests |
| ADMIN-05 | 通过 | Workers admin users/invitations/entitlements/OAuth tests with D1 readback; service tests |
| ADMIN-06 | 通过 | Workers admin users/invitations/entitlements/OAuth tests with D1 readback; service tests |
| ADMIN-07 | 通过 | Workers admin users/invitations/entitlements/OAuth tests with D1 readback; service tests |
| ADMIN-08 | 通过 | Workers admin users/invitations/entitlements/OAuth tests with D1 readback; service tests |
| ADMIN-09 | 通过 | Workers admin users/invitations/entitlements/OAuth tests with D1 readback; service tests |
| ADMIN-10 | 通过 | Workers admin users/invitations/entitlements/OAuth tests with D1 readback; service tests |
| ADMIN-11 | 通过 | Workers admin users/invitations/entitlements/OAuth tests with D1 readback; service tests |
| ADMIN-12 | 通过 | Workers admin users/invitations/entitlements/OAuth tests with D1 readback; service tests |
| ADMIN-13 | 通过 | Workers admin users/invitations/entitlements/OAuth tests with D1 readback; service tests |
| ADMIN-14 | 通过 | Workers admin users/invitations/entitlements/OAuth tests with D1 readback; service tests |
| ADMIN-15 | 通过 | Workers admin users/invitations/entitlements/OAuth tests with D1 readback; service tests |
| ADMIN-16 | 通过 | Workers admin users/invitations/entitlements/OAuth tests with D1 readback; service tests |
| ADMIN-17 | 通过 | Workers admin users/invitations/entitlements/OAuth tests with D1 readback; service tests |
| ADMIN-18 | 通过 | Workers admin users/invitations/entitlements/OAuth tests with D1 readback; service tests |
| ADMIN-19 | 通过 | Workers admin users/invitations/entitlements/OAuth tests with D1 readback; service tests |
| ADMIN-20 | 通过 | Workers admin users/invitations/entitlements/OAuth tests with D1 readback; service tests |
| ADMIN-21 | 通过 | Workers admin users/invitations/entitlements/OAuth tests with D1 readback; service tests |
| ADMIN-22 | 通过 | Workers admin users/invitations/entitlements/OAuth tests with D1 readback; service tests |
| ADMIN-23 | 通过 | Workers admin users/invitations/entitlements/OAuth tests with D1 readback; service tests |
| ADMIN-24 | 通过 | Workers admin users/invitations/entitlements/OAuth tests with D1 readback; service tests |
| ADMIN-25 | 通过 | Workers admin users/invitations/entitlements/OAuth tests with D1 readback; service tests |
| ADMIN-26 | 通过 | Workers admin users/invitations/entitlements/OAuth tests with D1 readback; service tests |
| ADMIN-27 | 通过 | Workers admin users/invitations/entitlements/OAuth tests with D1 readback; service tests |
| ADMIN-28 | 通过 | Workers admin users/invitations/entitlements/OAuth tests with D1 readback; service tests |
| LEG-01 | 通过 | generated 81x2 auth operation set, app legacy pairs, Workers old/new session/OTP/WS/refresh/reset |
| LEG-02 | 通过 | generated 81x2 auth operation set, app legacy pairs, Workers old/new session/OTP/WS/refresh/reset |
| LEG-03 | 通过 | generated 81x2 auth operation set, app legacy pairs, Workers old/new session/OTP/WS/refresh/reset |
| LEG-04 | 通过 | generated 81x2 auth operation set, app legacy pairs, Workers old/new session/OTP/WS/refresh/reset |
| LEG-05 | 通过 | generated 81x2 auth operation set, app legacy pairs, Workers old/new session/OTP/WS/refresh/reset |
| LEG-06 | 通过 | generated 81x2 auth operation set, app legacy pairs, Workers old/new session/OTP/WS/refresh/reset |
| LEG-07 | 通过 | generated 81x2 auth operation set, app legacy pairs, Workers old/new session/OTP/WS/refresh/reset |
| LEG-08 | 通过 | generated 81x2 auth operation set, app legacy pairs, Workers old/new session/OTP/WS/refresh/reset |
| LEG-09 | 通过 | generated 81x2 auth operation set, app legacy pairs, Workers old/new session/OTP/WS/refresh/reset |
| LEG-10 | 通过 | generated 81x2 auth operation set, app legacy pairs, Workers old/new session/OTP/WS/refresh/reset |
| LEG-11 | 通过 | generated 81x2 auth operation set, app legacy pairs, Workers old/new session/OTP/WS/refresh/reset |
| LEG-12 | 通过 | generated 81x2 auth operation set, app legacy pairs, Workers old/new session/OTP/WS/refresh/reset |
| OAS-01 | 通过 | generate:api, check:api, lint:api; BA 1.6.11 schema normalization; OpenAPI tests 4/4 |
| OAS-02 | 通过 | generate:api, check:api, lint:api; BA 1.6.11 schema normalization; OpenAPI tests 4/4 |
| OAS-03 | 通过 | generate:api, check:api, lint:api; BA 1.6.11 schema normalization; OpenAPI tests 4/4 |
| OAS-04 | 通过 | generate:api, check:api, lint:api; BA 1.6.11 schema normalization; OpenAPI tests 4/4 |
| OAS-05 | 通过 | generate:api, check:api, lint:api; BA 1.6.11 schema normalization; OpenAPI tests 4/4 |
| OAS-06 | 通过 | generate:api, check:api, lint:api; BA 1.6.11 schema normalization; OpenAPI tests 4/4 |
| OAS-07 | 通过 | generate:api, check:api, lint:api; BA 1.6.11 schema normalization; OpenAPI tests 4/4 |
| OAS-08 | 通过 | generate:api, check:api, lint:api; BA 1.6.11 schema normalization; OpenAPI tests 4/4 |
| OAS-09 | 通过 | generate:api, check:api, lint:api; BA 1.6.11 schema normalization; OpenAPI tests 4/4 |
| OAS-10 | 通过 | generate:api, check:api, lint:api; BA 1.6.11 schema normalization; OpenAPI tests 4/4 |
| OAS-11 | 通过 | generate:api, check:api, lint:api; BA 1.6.11 schema normalization; OpenAPI tests 4/4 |
| OAS-12 | 通过 | generate:api, check:api, lint:api; BA 1.6.11 schema normalization; OpenAPI tests 4/4 |
| OAS-13 | 通过 | generate:api, check:api, lint:api; BA 1.6.11 schema normalization; OpenAPI tests 4/4 |
| OAS-14 | 通过 | generate:api, check:api, lint:api; BA 1.6.11 schema normalization; OpenAPI tests 4/4 |
| WEB-01 | 通过 | frontend API/continuation/Wizard/transport/CopyButton tests; tsc -b, lint, build |
| WEB-02 | 通过 | frontend API/continuation/Wizard/transport/CopyButton tests; tsc -b, lint, build |
| WEB-03 | 通过 | frontend API/continuation/Wizard/transport/CopyButton tests; tsc -b, lint, build |
| WEB-04 | 通过 | frontend API/continuation/Wizard/transport/CopyButton tests; tsc -b, lint, build |
| WEB-05 | 通过 | frontend API/continuation/Wizard/transport/CopyButton tests; tsc -b, lint, build |
| WEB-06 | 通过 | frontend API/continuation/Wizard/transport/CopyButton tests; tsc -b, lint, build |
| WEB-07 | 通过 | frontend API/continuation/Wizard/transport/CopyButton tests; tsc -b, lint, build |
| WEB-08 | 通过 | frontend API/continuation/Wizard/transport/CopyButton tests; tsc -b, lint, build |
| WEB-09 | 通过 | frontend API/continuation/Wizard/transport/CopyButton tests; tsc -b, lint, build |
| WEB-10 | 通过 | frontend API/continuation/Wizard/transport/CopyButton tests; tsc -b, lint, build |
| WEB-11 | 通过 | frontend API/continuation/Wizard/transport/CopyButton tests; tsc -b, lint, build |
| WEB-12 | 通过 | frontend API/continuation/Wizard/transport/CopyButton tests; tsc -b, lint, build |
| WEB-13 | 通过 | local Vite + fixed fixture desktop/mobile screenshots; 390px documentWidth=viewport=390, visible table rects=0, all fields and 4 action buttons visible |
| WEB-14 | 通过 | frontend API/continuation/Wizard/transport/CopyButton tests; tsc -b, lint, build |
| WEB-15 | 通过 | frontend API/continuation/Wizard/transport/CopyButton tests; tsc -b, lint, build |
| WEB-16 | 通过 | frontend API/continuation/Wizard/transport/CopyButton tests; tsc -b, lint, build |
| WEB-17 | 通过 | frontend API/continuation/Wizard/transport/CopyButton tests; tsc -b, lint, build |
| WEB-18 | 通过 | frontend API/continuation/Wizard/transport/CopyButton tests; tsc -b, lint, build |
| CLEAN-01 | 通过 | check:boundaries AST fixture, cleanup-ledger, import/path/export/migration scans |
| CLEAN-02 | 通过 | check:boundaries AST fixture, cleanup-ledger, import/path/export/migration scans |
| CLEAN-03 | 通过 | check:boundaries AST fixture, cleanup-ledger, import/path/export/migration scans |
| CLEAN-04 | 通过 | check:boundaries AST fixture, cleanup-ledger, import/path/export/migration scans |
| CLEAN-05 | 通过 | check:boundaries AST fixture, cleanup-ledger, import/path/export/migration scans |
| CLEAN-06 | 通过 | check:boundaries AST fixture, cleanup-ledger, import/path/export/migration scans |
| CLEAN-07 | 通过 | check:boundaries AST fixture, cleanup-ledger, import/path/export/migration scans |
| CLEAN-08 | 通过 | check:boundaries AST fixture, cleanup-ledger, import/path/export/migration scans |
| RPC-01 | 通过 | rpc/service tests plus full Workers/DO suite; named export and migration diff scan |
| RPC-02 | 通过 | rpc/service tests plus full Workers/DO suite; named export and migration diff scan |
| RPC-03 | 通过 | rpc/service tests plus full Workers/DO suite; named export and migration diff scan |
| GATE-01 | 通过 | final command table: root/frontend ci, typechecks, 554 Node, 109 Workers, frontend lint/build, API/boundary/diff checks |
| GATE-02 | 通过 | final command table: root/frontend ci, typechecks, 554 Node, 109 Workers, frontend lint/build, API/boundary/diff checks |
| GATE-03 | 通过 | final command table: root/frontend ci, typechecks, 554 Node, 109 Workers, frontend lint/build, API/boundary/diff checks |
| GATE-04 | 通过 | final command table: root/frontend ci, typechecks, 554 Node, 109 Workers, frontend lint/build, API/boundary/diff checks |
| GATE-05 | 通过 | final command table: root/frontend ci, typechecks, 554 Node, 109 Workers, frontend lint/build, API/boundary/diff checks |

## 最终命令摘要

- root npm ci: exit 0（项目 .npmrc 固定 peer 兼容模式；实际 openapi-typescript 7.13.0 + TypeScript 6 已通过生成和编译）。
- frontend npm ci: exit 0。
- npm run typecheck, npm run typecheck:do: exit 0。
- npm test: 68 files, 554 tests, exit 0。
- npm run test:do: 11 files, 109 tests, exit 0；保留已知 Containers 未启用的启动期 warning。
- frontend npx tsc -b, npm run lint, npm run build: exit 0。
- generate:api, check:api, lint:api, check:boundaries, git diff --check: exit 0。

## 2026-09-12 QuickLogin 补充验收

当前结论：Q1–Q5 已在两个隔离分支完成实现、审查修复与本地门禁；Auth HEAD `cff2a87` 已部署为 production version `08ac7991-689c-41fa-b235-ccc062f2cdda` 并接管100%流量。扩展仍只在本地分支，未发布或升级现有两台设备。本节不把旧 T00–T17 的测试计数改写为新时间点。

### Final whole-branch review 修复波

- 本地已验证：最终 Node 85 files / 683 tests、Workers/DO 20 files / 160 tests、root/DO TypeScript、frontend tsc/lint/build、OpenAPI/Cloudflare Redocly、API漂移和边界检查；153个runtime操作均有auth-policy且完整文档无空1xx/2xx body（101/204除外）。
- 生成确定性：`openapi.json`、`cloudflare.openapi.json`、`endpoints.json`、`coverage.json`、`auth-policy.json`、generated types 连续生成SHA不变。
- Workers/DO最终通过：首轮final-fix full为156/158，修正测试表名及admin-create `require_pkce`后158/158；scoped review又补齐auth-policy/OpenAPI媒体状态与transient失败竞态，最终full 20/20 files、160/160 tests、exit 0。新增Device DO success/transient keepalive/login竞态、1000波outbox持久化收敛、admin strict/no-store和QuickLogin逐资源OPTIONS均已执行；仅有既有sourcemap、overdue alarm与disabled-container噪音。
- 已部署 Auth Worker、assets 和现有 Container 镜像；未push、未发布扩展、未上传schema、未改WAF/API Shield。生产验证只覆盖无凭据路由与静态资源，不冒充真实登录/学校业务/扩展设备验收。

| 补充项 | 状态 | 当前证据 |
| --- | --- | --- |
| Q1 核心/DO | 本地通过 | Auth `59893d4` + 三轮维护修复；Task 1 Workers 7 files/90、QuickLogin Node 8 files/56、两项 TS（任务报告） |
| Q2 v1/OAuth/minimal legacy | 本地通过 | Auth `e9c07c9`/`6966a81`；root-run Workers 6 files/21，Node 77 files/615（任务报告） |
| Q3 网页/admin | 本地通过 | Auth `32cff30`/`23131a4`/`dde8c32`；Node 82 files/641，frontend/边界通过（任务报告） |
| Q4 扩展 v1 | 本地通过、未发布 | 扩展分支 `codex/quicklogin-api-v1-client`，`c399987`/`8216986`；14 files/46 tests、typecheck/build/package 通过；未发布商店、未实际升级两设备 |
| Q5 精确集合 | 本地通过 | runtime/OpenAPI 3.1.1/Cloudflare 3.0.3/endpoints/coverage 都是153个操作：132 canonical、1 websocket、15 temporary legacy、5 permanent discovery；无 wildcard、外部 ref、重复 operationId |
| Q5 QuickLogin schema | 本地通过 | native device DTO/error 与 root/admin envelope/Problem 分离；合法/非法样本在3.1/3.0投影等价；frontend DTO 改消费 generated components |
| Q5 Cloudflare config | 本地通过 | Wrangler 4.94.0；config 被 `wrangler types` 读取后 runtime loopback EPERM；`observability.enabled=true`，原 sampling/logs/traces/persist 保留，无新数据 binding |
| Q5 本地命令 | 通过 | 最终 Node 85/683、Workers/DO 20/160、root/DO TS、frontend tsc/lint/build、Redocly、原生 npm API/boundary checks 通过；六份生成物连续两次SHA一致 |
| Q5 root Workers 复跑 | 通过 | 最终审查修复后20/20 files、160/160 tests、exit 0；仅既有 Containers sourcemap、overdue alarm、未启用容器噪音 |

### 当前兼容和发布边界

- 已部署 build 已关闭通用 legacy；只保留 QuickLogin 0.1.2 的旧 authorize/token/device exact methods+OPTIONS，以及仍有效旧密码重置链接需要的 callback。D01–D05 是永久 discovery。
- 稳定 issuer 不变；root audience 只是旧扩展临时兼容。新扩展源码已改 stable issuer audience，但未发布且两台设备未实际升级。
- 未push、未上传schema或改WAF/API Shield。Ego Lite 无凭据探针已验证 v1 health/OpenAPI/JWKS、5个discovery、通用旧路由404、API OPTIONS边界、QuickLogin保护/过渡桥拒绝和静态bundle；生产流量核对、真实登录/学校业务及最终QuickLogin bridge移除留待今晚。

## 原 T00–T17 浏览器证据

- screenshots/admin-desktop.png: 本地 Vite + 固定非生产 session/users fixture，真实 React Admin 页面。
- screenshots/admin-mobile-before-responsive-fix.png: 同一 fixture 的初次移动截图，记录了被裁切问题；随后代码改为移动卡片、桌面表格。
- screenshots/admin-mobile.png: 修复后390px移动截图；`documentWidth=viewport=390`、可见table布局盒为0、4个操作按钮全部可见。

## 原 T00–T17 发布边界

未 push、未部署、未上传 Cloudflare schema、未启用 API Shield/WAF，旧地址尚未退役，永久 issuer discovery 例外保留。

### 全量 V1 切换验收（2026-09-12）

- 用户明确放弃两台旧扩展设备兼容。旧 OAuth authorize/token、reset callback、QuickLogin device methods+OPTIONS 与 root audience 已移除；D01–D05 issuer discovery 永久保留。
- TDD 证据：改测试后 Node 定点 6 项失败、Workers 定点 2 项失败，均准确命中旧 bridge/audience；实现后 Node 50/50、Workers 13/13 转绿。
- 最终本地门禁：Node 85 files / 683 tests、Workers/DO 20 files / 160 tests、扩展 14 files / 46 tests；root/DO TypeScript、frontend tsc/lint/build、API drift、boundary、Redocly 与 Wrangler dry-run 均 exit 0。
- runtime/OpenAPI 3.1.1/Cloudflare 3.0.3/endpoints/coverage/auth-policy 精确集合为138：132 canonical、1 websocket、0 legacy、5 discovery。六份生成物连续两次 SHA-256 完全一致。
- main/push/CI/production 全部完成：QuickLogin `main`=`8216986`；Auth `main`=`e58cd6a`；Actions run `34694747439` 全绿；production version `8ba77565-5078-4a04-86b2-58d48b8f0f02` 接管100%流量。
- Ego Lite `credentials:omit` 生产探针：OpenAPI operation count=138；v1 health/JWKS 与D01–D05均200；15个旧 OAuth/reset/device methods+OPTIONS 均 `application/problem+json` 404/`NOT_FOUND`；v1 QuickLogin无会话401，未知v1为Problem404，登录页加载正常。
- 仍未上传 Cloudflare schema、未改 API Shield/WAF、未访问生产 D1/KV 内容、未发布扩展商店；真实登录、学校业务和重装后的真实扩展路径不由无凭据探针替代。
