# API v1 逐项迁移清单

本文件与 [执行计划](../2026-09-11-api-v1-refactor-plan.md)、[验收标准](02-acceptance.md)、[批准设计](../../specs/2026-09-11-api-v1-refactor-design.md) 一起交付。以下路径相对于本仓库；实际执行以新隔离工作区为根。

## 1. 基线与事实边界

- 基线提交：`225d1c66d9b15ae13b9c710227649c1d47516aa4`；本轮主目录仍是 `79026ba`，没有业务改动。
- 锁文件：Better Auth 1.6.11、OAuth Provider 1.6.11、Hono 4.12.22、Zod 4.4.3。执行前核对远端；若前进，记录差异并更新此清单，不能退回旧 main 开工。
- 本地只读元数据探针：以内存 SQLite、假 KV、假密钥、`BETTER_AUTH_URL=https://auth.cqu.moe` 生成元数据；没有请求生产系统或发送邮件。探针 1 个用例通过，仅证明这次元数据读取成功，不是业务回归通过。
- 实际 `ctx.baseURL`、OAuth/OIDC issuer 都是 `https://auth.cqu.moe/api/auth`。迁移后 issuer 保持此值；HTTP endpoint URL 使用 `/api/v1/auth`。
- Cookie 定义：`__Secure-better-auth.session_token`，Domain=`cqu.moe`，Path=`/`，Secure/HttpOnly=true，SameSite=lax，maxAge=604800；session_data maxAge=300。其余已知名称为 `__Secure-better-auth.dont_remember`、`__Secure-better-auth.account_data`。记录的是定义，没有 Cookie 值。
- 本地非 HTTPS 配置仍使用现有 host-only Cookie；不能把生产 Domain 硬写到 localhost。
- 认证最终 endpoint 定义 80 个、HTTP 操作 81 个。自动生成器输出 82 个操作，额外误报 `POST /get-session`。数量用于发现遗漏，不能用硬编码数量代替集合比较。
- `SERVER_ONLY` 中的元数据 helper 由应用显式暴露为 discovery；`adminCreateOAuthClient`/`adminUpdateOAuthClient` 仍只可由服务端调用。

## 2. 全局 HTTP 合同

记号 `D<T>` 表示 JSON `{ data: T }`。除列表的 `pagination` 外，自定义成功响应不另套 `success`，也不产生 `data.data`。204 和 101 没有 JSON envelope；认证插件原生响应不包装。

```ts
interface ApiSuccess<T> { data: T }
interface PageInfo { page: number; limit: number; total: number; totalPages: number }
interface ApiProblem {
  type: 'about:blank';
  title: string;
  status: number;
  detail: string;
  code: string;
}
```

错误媒体类型为 `application/problem+json`，status 必须等于 HTTP 状态码。title 使用相应 HTTP 状态短语；detail 为安全的用户说明。保留已有业务 code，不输出原始 DB/DO/容器错误、请求体、密码、Cookie、ticket 或 OAuth secret。意外异常统一 `500 INTERNAL_ERROR`；Better Auth APIError 保留合适状态与安全业务信息。注册拦截的 `{code,message}`、OAuth `{error,error_description}` 继续按插件原生协议返回。

路径/请求规则：

1. `/api`、`/api/`、未知 `/api/*`、未知版本及未知认证路径在 API 层结束，不请求 ASSETS。不存在返回 JSON 404；已知路径不支持的方法返回 405，Allow 只含实际已挂载方法及合法 HEAD/OPTIONS。
2. 普通 GET 可按 Hono 语义响应 HEAD 且不产生 body；WebSocket 的 GET 握手不隐式允许 HEAD。OPTIONS 仅处理合法预检，不执行资源 handler，不读取 body，不创建 session 或 DO。
3. 自定义 JSON 写入只接受 `application/json`，允许 UTF-8 charset。非空 body 缺失/不支持 Content-Type 返回 415；声明 JSON 但语法错误返回 400。可省略 body 的 C04/C15/C34 将空 body 视为 `{}`；其他必需 body 为空返回相应 400。
4. v1 对象拒绝未声明字段，拒绝 null/数组代替对象；路径参数只解码一次。id 不 trim、不转数字；预设名 trim 后 1–50 个字符；分页默认 page=1/limit=20，输入必须十进制正整数，limit<=100，拒绝 NaN、负数、小数和 20abc。
5. CQU/管理接口先完成身份及路由所需权限检查，再校验业务输入。匿名请求不得进入写数据库、发送邮件或 DO 操作。规范化前后不能降低 Origin/CSRF、rate limit、scope 等现有保护。
6. 自定义敏感资源、状态和失败响应使用 `Cache-Control: no-store`。health/openapi 可例外。认证缓存规则以插件原生行为为准，不用通用中间件破坏 JWKS、Set-Cookie 或 OAuth no-store。
7. 旧入口按第 5 节转换，保留业务 code 和成功形状。新的严格校验不要求兼容旧入口原先错误地吞掉畸形 JSON、放过类型错误或缺失权限的行为。

