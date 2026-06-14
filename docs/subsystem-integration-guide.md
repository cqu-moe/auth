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
> - `verifySession(cookieHeader: string | null) → null | { user, caps }`(caps 实时,全子系统)。
> - `getCquTicket({ clientId, clientSecret, service?, serviceUrl?, userId }) → { ticket } | { error }`。
>   取票全程经 auth 的 DO 万能闸:host 校验 + 用户 `cqu.quicklogin` opt-in(仅 serviceUrl 广域路径)+ 限流 + 审计。

### 1.3 离线 / 后台任务

Cron Worker 等用户不在场的场景:**直接 `env.AUTH.getCquTicket({...})`,全程无用户 cookie/token**(只需带本 client 的 `clientSecret`)。授权 = service binding 机器信任 + `clientSecret` 校验 + client-scope + 用户 CQU 会话 `active`。CQU 会话由 auth 的 Durable Object 常驻维护(无人值守续命),用户只需**绑定过一次**。

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
GET https://auth.cqu.moe/api/auth/oauth2/authorize
  ?client_id=YOUR_CLIENT_ID
  &redirect_uri=https://your-app.cqu.moe/callback   # 必须精确匹配注册值
  &response_type=code
  &scope=openid profile email offline_access cqu:ticket:jwxt
  &state=RANDOM &code_challenge=CHALLENGE &code_challenge_method=S256
```

回调拿 `code` 换 token:

```
POST https://auth.cqu.moe/api/auth/oauth2/token   (application/x-www-form-urlencoded)
grant_type=authorization_code &code=... &client_id=... &client_secret=...
&redirect_uri=... &code_verifier=ORIGINAL_VERIFIER
```

响应含 `access_token`(JWT)、`refresh_token`(若请求 `offline_access`)、`id_token`。

### 2.2 离线验 JWT + 读 caps

下游用 JWKS 离线验证,**不必每次回 auth**:

```ts
import { createRemoteJWKSet, jwtVerify } from "jose"
const JWKS = createRemoteJWKSet(new URL("https://auth.cqu.moe/api/auth/jwks"))
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
GET https://auth.cqu.moe/api/cqu/service-ticket?service=jwxt
Authorization: Bearer ACCESS_TOKEN
→ { "ticket": "ST-12345-ABCDEF...", "service": "jwxt" }
```

可用 `service` key:`jwxt`(教务) · `jxpj`(教评) · `library`(图书馆) · `card`(校园卡)。

**安全模型**:你的 client **只会被 admin 授予它需要的服务**(日历→`jwxt`,教评→`jxpj`),取不到别的。校验是双层:token scope **且** 该 client 在 `oauth_client_cqu_scopes` 注册过。**能力(caps)不参与普通取票**——取票安全只看 client。

用返回的 ST 访问对应 CQU 系统(`<服务URL>?ticket=ST-...`)完成 CAS 认证。前置:用户必须已在 `auth.cqu.moe/settings` 绑定 CQU 且会话 `active`;未绑定/会话未激活 → 取票失败(当前 `SESSION_INACTIVE`,HTTP **500**;计划改 **409**),引导用户去绑定页。

---

## 4. 消费能力(Entitlements / caps)

用户权限 = **中心按用户授予的能力**,分**开关型(flag,布尔)** 与 **配额型(quota,数字)**。你只**读** caps、做功能门禁,**不关心它怎么来的**。

caps 形状(你只拿到自己这片,`<subsystem>` = 你注册 client 时的 `metadata.subsystem`):

```jsonc
{ "caps": { "calendar": { "sync": true, "sync_limit": 200, "share": false } } }
//                        ↑flag      ↑quota(数字,null=无限)  ↑flag
```

- 拓扑①:`verifySession` 返回里读 `sess.caps`(**实时**)。
- 拓扑②③:从 `payload.caps`(JWT claim)读;SPA 自身可用 auth 的 session 接口拿。

门禁示例:

```ts
if (!caps.calendar.sync) return deny("自动同步未开通")
const limit = caps.calendar.sync_limit ?? Infinity   // null → 无限
if (count > limit) return deny(`同步上限 ${limit} 条`)
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
GET https://auth.cqu.moe/api/cqu/service-ticket?serviceUrl=<完整CQU服务URL>
Authorization: Bearer EXT_ACCESS_TOKEN
→ { "ticket": "ST-..." }
```

拿到后把当前标签页导航到 `serviceUrl?ticket=ST-...`,由服务自身向 CAS 验票。

### 5.3 必须知道的约束

- **`serviceUrl` 由 auth 服务端严格校验**(https + 解析后 `*.cqu.edu.cn` host + 拒 userinfo/异常端口)。非法直接 403——别指望"它来自 SSO 页"就被信任。
- **用户级 opt-in**:用户须在设置里开启 `cqu.quicklogin`,否则即使 token 在也签不出 ST。
- **失败一律降级到原生登录页,绝不伪造流程**:
  - 服务未在 CQU CAS 注册 → 报"不支持此服务"。
  - 非 `?ticket=` 回调(POST-binding 等)→ 交回服务自身登录按钮。
  - SPA 深路由丢 ticket → 跳"CAS 本会跳的那个确切 URL"。
  - 瑞数 WAF 挑战页 → 退回正常登录页(插件无法headless解挑战)。
- 插件运行时视为**低信任**:token 短 TTL;最小 host 权限(`https://auth.cqu.moe/*`)。

> 插件本体(MV3 manifest、`launchWebAuthFlow`、内容脚本检测、跳转)由插件项目自行实现,本指南只定 auth 侧契约。实现前用 Context7 核对 `chrome.identity` / `@better-auth/oauth-provider` PKCE 参数名(snake_case:`client_id`/`code_challenge`)。

---

## 6. 真·第三方应用

非自家应用走完整 OAuth(**会弹同意页**,不设 `skipConsent`)。流程同 §2.1;CQU scope 需 admin 额外授权且用户已绑定。补充端点:

```
GET  /api/auth/oauth2/userinfo            (Bearer)            → { sub, name, email, email_verified }
POST /api/auth/oauth2/token  grant_type=refresh_token …       → 刷新
POST /api/auth/oauth2/introspect   (Basic client)  token=…    → RFC 7662 自省
POST /api/auth/oauth2/revoke       (Basic client)  token=…    → RFC 7009 吊销
GET  /api/auth/oauth2/end-session  ?id_token_hint=…&post_logout_redirect_uri=…  → 登出
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
| JWKS | `GET /api/auth/jwks` |
| Issuer | `https://auth.cqu.moe/api/auth` |
| 签名 | EdDSA (Ed25519) |
| Access Token | JWT,默认 1h,可 JWKS 离线验 |
| Refresh Token | 默认 30 天(需 `offline_access`) |
| Authorization Code | 10 分钟,PKCE 强制,不支持 Implicit |

**标准 scope**:`openid` · `profile` · `email` · `offline_access`
**CQU scope**:`cqu:ticket:jwxt` · `cqu:ticket:jxpj` · `cqu:ticket:library` · `cqu:ticket:card` · `cqu:ticket:any`(广域,需 admin 授权 + 用户 opt-in)
