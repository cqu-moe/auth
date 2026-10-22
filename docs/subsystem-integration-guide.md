# 子系统接入指南

> 给**实现各子系统(日历、教评、浏览器插件…)的 agent / 开发者**读。
> auth.cqu.moe 是统一身份提供方:用户登录 + 分级能力(entitlements)+ 代理访问 CQU CAS。
> 设计依据见 `docs/plans/2026-06-14-firstparty-entitlements-design.md`。
> **本指南描述已上线的接入契约**(2026-06-14 起 auth 侧 entitlements + RPC + serviceUrl 取票全部实现)。

---

## 0. 先选拓扑(决定你怎么接)

你的子系统**部署在哪**决定接入方式。功能/能力/取票逻辑三种一样,变的只是"身份怎么传"。

```
你的子系统跑在哪?
 ├─ 同一 CF 账户、*.cqu.moe 子域的 Worker → 拓扑①(共享 cookie + RPC)⭐ 最省事
 ├─ *.cqu.moe 子域,但非 Worker / 跨账户   → 拓扑②(共享 cookie + JWT)
 └─ 别的根域名 / 浏览器插件               → 拓扑③(OAuth + PKCE)
```

| 你是 | 读 |
|------|----|
| 同账户 `*.cqu.moe` Worker(日历、教评推荐此形) | §1 + §3 + §4 |
| `*.cqu.moe` 非 Worker / 跨账户 | §2 + §3 + §4 |
| 不同域名的第一方应用 | §2(用 OAuth)+ §4 |
| 浏览器快捷登录插件 | §5 |
| 真·第三方应用 | §6 |

所有子系统都要先 **§7 注册一个 client**。

---

## 1. 拓扑①:同账户 Worker(共享 cookie + RPC)

最接近"原生一体":浏览器一次登录全子域通,服务端进程内 RPC 调 auth,**离线也能取票**。

### 1.1 浏览器登录态(SPA)

用户在 `auth.cqu.moe` 登录后,cookie 自动落在 `.cqu.moe` 全子域。你的前端**无需任何 OAuth 跳转**,带 cookie 请求自己的后端即可;后端用 RPC 验证。
未登录时把用户重定向到 `https://auth.cqu.moe/login?redirect=<你的页面>`。

### 1.2 服务端:Service Binding RPC

`wrangler.jsonc` 加 binding 指向 auth Worker:

```jsonc
{ "services": [{ "binding": "AUTH", "service": "cqu-auth" }] }
```

调用(进程内、不走公网、部署期绑定即访问控制):

```ts
// 1) 验证身份 + 拿实时能力
const sess = await env.AUTH.verifySession(req.headers.get("cookie"))
//    → null(未登录) | { user: { id, name, email, role }, caps: { <subsystem>: {...} } }
if (!sess) return new Response("unauthorized", { status: 401 })

// 2) 功能门禁:读自己这片 caps(见 §4)
if (!sess.caps.calendar?.sync) return new Response("功能未开通", { status: 403 })

// 3) 取 CQU service ticket(见 §3;离线任务同样可调,无需用户在场)
//    ⚠️ getCquTicket 必须传本 client 的 clientSecret(把它存成你 Worker 的 secret)。
//    RPC 是进程内调用、任一被绑定 Worker 都能自报任意 clientId,故 auth 端强制校验
//    client_secret(M-6),不验证就只返回 { error: "INVALID_CLIENT" }。
const r = await env.AUTH.getCquTicket({
  clientId: "calendar",
  clientSecret: env.CQU_AUTH_CLIENT_SECRET,   // 注册时拿到的机密、存成 Worker secret
  service: "jwxt",                            // 或广域:serviceUrl: "https://my.cqu.edu.cn/..."(需 cqu:ticket:any + 用户 cqu.quicklogin opt-in)
  userId: sess.user.id,
})
if ("error" in r) { /* INVALID_CLIENT | FORBIDDEN | SESSION_INACTIVE | RATE_LIMITED | QUICKLOGIN_NOT_ENABLED | INVALID_SERVICE_URL */ }
else { const st = r.ticket /* ST-... */ }
```