## 3. 自定义操作逐项清单

权限：P=公开；S=有效 Better Auth session；B=有效用户 Bearer；S/B=Bearer 存在则只走 Bearer，否则 session；A=admin 或 superAdmin 的 session；EA/ER=额外 entitlement:assign/revoke；OC/OU/OD 分别表示额外 oauthClient:create/update/delete；CS=同时有 cquScope:assign 与 cquScope:revoke。权限始终以 `src/auth.ts` 的 ACL 为准，普通 admin 不因共享中间件获得 superAdmin 权限。

| ID / operationId | 原方法与完整路径 | 新方法与完整路径 | 输入 / 成功响应 | 权限 / 任务 |
| --- | --- | --- | --- | --- |
| C01 getHealth | GET `/api/health` | GET `/api/v1/health` | 无输入；200 D<{status:'ok',timestamp:ISO}> | P / T04 |
| C02 getRegistrationSettings | GET `/api/auth/registration-settings` | GET `/api/v1/registration-settings` | 无输入；200 D<{invitationRequired:boolean}> | P / T09 |
| C03 createServiceTicket | GET `/api/cqu/service-ticket` | POST `/api/v1/cqu/service-tickets` | TicketTarget；201 D<{ticket:string}> | B+token/client scope+DO 闸 / T07 |
| C04 createCquBinding | POST `/api/cqu/binding` | POST `/api/v1/cqu/binding` | 可省略 {kind?:'direct'\|'forward'}；forward为业务403；新建201/已有200 D<{address,status}> | S/B / T06 |
| C05 getCquBinding | GET `/api/cqu/binding` | GET `/api/v1/cqu/binding` | 无输入；200 D<BindingSnapshot> | S/B / T06 |
| C06 updateCquCredentials | PUT `/api/cqu/binding/credentials` | PUT `/api/v1/cqu/binding/credentials` | {studentId:string,password:string} 均非空，不 trim 密码；200 D<{studentId}> | S/B / T06 |
| C07 streamCquBindingEvents | GET `/api/cqu/binding/events` | GET `/api/v1/cqu/binding/events` | Upgrade:websocket、同源 Origin；101 原生 WS | S/B+同源 / T06 |
| C08 deleteCquBinding | DELETE `/api/cqu/binding` | DELETE `/api/v1/cqu/binding` | 无 body；204 | S/B / T06 |
| C09 getQuickloginPreference | GET `/api/cqu/quicklogin` | GET `/api/v1/cqu/quicklogin` | 无输入；200 D<{eligible:boolean,enabled:boolean}> | S / T07 |
| C10 updateQuickloginPreference | PUT `/api/cqu/quicklogin` | PUT `/api/v1/cqu/quicklogin` | {enabled:boolean}；200 D<{enabled:boolean}> | S+quicklogin_access / T07 |
| C11 listUsers | GET `/api/admin/users` | GET `/api/v1/admin/users` | page/limit；200 {data:User[],pagination:PageInfo} | A+插件 user:list / T08 |
| C12 getUser | GET `/api/admin/users/:id` | GET `/api/v1/admin/users/{id}` | id；200 D<User>，不存在404 | A+插件 user:get / T08 |
| C13 updateUser | PATCH `/api/admin/users/:id` | PATCH `/api/v1/admin/users/{id}` | 严格二选一 {banned:boolean} 或 {role:UserRole}；200 D<{id,banned}> 或 D<{id,role}> | A+插件 user:ban/set-role / T08 |
| C14 listRegistrationInvitations | GET `/api/admin/registration-invitations` | GET `/api/v1/admin/registration-invitations` | 最新100条；200 D<RegistrationInvitation[]> | A / T09 |
| C15 createRegistrationInvitation | POST `/api/admin/registration-invitations` | POST `/api/v1/admin/registration-invitations` | 可省略 {preset?:string\|null}；201 D<RegistrationInvitation & {registrationUrl}> | A / T09 |
| C16 getAdminRegistrationSettings | GET `/api/admin/registration-settings` | GET `/api/v1/admin/registration-settings` | 无输入；200 D<{invitationRequired}> | A / T09 |
| C17 updateRegistrationSettings | PUT `/api/admin/registration-settings` | PUT `/api/v1/admin/registration-settings` | {invitationRequired:boolean}；200 D<{invitationRequired}> | A+EA / T09 |
| C18 revokeRegistrationInvitation | DELETE `/api/admin/registration-invitations/:code` | DELETE `/api/v1/admin/registration-invitations/{code}` | code 沿用 normalizeInvitationCode；204 | A / T09 |
| C19 updateUserCquBinding | PATCH `/api/admin/users/:id/cqu-binding` | PATCH `/api/v1/admin/users/{id}/cqu-binding` | {status:'active'\|'revoked'}；200 D<{status}> | A / T08 |
| C20 listUserEntitlements | GET `/api/admin/users/:id/entitlements` | GET `/api/v1/admin/users/{id}/entitlements` | id；200 D<EntitlementRow[]> | A / T10 |
| C21 replaceUserEntitlements | PUT `/api/admin/users/:id/entitlements` | PUT `/api/v1/admin/users/{id}/entitlements` | {items:EntitlementItem[]}；200 D<{items}> | A+EA / T10 |
| C22 mergeEntitlementPreset | POST `/api/admin/users/:id/entitlements/preset` | PATCH `/api/v1/admin/users/{id}/entitlements` | {preset:string}；200 D<{applied:number}> | A+EA / T10 |
| C23 listEntitlementPresets | GET `/api/admin/entitlement-presets` | GET `/api/v1/admin/entitlement-presets` | 无输入；200 D<EntitlementPreset[]> | A / T10 |
| C24 replaceEntitlementPreset | PUT `/api/admin/entitlement-presets/:name` | PUT `/api/v1/admin/entitlement-presets/{name}` | name、{items:EntitlementItem[]}；200 D<{name,items}> | A+EA / T10 |
| C25 deleteEntitlementPreset | DELETE `/api/admin/entitlement-presets/:name` | DELETE `/api/v1/admin/entitlement-presets/{name}` | name；204，并清理指向它的默认配置 | A+EA / T10 |
| C26 getDefaultEntitlementPreset | GET `/api/admin/entitlement-default` | GET `/api/v1/admin/entitlement-default` | 无输入；200 D<{preset:string\|null}> | A / T10 |
| C27 updateDefaultEntitlementPreset | PUT `/api/admin/entitlement-default` | PUT `/api/v1/admin/entitlement-default` | 必须显式 {preset:string\|null}；200 D<{preset}> | A+EA / T10 |
| C28 deleteUserEntitlement | DELETE `/api/admin/users/:id/entitlements/:subsystem/:capability` | DELETE `/api/v1/admin/users/{id}/entitlements/{subsystem}/{capability}` | 完整复合键；204 | A+ER / T10 |
| C29 listOAuthClients | GET `/api/admin/oauth-clients` | GET `/api/v1/admin/oauth-clients` | 无输入；200 D<OAuthClientView[]>，不含 secret/hash | A / T11 |
| C30 replaceOAuthClientScopes | PUT `/api/admin/oauth-clients/:id/scopes` | PUT `/api/v1/admin/oauth-clients/{id}/scopes` | {scopes:string[]}，重复项400；200 D<{client_id,scopes}> | A+CS / T11 |
| C31 getOAuthClientScopes | GET `/api/admin/oauth-clients/:id/scopes` | GET `/api/v1/admin/oauth-clients/{id}/scopes` | id；200 D<{client_id,scopes}> | A / T11 |
| C32 createOAuthClient | POST `/api/admin/oauth-clients` | POST `/api/v1/admin/oauth-clients` | OAuthClientCreate；201 D<插件创建结果>，secret仅本次 | A+OC / T11 |
| C33 updateOAuthClient | PATCH `/api/admin/oauth-clients/:id` | PATCH `/api/v1/admin/oauth-clients/{id}` | OAuthClientPatch 非空；200 D<{client_id,client_secret?:string}> | A+OU / T11 |
| C34 createOAuthClientSecret | POST `/api/admin/oauth-clients/:id/rotate-secret` | POST `/api/v1/admin/oauth-clients/{id}/secrets` | 可省略空对象；201 D<{client_id,client_secret}> | A+OU / T11 |
| C35 deleteOAuthClient | DELETE `/api/admin/oauth-clients/:id` | DELETE `/api/v1/admin/oauth-clients/{id}` | id；204；先 accessToken、refreshToken、consent，再 client、scope | A+OD / T11 |
| M01 getOpenApiDocument | 无 | GET `/api/v1/openapi.json` | 完整 OAS 3.1.1 文档对象，非 D<T> | P / T12 |

