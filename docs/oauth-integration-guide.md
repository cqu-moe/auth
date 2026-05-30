# OAuth 2.1 接入指南

auth.cqu.moe 提供标准 OAuth 2.1 + OIDC 兼容的授权服务。外部应用通过本服务实现用户登录，并可代表用户访问 CQU 校内系统。

## Discovery

```
GET https://auth.cqu.moe/.well-known/oauth-authorization-server
GET https://auth.cqu.moe/.well-known/openid-configuration
```

JWKS (JWT 公钥验证):
```
GET https://auth.cqu.moe/api/auth/jwks
```

## 1. 注册 OAuth 客户端

联系管理员注册应用，提供:
- 应用名称
- 回调地址 (`redirect_uri`)
- 需要的 scope 列表

注册后获得 `client_id` 和 `client_secret`。

## 2. 可用 Scope

| Scope | 说明 |
|-------|------|
| `openid` | 身份验证 (必选，启用 OIDC) |
| `profile` | 用户名、头像等基本信息 |
| `email` | 邮箱地址 |
| `offline_access` | 获取 refresh_token |
| `cqu:ticket:jwxt` | 代理访问 CQU 教务系统 |
| `cqu:ticket:jxpj` | 代理访问 CQU 教学评价 |
| `cqu:ticket:library` | 代理访问 CQU 图书馆 |
| `cqu:ticket:card` | 代理访问 CQU 校园卡 |

`cqu:ticket:*` scope 需要管理员额外授权给你的客户端，且用户必须已绑定 CQU 账号。

## 3. 授权流程 (Authorization Code + PKCE)

### 3.1 生成 PKCE Challenge

```javascript
async function generatePKCE() {
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { verifier, challenge };
}
```

### 3.2 跳转授权

```
GET https://auth.cqu.moe/api/auth/oauth2/authorize
  ?client_id=YOUR_CLIENT_ID
  &redirect_uri=https://your-app.com/callback
  &response_type=code
  &scope=openid profile email
  &state=RANDOM_STATE
  &code_challenge=CHALLENGE
  &code_challenge_method=S256
```

用户会看到授权同意页，同意后重定向回你的 `redirect_uri`:

```
https://your-app.com/callback?code=AUTH_CODE&state=RANDOM_STATE&iss=https://auth.cqu.moe/api/auth
```

### 3.3 用 code 换 token

```bash
POST https://auth.cqu.moe/api/auth/oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=AUTH_CODE
&client_id=YOUR_CLIENT_ID
&client_secret=YOUR_CLIENT_SECRET
&redirect_uri=https://your-app.com/callback
&code_verifier=ORIGINAL_VERIFIER
```

响应:
```json
{
  "access_token": "eyJ...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "ref_...",
  "id_token": "eyJ...",
  "scope": "openid profile email"
}
```

### 3.4 获取用户信息

```bash
GET https://auth.cqu.moe/api/auth/oauth2/userinfo
Authorization: Bearer ACCESS_TOKEN
```

响应:
```json
{
  "sub": "user_id",
  "name": "张三",
  "email": "user@example.com",
  "email_verified": true
}
```

## 4. 刷新 Token

```bash
POST https://auth.cqu.moe/api/auth/oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
&refresh_token=ref_...
&client_id=YOUR_CLIENT_ID
&client_secret=YOUR_CLIENT_SECRET
```

## 5. 获取 CQU Service Ticket

拥有 `cqu:ticket:<service>` scope 的 access_token 可以代理获取 CAS Service Ticket:

```bash
GET https://auth.cqu.moe/api/cqu/service-ticket?service=jwxt
Authorization: Bearer ACCESS_TOKEN
```

响应:
```json
{
  "ticket": "ST-12345-ABCDEF...",
  "service": "jwxt"
}
```

用返回的 ticket 访问对应的 CQU 系统完成 CAS 认证。

## 6. Token 自省与吊销

```bash
# 自省 (RFC 7662)
POST https://auth.cqu.moe/api/auth/oauth2/introspect
Authorization: Basic base64(client_id:client_secret)
Content-Type: application/x-www-form-urlencoded

token=ACCESS_TOKEN

# 吊销 (RFC 7009)
POST https://auth.cqu.moe/api/auth/oauth2/revoke
Authorization: Basic base64(client_id:client_secret)
Content-Type: application/x-www-form-urlencoded

token=REFRESH_TOKEN
```

## 7. 登出

```
GET https://auth.cqu.moe/api/auth/oauth2/end-session
  ?id_token_hint=ID_TOKEN
  &post_logout_redirect_uri=https://your-app.com
```

## 技术细节

- **协议**: OAuth 2.1 + OIDC (PKCE 强制，不支持 Implicit Grant)
- **签名算法**: EdDSA (Ed25519)
- **Access Token 有效期**: 1 小时
- **Refresh Token 有效期**: 30 天
- **Authorization Code 有效期**: 10 分钟
- **Token 格式**: JWT (可用 JWKS 端点本地验证)
- **Issuer**: `https://auth.cqu.moe/api/auth`