> 已实现签名:
> - `verifySession(cookieHeader: string | null) → null | { user, caps }`(caps 实时,全子系统;需用户 cookie,**仅在线**)。
> - `getCaps({ clientId, clientSecret, userId }) → null | { calendar }`(**离线**读权益:无 cookie/session,直查 entitlements 表,只返回你这片 caps;须验 `client_secret`,见 §1.3)。
> - `getCquTicket({ clientId, clientSecret, service?, serviceUrl?, userId }) → { ticket } | { error }`。
>   取票全程经 auth 的 DO 万能闸:host 校验 + `cqu.quicklogin_access` 功能开放闸 + 用户 `cqu.quicklogin` opt-in(后两道仅 serviceUrl 广域路径)+ 限流 + 审计。
> - `cquHarvest({ clientId, clientSecret, userId, navUrl, capture?, fetch? }) → { captures, fetches } | { error }`。
>   **organic harvest 批量取数原语**(my.cqu.edu.cn 全站瑞数化后,后端纯 HTTP POST 取课表被
>   412 专守;唯一过墙 = 让真前端在 auth 已登录浏览器里有机 fire 请求、auth 截获响应)。
>   auth 在用户已登录 + 已过瑞数的临时浏览器里 `navigate navUrl`(页面自动 fire 课表/学期等
>   有机请求)+ 截获 url 命中 `capture[]` 子串模式的响应 + 对 `fetch[]`(仅 GET)跑同源 in-page
>   fetch,一把返回。
>   - 入参:`navUrl`(必填)/`fetch[].url` 的 host 只能是精确的
>     `my.cqu.edu.cn`(比取票 `*.cqu.edu.cn` 更紧,防开放代理 SSRF);
>     `fetch[].method` 仅 `GET`;
>     `capture[]` 是 URL 子串模式(`pattern in resp.url`)。
>   - 出参:`captures: [{ url, status, contentType, body }]`(按 `capture[]` 顺序);
>     `fetches: [{ url, status, body }]`(按 `fetch[]` 顺序);`body` 是文本,JSON 由调用方解析。
>   - 鉴权:同 `getCquTicket` —— M-6 `client_secret` 校验。Direct harvest 使用普通
>     CAS `state.storageState`,并要求会话 `active`。**不做 client-scope 检查**
>     (通用原语,业务级权益门禁在调用方侧)。
>   - 错误码(`{ error }`):`INVALID_CLIENT`(secret 错/client 禁用)| `NEEDS_REAUTH`(直连
>     CAS 需重绑)| `SESSION_INACTIVE` | `RATE_LIMITED` | `INVALID_HARVEST_URL`(host 越界/混用)
>     | `TGT_EXPIRED`(Direct CAS 失效,已排即时重登)| `WAF_CHALLENGE`
>     (瑞数挑战/容器超时)。

### 1.3 离线 / 后台任务

Cron Worker 等用户不在场的场景:**直接 `env.AUTH.getCquTicket({...})`,全程无用户 cookie/token**(只需带本 client 的 `clientSecret`)。授权 = service binding 机器信任 + `clientSecret` 校验 + client-scope + 用户 CQU 会话 `active`。CQU 会话由 auth 的 Durable Object 常驻维护(无人值守续命),用户只需**绑定过一次**。

**离线读能力(caps)**:后台无 cookie/session,**用不了 `verifySession`** 读 caps;改用 `getCaps` 按 userId 直查权益:

```ts
const caps = await env.AUTH.getCaps({
  clientId: "calendar",
  clientSecret: env.CQU_AUTH_CLIENT_SECRET,
  userId,
})
//  → null | { calendar: { sync, external, share, sub_limit, share_limit, sync_interval, manual_refresh } }
if (!caps?.calendar?.sync) { /* 无权益/未开通 → 停同步(fail-closed) */ }
```

- 只返回**你这片**(当前为 `calendar`;最小披露,直查 `user_entitlement` 表,实时权威)。字段集见 §4 / `src/capabilities.ts`。
- `null` = 用户不存在 / 无任何权益行 → 调用方按**无权益 fail-closed**(硬撤销 = 删光权益行即天然停同步、停公开链接)。
- 同样**须验 `client_secret`(M-6)**:`getCaps` 是按任意 `userId` 枚举的原语,无 per-user 凭证(不同于 `verifySession` 以用户 cookie 为凭证、只能查持有者),不验则任一被绑定 Worker 可扫全员权益画像。
- ⚠️ **认证失败也返回 `null`**(clientId 不存在 / secret 错 / client 被禁用,opaque 刻意不可区分于"无权益")。传错凭证 → **全员被判无权益、无显式报错**。接入时务必确认 clientId/secret 正确(可用同套凭证调 `getCquTicket` 联调验证)。