### 3.1 数据类型和语义

- `UserRole`=`user|admin|superAdmin`；用户、session 的实际字段沿用插件配置，日期跨 HTTP 为 ISO 字符串。不要把 TS Date 直接写进公开契约。
- `TicketTarget` 是严格 union：`{service:'jwxt'|'jxpj'|'library'|'card'}` 或 `{serviceUrl:string}`。serviceUrl 用现有 `validateCquServiceUrl` 规范化，并在 DO 再校验。两者都传返回 `400 INVALID_TARGET`；都缺返回 `400 MISSING_SERVICE`；无效 URL 保留 `INVALID_SERVICE_URL`。新接口 GET/HEAD 不得铸票。
- `BindingSnapshot`=`{address?:string,bindStatus:'unbound'|'pending'|'active'|'revoked',kind?:'direct'|'forward',forwardAddress?:string,sessionStatus: CquSessionStatus | {error:true}}`。CquSessionStatus必有status/atrustStatus；有state时另有studentId/loginAt/lastKeepAlive/lastRequestedAt/atrustLoginAt/atrustLastUsedAt。时间戳维持当前毫秒数。状态枚举对照现有状态机；不暴露DO内部state、cookie或credentials。
- C04 的新创建只支持 direct；显式 `kind:'forward'` 在新旧入口均返回 `403 FORWARD_MODE_DISABLED`，schema允许识别forward这个输入值，再在业务层给403；不能先被通用enum校验吞成另一个错误。读旧 forward 记录、恢复旧 forward 页面和邮件 sender 校验仍保留。
- `EntitlementItem`=`{subsystem:string,capability:string,value:string}`；value 沿用现有存储协议，由 `validateEntitlementItems` 检查目录键、flag/quota、有限数值和复合键唯一性。`[]` 对 C21 表示清空整组。C22 是仅覆盖预设键的 merge，绝不可变成整组替换。
- `EntitlementRow` 在 Item 基础上带 userId 及基线实际返回的元数据；`EntitlementPreset` 保留 name/items/updatedAt。定义由 schema 推导、输出 OpenAPI 后生成前端类型，禁止前后端手写两套 DTO。
- `RegistrationInvitation` 保留 code/createdBy/createdAt/expiresAt/claimedAt/claimedByEmail/usedAt/usedByUserId/revokedAt/preset/status。code 仍是 8 位现有 alphabet、默认 7 天有效；不得因重构改变申领并发或有效期。
- `OAuthClientView` 仅保留 snake_case 正式字段：client_id/client_name/client_uri/logo_uri/tos_uri/policy_uri/contacts/redirect_uris/post_logout_redirect_uris/token_endpoint_auth_method/grant_types/response_types/scope/type/require_pkce/skip_consent/enable_end_session/subject_type/disabled/metadata。删除 v1 的 id/clientId/name 重复别名，旧列表由适配器补回。
- OAuth create 以锁定版本 `adminCreateOAuthClient` 的实际 body schema 为准，保留 software_id/software_version/software_statement 等实际支持字段，不能只按现有表单裁剪。OAuth patch 的完整可写字段集保持原映射：client_name/client_uri/logo_uri/tos_uri/policy_uri/token_endpoint_auth_method/type/subject_type/contacts/redirect_uris/post_logout_redirect_uris/grant_types/response_types/skip_consent/enable_end_session/require_pkce/disabled/metadata/scope。id、userId、client_secret、clientSecret 均不是可直写字段。
- OAuth patch 在已有配置上验证最终 public/type/redirect URI/grant_types/response_types/scope；public→confidential 生成一次 secret，反向切换清 secret。secret 哈希仍是现有 SHA-256/base64url 算法，不替换为密码哈希。
- C30 的 scope 沿用现有 `^cqu:ticket:([\w*]+)$` 合法集合，不能把 UI 四个选项当成后端完整白名单。重复项400，空数组清空，delete+insert 一个 D1 batch。该写接口补 ACL 是有意的权限收紧，旧入口同样执行。

