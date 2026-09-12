# API v1 refactor acceptance results

范围：本地隔离工作区，仅假邮件、假 CQU 出站、真实本地 HTTP/Auth/D1/KV/DO/WS。未访问生产 D1/KV、真实学校凭据或真实邮件。

结论：代码、协议、契约、全部命令门禁和 WEB-13 浏览器验收均通过。Admin 使用同一固定 fixture 完成桌面与 390px 移动截图；移动端初次发现表格裁切后改为卡片布局，复验确认页面宽度等于 viewport、无横向溢出、隐藏表格无布局盒，姓名、角色、状态、日期及4个操作按钮全部可达。

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

## 浏览器证据

- screenshots/admin-desktop.png: 本地 Vite + 固定非生产 session/users fixture，真实 React Admin 页面。
- screenshots/admin-mobile-before-responsive-fix.png: 同一 fixture 的初次移动截图，记录了被裁切问题；随后代码改为移动卡片、桌面表格。
- screenshots/admin-mobile.png: 修复后390px移动截图；`documentWidth=viewport=390`、可见table布局盒为0、4个操作按钮全部可见。

## 发布边界

未 push、未部署、未上传 Cloudflare schema、未启用 API Shield/WAF，旧地址尚未退役，永久 issuer discovery 例外保留。