### 1.4 Direct organic harvest 取数

`my.cqu.edu.cn` 全站上瑞数 WAF 后,后端纯 HTTP POST 取课表会被 412 专守。
`cquHarvest` 使用普通 CAS 会话导航 Direct 应用，让真前端有机 fire 课表 POST，
auth 截获响应。会话过期时返回 `TGT_EXPIRED` 并排即时 CAS 重登，不会用空数据
覆盖最后一份成功数据。

```ts
const r = await env.AUTH.cquHarvest({
  clientId: "calendar",
  clientSecret: env.CQU_AUTH_CLIENT_SECRET,
  userId,
  navUrl: "https://my.cqu.edu.cn/workspace/curriculum",
  capture: ["student/my-table-detail"],                  // URL 子串模式
  fetch: [{ method: "GET", url: "https://my.cqu.edu.cn/api/exam/x" }],
})
//  → { captures: [{ url, status, contentType, body }], fetches: [{ url, status, body }] } | { error }
if ("error" in r) { /* TGT_EXPIRED/WAF_CHALLENGE 退避;NEEDS_REAUTH 提示用户重绑;其余 fail-closed */ }
```

- host 红线只允许精确 `my.cqu.edu.cn`;**不做 client-scope 检查**
  (通用取数原语,业务级权益门禁
  在调用方 schedule 侧)。
- 错误码语义见 §1.2;所有失败都应 fail-closed，不得把缺失响应当成空课表写回。

---

## 2. 拓扑②③:OAuth + PKCE + JWT

非同账户 Worker(VPS/Python、跨账户、别的域名)走标准 OAuth。自家应用注册时由 admin 设 `skipConsent=true`,体验≈静默(不弹同意页)。

### 2.1 授权码 + PKCE

```js
// 生成 PKCE
async function generatePKCE() {
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { verifier, challenge };
}
```

```
GET https://auth.cqu.moe/api/v1/auth/oauth2/authorize
  ?client_id=YOUR_CLIENT_ID
  &redirect_uri=https://your-app.cqu.moe/callback   # 必须精确匹配注册值
  &response_type=code
  &scope=openid profile email offline_access cqu:ticket:jwxt
  &state=RANDOM &code_challenge=CHALLENGE &code_challenge_method=S256
```

回调拿 `code` 换 token:

```
POST https://auth.cqu.moe/api/v1/auth/oauth2/token   (application/x-www-form-urlencoded)
grant_type=authorization_code &code=... &client_id=... &client_secret=...
&redirect_uri=... &code_verifier=ORIGINAL_VERIFIER
```

响应含 `access_token`(JWT)、`refresh_token`(若请求 `offline_access`)、`id_token`。

### 2.2 离线验 JWT + 读 caps

下游用 JWKS 离线验证,**不必每次回 auth**:

```ts
import { createRemoteJWKSet, jwtVerify } from "jose"
const JWKS = createRemoteJWKSet(new URL("https://auth.cqu.moe/api/v1/auth/jwks"))
const { payload } = await jwtVerify(token, JWKS, {
  issuer: "https://auth.cqu.moe/api/auth",   // pin 死 issuer
  audience: "YOUR_CLIENT_ID",                 // pin 死 audience
})
// payload.sub = 用户ID;payload.caps = 你这片能力(见 §4)
```

**撤销滞后**:JWT 在过期前无法即时撤销 → access_token TTL 短(默认 1h);需要即时生效的特权操作回查 auth。

### 2.3 离线 / 后台任务

初次授权请求 `offline_access`,**加密存管 refresh token**;后台先用它换 access_token,再按 §3 取票。(拓扑① 无此负担,后台直接 RPC。)

---

## 3. 取 CQU Service Ticket(按子系统最小权限)

拥有 `cqu:ticket:<service>` 的 token(或拓扑① 的 RPC)可代理取 CAS Service Ticket:

```
POST https://auth.cqu.moe/api/v1/cqu/service-tickets
Authorization: Bearer ACCESS_TOKEN
Content-Type: application/json
Body: { "service": "jwxt" }
→ { "data": { "ticket": "ST-12345-ABCDEF..." } }
```

可用 `service` key:`jwxt`(教务) · `jxpj`(教评) · `library`(图书馆) · `card`(校园卡) · `friends`(第二课堂)。