## 4. 认证插件端点完整挂载清单

以下是本地最终 `getEndpoints(await auth.$context, auth.options).api` 的非 SERVER_ONLY、未禁用操作。B 编号只用于迁移追踪，不自动充当对外 operationId。每行旧前缀 `/api/auth`，新前缀 `/api/v1/auth`；请求、响应、鉴权和状态保留锁定插件的实际实现。这里的81不包含传输层派生的HEAD/OPTIONS；Allow与endpoints清单须显式登记实际放行的这些方法，不能靠数量对齐把它们漏掉。

`BA` 表示插件原生授权：可能是 session、二次验证 Cookie、密码确认、OAuth client authentication、access token 或公开配置读取；不代表一律公开或一律 Bearer。T00/T05 必须从本行方法对应的 middleware/body 条件建立 `auth-policy.json`，以允许/拒绝请求测试校验，不能照抄生成器统一的 bearerAuth 标记。业务未启用的 core/social 入口保持原来的受控拒绝，不因出现在清单而开启功能。

| ID | Method | 后缀（新旧前缀共用） | 插件 key / 例外 |
| --- | --- | --- | --- |
| B01 | POST | `/sign-in/social` | signInSocial；BA |
| B02 | GET | `/callback/{id}` | callbackOAuth；BA |
| B03 | POST | `/callback/{id}` | callbackOAuth；BA |
| B04 | GET | `/get-session` | getSession；BA；仅 GET，customSession 带 caps |
| B05 | POST | `/sign-out` | signOut；BA |
| B06 | POST | `/sign-up/email` | signUpEmail；BA；前置邀请码原子拦截 |
| B07 | POST | `/sign-in/email` | signInEmail；BA |
| B08 | POST | `/reset-password` | resetPassword；BA |
| B09 | POST | `/verify-password` | verifyPassword；BA |
| B10 | POST | `/send-verification-email` | sendVerificationEmail；BA |
| B11 | POST | `/change-email` | changeEmail；BA |
| B12 | POST | `/change-password` | changePassword；BA |
| B13 | POST | `/update-session` | updateSession；BA |
| B14 | POST | `/update-user` | updateUser；BA |
| B15 | POST | `/delete-user` | deleteUser；BA |
| B16 | POST | `/request-password-reset` | requestPasswordReset；BA |
| B17 | GET | `/reset-password/{token}` | requestPasswordResetCallback；BA |
| B18 | GET | `/list-sessions` | listSessions；BA |
| B19 | POST | `/revoke-session` | revokeSession；BA |
| B20 | POST | `/revoke-sessions` | revokeSessions；BA |
| B21 | POST | `/revoke-other-sessions` | revokeOtherSessions；BA |
| B22 | POST | `/link-social` | linkSocialAccount；BA |
| B23 | GET | `/list-accounts` | listUserAccounts；BA |
| B24 | GET | `/delete-user/callback` | deleteUserCallback；BA |
| B25 | POST | `/unlink-account` | unlinkAccount；BA |
| B26 | POST | `/refresh-token` | refreshToken；BA |
| B27 | POST | `/get-access-token` | getAccessToken；BA |
| B28 | GET | `/account-info` | accountInfo；BA |
| B29 | GET | `/cloudflare/geolocation` | getGeolocation；BA |
| B30 | POST | `/admin/set-role` | setRole；BA |
| B31 | GET | `/admin/get-user` | getUser；BA |
| B32 | POST | `/admin/create-user` | createUser；BA |
| B33 | POST | `/admin/update-user` | adminUpdateUser；BA |
| B34 | GET | `/admin/list-users` | listUsers；BA |
| B35 | POST | `/admin/list-user-sessions` | listUserSessions；BA |
| B36 | POST | `/admin/unban-user` | unbanUser；BA |
| B37 | POST | `/admin/ban-user` | banUser；BA |
| B38 | POST | `/admin/impersonate-user` | impersonateUser；BA |
| B39 | POST | `/admin/stop-impersonating` | stopImpersonating；BA |
| B40 | POST | `/admin/revoke-user-session` | revokeUserSession；BA |
| B41 | POST | `/admin/revoke-user-sessions` | revokeUserSessions；BA |
| B42 | POST | `/admin/remove-user` | removeUser；BA |
| B43 | POST | `/admin/set-user-password` | setUserPassword；BA |
| B44 | POST | `/admin/has-permission` | userHasPermission；BA |
| B45 | GET | `/jwks` | getJwks；BA |
| B46 | GET | `/oauth2/authorize` | oauth2Authorize；BA |
| B47 | POST | `/oauth2/consent` | oauth2Consent；BA |
| B48 | POST | `/oauth2/continue` | oauth2Continue；BA |
| B49 | POST | `/oauth2/token` | oauth2Token；BA |
| B50 | POST | `/oauth2/introspect` | oauth2Introspect；BA |
| B51 | POST | `/oauth2/revoke` | oauth2Revoke；BA |
| B52 | GET | `/oauth2/userinfo` | oauth2UserInfo；BA |
| B53 | GET | `/oauth2/end-session` | oauth2EndSession；BA |
| B54 | POST | `/oauth2/register` | registerOAuthClient；BA |
| B55 | POST | `/oauth2/create-client` | createOAuthClient；BA |
| B56 | GET | `/oauth2/get-client` | getOAuthClient；BA |
| B57 | GET | `/oauth2/public-client` | getOAuthClientPublic；BA |
| B58 | POST | `/oauth2/public-client-prelogin` | getOAuthClientPublicPrelogin；BA |
| B59 | GET | `/oauth2/get-clients` | getOAuthClients；BA |
| B60 | POST | `/oauth2/update-client` | updateOAuthClient；BA |
| B61 | POST | `/oauth2/client/rotate-secret` | rotateClientSecret；BA |
| B62 | POST | `/oauth2/delete-client` | deleteOAuthClient；BA |
| B63 | GET | `/oauth2/get-consent` | getOAuthConsent；BA |
| B64 | GET | `/oauth2/get-consents` | getOAuthConsents；BA |
| B65 | POST | `/oauth2/update-consent` | updateOAuthConsent；BA |
| B66 | POST | `/oauth2/delete-consent` | deleteOAuthConsent；BA |
| B67 | POST | `/email-otp/send-verification-otp` | sendVerificationOTP；BA |
| B68 | POST | `/email-otp/check-verification-otp` | checkVerificationOTP；BA |
| B69 | POST | `/email-otp/verify-email` | verifyEmailOTP；BA |
| B70 | POST | `/email-otp/request-email-change` | requestEmailChangeEmailOTP；BA |
| B71 | POST | `/email-otp/change-email` | changeEmailEmailOTP；BA |
| B72 | POST | `/two-factor/get-totp-uri` | getTOTPURI；BA |
| B73 | POST | `/two-factor/verify-totp` | verifyTOTP；BA |
| B74 | POST | `/two-factor/send-otp` | sendTwoFactorOTP；BA |
| B75 | POST | `/two-factor/verify-otp` | verifyTwoFactorOTP；BA |
| B76 | POST | `/two-factor/verify-backup-code` | verifyBackupCode；BA |
| B77 | POST | `/two-factor/generate-backup-codes` | generateBackupCodes；BA |
| B78 | POST | `/two-factor/enable` | enableTwoFactor；BA |
| B79 | POST | `/two-factor/disable` | disableTwoFactor；BA |
| B80 | GET | `/ok` | ok；BA |
| B81 | GET | `/error` | error；BA；改为302至 /auth/error，见第6节 |

必须继续禁用的后缀：`/token`、`/sign-in/email-otp`、`/email-otp/request-password-reset`、`/forget-password/email-otp`、`/email-otp/reset-password`、`/verify-email`。新旧入口均拒绝，不能导入 CF 活跃端点清单。不要禁止仍需使用的 `/email-otp/verify-email`。

SERVER_ONLY `/admin/oauth2/create-client`、`/admin/oauth2/update-client` 不挂 HTTP。应用 C32/C33 按原逻辑在服务端使用 plugin API 或 adapter，不能把原生 helper 变成一个通配代理入口。

## 5. 旧入口适配要求

兼容表是有限集合，来自第3节与第4节最终实际挂载方法；旧 devices/refresh/export 等独立 QuickLogin 开发接口不在表内。`src/api/legacy.ts` 可以引用按业务分组的数据映射，不新增重复 handler 或在每个页面判断 legacy/v1。

| 操作 | 旧请求→新请求 | 新结果→旧结果 |
| --- | --- | --- |
| C01 | 仅换路径 | 解包 data，保留兼容字段 version:'d1native-fix'；该字段仅留在旧 health |
| C02/C16 | 仅换路径 | 解包为 {invitationRequired} |
| C03 | GET query→POST JSON；非空 serviceUrl 优先于 service；都空保持 MISSING_SERVICE | 201 D<{ticket}>→200 {ticket}；失败 code 不变，保留 no-store |
| C04/C05 | body/查询语义不变；C04仍接受空 body | 解包 data；创建状态码200/201保持 |
| C06 | body不变 | {success:true,studentId} |
| C07 | 更换路由后继续保留原始 Origin/Upgrade 与请求身份 | 直接返回原始101/WS对象；不得读取body或new Response重建 |
| C08/C18 | 仅换路径 | 原来就是204，仍无body |
| C09/C10 | body不变；不能用Bearer代替session | 解包data |
| C11/C12/C14/C15/C20/C23 | 仅换路径 | 原本已有data，保持原形状；C11 pagination不变 |
| C13 | action=ban→banned:true；unban→false；role按旧优先级映射；未知action保持INVALID_ACTION | ban/unban返回{success:true,action:'banned'/'unbanned'}；role返回{success:true,role} |
| C17 | body不变 | {success:true,invitationRequired} |
| C19 | body不变 | {success:true,status} |
| C21/C24 | body不变 | {success:true} |
| C22 | POST /preset→PATCH collection，body保持{preset} | {success:true,applied} |
| C25/C28/C35 | 仅换路径 | v1的204→200 {success:true} |
| C26 | 仅换路径 | {preset} |
| C27 | 旧省略preset视为null；v1要求显式字段 | {success:true,preset} |
| C29 | 仅换路径 | 在data[]补id=client_id、clientId=client_id、name=client_name??client_id |
| C30 | 同body；同样补CS权限和原子写入 | {success:true,clientId:client_id,scopes} |
| C31 | 仅换路径 | {clientId:client_id,scopes} |
| C32 | 同body | 201→旧200，仍{data:插件创建结果} |
| C33 | 同body | 无secret→{success:true}；有secret→{success:true,data:{client_id,client_secret}} |
| C34 | POST rotate-secret→POST secrets | 201→旧200，仍{data:{client_id,client_secret}} |
| 所有自定义失败 | 保留业务失败语义 | Problem Details→{detail:{error:{code,message:detail}}}；状态码不改 |
| B01–B81 | 按精确方法、参数路径换前缀；不重新编码查询，不修改form/JSON body | 原生状态/body/Location/全部Set-Cookie保持；/error按第6节例外 |