**安全模型**:你的 client **只会被 admin 授予它需要的服务**(日历→`jwxt`,教评→`jxpj`),取不到别的。校验是双层:token scope **且** 该 client 在 `oauth_client_cqu_scopes` 注册过。**能力(caps)不参与普通取票**——取票安全只看 client。

用返回的 ST 访问对应 CQU 系统(`<服务URL>?ticket=ST-...`)完成 CAS 认证。前置:用户必须已在 `auth.cqu.moe/settings` 绑定 CQU 且会话 `active`;未绑定/会话未激活 → 取票失败(`SESSION_INACTIVE`,HTTP **409**),引导用户去绑定页。

取票错误码 → HTTP 状态(策略/客户端错误回 4xx,可据此判定是否可重试):`SESSION_INACTIVE` **409** · `RATE_LIMITED` **429**(限频,可退避后重试) · `QUICKLOGIN_NOT_ENABLED` **403**(见 §5,广路径功能未开放或未开 opt-in) · `INVALID_SERVICE_URL`/`UNKNOWN_SERVICE`/缺参数 **400**。服务端/未知错误(TGT 过期、无票、网络等)仍回 **500**。

### 3.1 第二课堂（friends）

管理员在客户端的 CQU 服务权限中勾选「第二课堂 (friends)」，同时保存 OAuth scope
与客户端当前服务授权。消费者申请 `cqu:ticket:friends`，随后向上述端点提交
`{ "service": "friends" }`，成功返回 HTTP **201** 与 `{ "data": { "ticket": "…" } }`。
`service` 与 `serviceUrl` 不能同时提交。

固定 CAS service 为 **`https://friends.cqu.edu.cn/mobile/sso`**，不带尾斜杠。
二课使用 `POST /gateway/ek-agg-mob/cas/login?ticket=…` 核销一次性 ST 并换取自己的应用会话。
Auth 不替消费者核销票据。仅有 friends scope 不能为 `jwxt` 等其他服务或任意
`serviceUrl` 取票；符号服务不要求开启 QuickLogin，但学校绑定、会话状态、撤销、
限流、审计与出票后的最终校验仍然生效。

CLI 使用现有 native/public client、S256 PKCE 及 Better Auth 客户端/官方 OAuth 工具。
生产客户端注册、回调适配、DPoP 互操作和 CLI 实现属于消费者接入工作。

**验收边界**：本地测试使用合成票据和浏览器出站桩。Auth 到二课的真实取票与换会话
尚未实地验收；需在获授权的学校会话中为上述精确 service 取得未核销 ST，再由二课
换成会话，单独记录结果，禁止在日志、测试样例或 issue 中输出真实 ST、token 或 cookie。

---

## 4. 消费能力(Entitlements / caps)

用户权限 = **中心按用户授予的能力**,分**开关型(flag,布尔)** 与 **配额型(quota,数字)**。你只**读** caps、做功能门禁,**不关心它怎么来的**。

caps 形状(你只拿到自己这片,`<subsystem>` = 你注册 client 时的 `metadata.subsystem`):

```jsonc
{ "caps": { "calendar": { "sync": true, "sub_limit": 50, "share": false } } }
//                        ↑flag      ↑quota(数字,null=无限)  ↑flag
```

- 拓扑①:`verifySession` 返回里读 `sess.caps`(**实时**)。
- 拓扑②③:从 `payload.caps`(JWT claim)读;SPA 自身可用 auth 的 session 接口拿。

门禁示例:

```ts
if (!caps.calendar.sync) return deny("自动同步未开通")
const limit = caps.calendar.sub_limit ?? Infinity   // null → 无限
if (count > limit) return deny(`订阅上限 ${limit} 条`)
```

> 能力清单(有哪些 `subsystem.capability`、flag/quota)由 auth 仓库的 `src/capabilities.ts` 常量定义,**是唯一权威**;新增能力需在 auth 侧加并重部署。接入前对一下你子系统的能力 key。

---

## 5. 浏览器快捷登录插件(auth 侧契约)

插件检测到用户落 `sso.cqu.edu.cn/login?service=XXX` 时,用云端会话替他取 XXX 的 ST 并跳转完成登录(跳过输密码/2FA)。**浏览器只经手单服务、一次性、短时效 ST,绝不触碰 TGT。**

### 5.1 接入(拓扑③ PKCE 公开客户端)