路径匹配按分段执行，`:id` 不匹配任意斜杠；错误方法不得回退到其他路径。重写不丢请求来源 headers/Cloudflare cf 信息，不递归进入同一个 legacy handler。认证统一使用规范化后的路径做 rate-limit key，新旧路径不能各拿一份限额。对 signed OAuth query、reset-password token 与 POST callback 做真实兼容测试；失败就修适配或保留必要的局部 callback 处理，不能通过双建 auth 系统绕过去。

没有自动写入的 Sunset 日期。兼容期保留只按 method/route/status 聚合的计数证据，不记录个人身份或秘密。独立退役须另行确认调用方迁移，不属于本轮本地交付条件。

## 6. 标准发现与页面例外

| ID | 方法 / 路径 | 目的 |
| --- | --- | --- |
| D01 | GET `/.well-known/oauth-authorization-server` | 保留现有根发现地址 |
| D02 | GET `/.well-known/openid-configuration` | 保留现有根 OIDC 地址 |
| D03 | GET `/api/auth/.well-known/openid-configuration` | 与保持不变的 issuer 相匹配的 OIDC 标准发现地址 |
| D04 | GET `/api/auth/.well-known/oauth-authorization-server` | issuer 后缀式 OAuth 发现地址 |
| D05 | GET `/.well-known/oauth-authorization-server/api/auth` | 带 issuer path 的标准 OAuth 发现地址 |

D01–D05 共享 helper，issuer与JWKS key集合保持稳定，authorization/token/userinfo/introspection/revocation/end_session endpoint均指向v1。这些是永久协议发现例外，不归入可删除的普通旧 API 映射。

`GET /api/v1/auth/error` 与旧 `/api/auth/error` 返回302到 `/auth/error`，仅转发已知错误码，不携带原始异常文字或任意外部目标。前端 AuthError 页面复用当前布局，显示固定安全说明和回登录链接；不新增文档 UI。OAuth正常授权302、密码重置回调302和WebSocket101继续允许。OpenAPI描述302/Location，不谎写200 JSON或HTML。

## 7. 文件迁移清单

| 现有位置 | 目标 / 处理 | 必须连带更新 |
| --- | --- | --- |
| `src/index.ts` | 保留Worker入口；路由装配移至`src/app.ts` | email/queue、AuthService、CquSessionDO、CquLoginContainer及两个兼容DO导出 |
| `src/capabilities.ts`、`src/user-roles.ts` | 移至`shared/capabilities.ts`、`shared/user-roles.ts` | 全部前后端/测试引用；旧转发壳最终删除 |
| `src/routes/cqu-bind.ts` | `src/api/v1/cqu-binding.ts`+同目录schema | getCquBinding、现有binding测试、WS代理、legacy映射 |
| `src/routes/cqu.ts` | `src/api/v1/cqu-service-tickets.ts`+schema | scope中间件、service模式选择、legacy GET适配 |
| `src/routes/cqu-quicklogin.ts` | `src/api/v1/cqu-quicklogin.ts`+schema | session-only与双flag语义 |
| `src/routes/admin.ts` | `src/api/v1/admin/{users,invitations,entitlements,oauth-clients}.ts`及各自schema | user/admin gating、细粒度ACL、错误、body校验 |
| admin.ts OAuth私有helpers | `src/services/oauth-clients.ts` | 仅移必要的adapter映射、合并校验、视图序列化、secret操作 |
| `src/middleware/scope.ts` | 仅验证claims/客户端scope；纯scope函数移`shared`之外的`src/services/oauth-scopes.ts` | RPC和所有测试使用同一纯scope函数 |
| CQU/Admin重复session/JWT | `src/middleware/authentication.ts` | request-local auth实例、principal、缓存的claims |
| `src/utils/error.ts` | 正式错误集中`src/api/problem.ts`，旧形状只在legacy转换 | 不修改DO/RPC内部协议为Problem Details |
| 前端散落fetch | `frontend/src/lib/api/{http,admin,cqu,registration}.ts` | 统一v1基址、Problem错误、204、AbortSignal与旧响应迁移 |
| `frontend/src/pages/Admin.tsx` | 页面入口+`frontend/src/features/admin/{UsersSection,InvitationsSection,EntitlementsSection,OAuthClientsSection}.tsx` | 保留tab/弹窗/权限可见性/复制secret与全部表单字段 |
| Settings/CquBindWizard重复WS | `frontend/src/lib/api/binding-events.ts`和`shared/cqu-events.ts` | 共享transport，页面各自保留展示/恢复/完成判断 |
| CopyButton重复实现 | `frontend/src/components/CopyButton.tsx` | 只统一行为；允许明确className/文字参数保留原视觉 |
| `frontend/src/lib/auth-client.ts` | 显式`basePath:'/api/v1/auth'` | OTP/twoFactor/OAuth插件保持 |
| `frontend/vite.config.ts` | API proxy启用ws，origin保持与后端配置一致 | localhost真实WS握手；不放宽生产Origin规则 |
| `frontend/src/App.tsx` | 增加`/auth/error`页面 | `/oauth/authorize`仍是页面 |
| `package.json`、锁文件、tsconfig、vitest、eslint、CI | 加schema工具与合同/边界门禁 | root测试纳入shared测试；前端用`tsc -b`；禁用db:generate危险脚本 |
| 接入文档、CLAUDE.md/HANDOFF.md | 更新当前路由/命令/目录 | 不批量改写历史设计、冻结参考和回滚材料 |

## 8. 有证据才能删除

确定可删：forward新创建分支return后的代码及其仅为该分支存在的变量；迁移完成后无调用的旧路由文件、错误解析函数、类型重复、鉴权重复、API路径常量重复、纯解释语法的注释、已失效LOGIN_NODE测试说明和危险db:generate脚本。

需要检查调用再定：PRESETS/isFlag/isQuota、纯转发工具、组件props、旧复制回退、DO内部解析helper和依赖包。引用扫描必须覆盖测试、构建配置、动态导入、Docker入口、Worker命名导出；不可按文件名含node就删除仍用于Cloudflare容器的cqu-node-protocol。

明确保留：既有9个SQL迁移、DO迁移图、两个兼容DO导出、NODE_RETIRED终态、legacy forward数据读取和邮件处理、OTP/2FA契约、CQU凭证优先的绑定真值、Schedule RPC、冻结参考与回滚证据。迁移期legacy代码按访问映射登记，不能为降低净行数提前删除。