- 注册为**公开客户端**(`requirePKCE=true`,无 client_secret);`redirect_uri` = `https://<EXT_ID>.chromiumapp.org/`。
- 授予 scope `cqu:ticket:any`(广域;语义="任意 `*.cqu.edu.cn` 白名单 host")或 `cqu:ticket:*`。
- 走 §2.1 PKCE 拿 token(可 `offline_access` 缓存,免每次重登)。

### 5.2 取票接口

```
POST https://auth.cqu.moe/api/v1/cqu/service-tickets
Authorization: Bearer EXT_ACCESS_TOKEN
Content-Type: application/json
Body: { "serviceUrl": "<完整CQU服务URL>" }
→ { "data": { "ticket": "ST-..." } }
```

拿到后把当前标签页导航到 `serviceUrl?ticket=ST-...`,由服务自身向 CAS 验票。

### 5.3 必须知道的约束

- **`serviceUrl` 由 auth 服务端严格校验**(https + 解析后 `*.cqu.edu.cn` host + 拒 userinfo/异常端口)。非法直接 400——别指望"它来自 SSO 页"就被信任。
- **功能开放闸 + 用户级 opt-in(两道独立 flag)**:`cqu.quicklogin_access`(admin 授予)是功能开放闸 —— 无此权益的用户设置页不显示快捷登录卡片、自助端点拒写(403)、DO 广路径取票同拒;被开放的用户还须本人开启 `cqu.quicklogin`(同意开关),否则即使 token 在也签不出 ST。同意开关由用户**自助**读写:`GET /api/v1/cqu/quicklogin` 与 `PUT /api/v1/cqu/quicklogin {enabled}`(仅认 auth 站登录 session,**绝不接受 Bearer/OAuth token** —— OAuth client 不能替用户翻这个开关);设置页已内置开关。superAdmin 也可经 admin entitlement 路由代写。
- **失败一律降级到原生登录页,绝不伪造流程**:
  - 服务未在 CQU CAS 注册 → 报"不支持此服务"。
  - 非 `?ticket=` 回调(POST-binding 等)→ 交回服务自身登录按钮。
  - SPA 深路由丢 ticket → 跳"CAS 本会跳的那个确切 URL"。
  - 瑞数 WAF 挑战页 → 退回正常登录页(插件无法headless解挑战)。
- 插件运行时视为**低信任**:token 短 TTL;最小 host 权限(`https://auth.cqu.moe/*`)。

### 5.4 QuickLogin 设备协议入口（当前待部署 build）

新扩展固定使用 `/api/v1/auth/oauth2/authorize`、`/api/v1/auth/oauth2/token`
和以下设备入口；OAuth `resource` 固定为稳定 issuer audience
`https://auth.cqu.moe/api/auth`。路径、client ID、extension ID、redirect URI、
scope 与 protocolVersion 都不能由远端内容改写。

| 操作 | 鉴权 / origin | 成功响应 |
| --- | --- | --- |
| `POST /api/v1/cqu/quicklogin/devices` | device Bearer + 固定 extension origin | 原生 `DeviceStatus` 200 |
| `GET /api/v1/cqu/quicklogin/devices` | Auth website Cookie | 原生 `DeviceListData` 200 |
| `PUT /api/v1/cqu/quicklogin/devices/{id}` | 本设备 Bearer + 固定 extension origin | 原生 `DeviceStatus` 200 |
| `DELETE /api/v1/cqu/quicklogin/devices/{id}` | Auth website Cookie + 同源 | 204 |
| `POST .../{id}/status` | 本设备 Bearer + 固定 extension origin | 原生 `DeviceStatus` 200 |
| `POST .../{id}/refresh` | 本设备 Bearer + 固定 extension origin | 原生 `DeviceStatus` 202 |
| `POST .../{id}/export` | 本设备 Bearer + 固定 extension origin | 原生 Cookie export envelope 200 |

设备错误保持 `{error:{code,message,retryAfterMs?}}`，不包 `{data}` 或 Problem。
网页 QuickLogin root 和 admin policy/quota 仍按 API v1 使用 `{data}` / Problem。
生成合同见 `docs/api/README.md`。

旧 authorize/token/device exact routes 与旧 reset callback 已全部退役；OAuth
只接受稳定 issuer audience `https://auth.cqu.moe/api/auth`。D01–D05 discovery
永久保留。新扩展源码已迁移；已有旧设备需重新安装新版扩展，不再提供协议兼容。

> 插件本体(MV3 manifest、`launchWebAuthFlow`、内容脚本检测、跳转)由插件项目自行实现,本指南只定 auth 侧契约。实现前用 Context7 核对 `chrome.identity` / `@better-auth/oauth-provider` PKCE 参数名(snake_case:`client_id`/`code_challenge`)。

---

## 6. 真·第三方应用

非自家应用走完整 OAuth(**会弹同意页**,不设 `skipConsent`)。流程同 §2.1;CQU scope 需 admin 额外授权且用户已绑定。补充端点:

```
GET  /api/v1/auth/oauth2/userinfo            (Bearer)            → { sub, name, email, email_verified }
POST /api/v1/auth/oauth2/token  grant_type=refresh_token …       → 刷新
POST /api/v1/auth/oauth2/introspect   (Basic client)  token=…    → RFC 7662 自省
POST /api/v1/auth/oauth2/revoke       (Basic client)  token=…    → RFC 7009 吊销
GET  /api/v1/auth/oauth2/end-session  ?id_token_hint=…&post_logout_redirect_uri=…  → 登出
```

---

## 7. 注册 client(所有子系统第一步)

联系 admin(后台 Admin 页),提供:应用名、`redirect_uri`、所需 scope、是否第一方。注册产出 `client_id`(+ confidential 的 `client_secret`,仅显示一次)。admin 会按需设:

- `metadata.subsystem`(**必填,第一方**):决定盖哪片 caps,如 `"calendar"`。
- `skipConsent=true`(第一方,静默授权)。
- `oauth_client_cqu_scopes`(最小权限):只勾你需要的 CQU 服务。
- `requirePKCE=true`(公开客户端如插件、SPA 必须)。

---

## 附录:参考

| Discovery | `GET /.well-known/oauth-authorization-server` · `GET /.well-known/openid-configuration` |
|---|---|
| JWKS | `GET /api/v1/auth/jwks` |
| Issuer | `https://auth.cqu.moe/api/auth` |
| 签名 | EdDSA (Ed25519) |
| Access Token | JWT,默认 1h,可 JWKS 离线验 |
| Refresh Token | 默认 30 天(需 `offline_access`) |
| Authorization Code | 10 分钟,PKCE 强制,不支持 Implicit |

**标准 scope**:`openid` · `profile` · `email` · `offline_access`
**CQU scope**:`cqu:ticket:jwxt` · `cqu:ticket:jxpj` · `cqu:ticket:library` · `cqu:ticket:card` · `cqu:ticket:friends` · `cqu:ticket:any`(广域,需 admin 授权 + 用户 opt-in)

## Better Auth 1.7 升级基线

Auth 的前后端 Better Auth / OAuth provider 固定为 1.7.7，Cloudflare 适配器为
0.3.1（peer 范围支持 Better Auth 1.5+）。会话、verification 和原生数据库限流均使用
D1；不再需要 KV binding，关闭 session cookie cache。CQU Durable Objects 保持原职责。

部署顺序为先备份 D1、应用手写 `0010_auth_17_d1.sql`，再发布匹配的前后端。
迁移保留账号、密码哈希、学校凭据、权益和 JWK 原文；从每把 JWK 派生算法元数据。
旧 `type` / `public` 列仅留作回滚资料，新版本使用 `applicationType` 与
`tokenEndpointAuthMethod`。公开浏览器客户端映射为 `web` + `none`，原 `native`
保持 `native`；上线前核对已有特殊回调客户端。后台服务未自动授予新的机器 scope。
旧 KV 中的短期验证码不会迁移，升级期间可能需要重新请求验证码、登录或连接。
不得删除生产 KV namespace 作为本次配置变更的一部分。

所有授权码调用必须提供 S256 challenge 和对应 verifier，机密客户端同样如此；管理台
不能关闭 PKCE。现有管理 API 的 `type` 字段仍兼容，后端映射到新模型。
issuer 仍为 `https://auth.cqu.moe/api/auth`，HTTP 端点仍位于 `/api/v1/auth`。

现阶段只有 issuer 对应的一个资源，显式保留已有客户端对该资源的可请求性
（`enforcePerClientResources: false`），仍受客户端 scope 和业务权限约束。
未来增加 API/MCP 资源前必须启用逐客户端资源关联并迁移已有客户端；不得直接在这个
兼容配置下增加新 audience。本次没有创建 API/MCP 业务端点，跨站 Cookie 收口待消费者迁移。

本地回归使用真实 workerd/D1：`npm run test:do`，其中
`auth-d1-baseline.test.ts` 覆盖并发限流、授权码单次消费、PKCE/回调/事务校验、
TOTP 登录与退出、OTP 过期和 verification 清理；`auth-upgrade-migration.test.ts`
从带数据的旧 schema 升级后验证登录、学校数据、权益和客户端保留。

## 私有 RPC 的方法授权与上线预检

`AuthService` 保留服务密钥 + 用户 ID；不签发后台逐用户 refresh token。每次调用都验
真实 secret 哈希、应用未禁用、用户存在且未封禁，并读取管理员配置的
`oauthClient.metadata.rpcMethods`。没有该配置的客户端不能调用后台 RPC。

| 方法 | 必须获批的 rpcMethods 项 | 业务边界 |
| --- | --- | --- |
| getCaps | getCaps | subsystem=calendar；只返回 calendar 权益，不要求学校绑定 |
| cquHarvest | cquHarvest | subsystem=calendar；用户 calendar.sync=true；有效学校绑定 |
| getCquTicket | getCquTicket | calendar 仅 jwxt + calendar.sync；eval 仅 jxpj + eval.submit；cqu 要 quicklogin_access；另验管理员授予的 CQU scope 与学校绑定 |

取票、采集仍走原 DO 的目标主机、限流、QuickLogin opt-in 和审计控制点。
历史只有 cqu_credentials 的绑定仍有效；缺失、revoked、deleting 或 pending 绑定不放行。
getCaps 仍可返回 false 权益，让后台停止相应业务。退出浏览器和更换密码不撤销服务身份。

**现有 Schedule 必须先配置再发布新 Auth；不能把缺配置当成可忽略告警。**
部署人员从当前 Schedule 配置中确认 CALENDAR_CLIENT_ID（不要输出或传递 client secret），
用已有管理员 API `GET /api/v1/admin/oauth-clients` 找到同一 client_id 并备份其 metadata。
以有 OAuth 客户端写权限的管理员执行
`PATCH /api/v1/admin/oauth-clients/{client_id}`，body 的 metadata 保留原有所有其他键，增加：

```json
{
  "metadata": {
    "subsystem": "calendar",
    "rpcMethods": ["getCaps", "cquHarvest"]
  }
}
```

若已确认这个客户端仍使用旧 getCquTicket(jwxt) 路径，再单独加入 getCquTicket，
并保留管理员配置的 cqu:ticket:jwxt scope。不要因为客户端名称含 calendar 就批量授权。
读回上述 GET 结果核对精确 client_id、subsystem、rpcMethods 和启用状态；保留当前密钥。
先改 metadata 与旧 Auth 兼容，再部署；若预检未完成则停止发布。回滚代码不必删除 metadata。
本任务没有修改生产 metadata 或发布流量。

Better Auth 1.7.7 的普通 create-client / update-client 不接受 metadata，DCR 当前关闭；
HTTP 回归测试证明普通所有者提交 rpcMethods 不会获得 RPC 权限，现有管理员 PATCH 可以授予。
未来开放 DCR/CIMD 或变更插件时必须保留此边界，不得允许客户端自行填写 RPC 批准信息。

审计日志 `auth.rpc.request` 只记 clientId、userId、方法与身份验证结果，不记服务密钥、
学校凭据或采集结果；实际学校操作继续由 DO 记录结果。

调用链核查（Schedule 当前源码）：订阅创建/手动刷新使用认证后的 `c.get('user').id`，
订阅查询同时约束 userId，后台队列使用该 ID 或数据库记录；未增加接受外部任意 userId 的公网
代理。Schedule 的旧权益/采集缓存仍需在 #49/#51 接入迁移时收紧至撤销目标，RPC 本身每次读权威状态。


### 后端权威查询限流

OAuth introspection 每个来源 IP（无法取得 IP 时为共享桶）采用 D1 原生限流，预算为每 60 秒 6,000 次。该预算服务于 Schedule/UC 每次受保护请求的权威查询；其他登录、令牌和 MFA 端点保留各自原有限额。它不是每用户配额，也不绕过客户端认证。超过预算或 Auth 不可用时仍失败关闭；上线后应按共享流量与 429 指标调整容量，不能靠延长旧授权结果的使用时间绕过撤销时限。
