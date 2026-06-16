# CQU 登录经「国内节点 + 青果住宅代理」改造 — 设计文档

> 2026-06-16 · 分支 `feat/cqu-login-cn-node-proxy` · 状态:设计已确认,待出实现计划(writing-plans)

## 1. 背景与问题(纠正旧定性)

`auth.cqu.moe` 的 CQU 会话登录/取票从 2026-06 起约 30% 间歇失败(仅一个绑定测试账号,观感近乎全断)。

HANDOFF 旧定性是「瑞数 WAF 封锁 Cloudflare 机房出口 IP」。**本轮观测 + 实测推翻了这个定性**:

- Observability 抓到 5/5 容器登录失败页指纹完全一致:`fp title='统一身份认证平台' caslogin=1 botgate=0 debuggerkw=0 ctlgr=0 captcha=1 forbidden=0`。
- 即:页面**正常完整加载**(title 正常、23-27KB、瑞数硬拦截标记全 0),失败的真因是 **`captcha=1`** —— CAS 登录页对该来源 IP **弹出图形验证码**,而 patchright 登录器不会填验证码 → 第一因素 `fail:未判定`。
- 本质是 **IP 信誉风控的「软」表现**:CQU 不直接拒绝可疑 IP,而是给它加验证码。判定维度实测更接近 **「境内 vs 境外」**,而非单纯「机房 vs 住宅」。

**结论**:让对 CQU 的出站走「干净的中国大陆住宅/移动 IP」,即可消除 captcha。

## 2. 验证证据(全部实测)

| 验证 | 方法 | 结果 |
|---|---|---|
| 青果重庆移动 IP 干净 | ip-api 交叉验证 | `China Mobile / 重庆 / AS9808 / mobile:true / proxy:false / hosting:false` ✅ |
| 该 IP 过 CQU 风控 | curl 登录页 | HTTP 200、无瑞数 412 ✅ |
| **captcha 消除** | patchright 走青果跑第一因素(L1 spike) | `VERDICT: 2fa`(第一因素通过,到 2FA 页)✅ **决定性** |
| 境外直连青果 | 美/港/日服务器 + 账密 | `client ip not allowed` ❌ 三地全拒 |
| 国内连青果 | 成都 VPS + 账密 | 成功,出口重庆移动,CQU 200 ✅ |
| 国内 IDC 直连 CQU | 成都 VPS curl | HTTP 200(瑞数放行国内 IDC) |
| 青果境外禁止(官方) | 青果文档 | [公告](https://www.qg.net/doc/1554.html)「国内代理仅限中国大陆地区使用」;[错误码文档](https://www.qg.net/doc/use/8_245/2068.html)`client ip unavailable` 即此策略;白名单/账密均无法绕过(地理封锁前置) |

**两条硬约束由此固化**:
1. 青果(及同类国产住宅代理)**只认中国大陆来源**,境外无解 → 必须有国内节点连青果。
2. 对 CQU 的出站必须经青果**动态**住宅 IP —— 固定 IP(无论 IDC 还是住宅)扛多账号必被风控搞黑(「一个 IP 多学号」)。青果每次登录换 IP 天然打散此风险。

## 3. 目标与约束

**目标**:CQU 登录 + keepalive + 取票的出站,一律经青果动态重庆移动 IP,消除 captcha;scale-ready(多账号不被搞黑);CF ↔ 国内节点不走裸公网。

**铁律**:**任何碰 CQU 的出站,一律经青果;国内节点对 CQU 完全隐身(从不直连 CQU)。**

**约束**:
- 国内节点必需(青果只认国内来源)。
- 青果短效一次登录用一个 IP(动态,15-30 分钟存活)。
- 代理是硬依赖:拿不到 IP 判失败走退避,不自动直连兜底。
- 灰度 = 全局开关(退化为青果应急开关,见 §7)。

## 4. 架构(方案 B + Workers VPC)

```
┌─ CF (Cloudflare) ───────────────────────┐
│  CquSessionDO(协调/状态机/熔断/取票闸)  │
│     │ env.LOGIN_NODE.fetch(/run 等)      │ ← Workers VPC Service binding(私有)
│     ▼                                    │
│  [cloudflared Tunnel]                    │
└─────────┼────────────────────────────────┘
          ▼  私有加密通道(不走裸公网)
┌─ 国内登录节点(新购 VPS)────────────────┐
│  server.py(aiohttp) + cqu_login.py(patchright)
│   · acquire_qg_proxy() 本地提取青果 IP   │
│   · patchright proxy = 青果(账密)       │
│        └──▶ 青果网关 ▶ 重庆移动动态出口 ──┼──▶ CQU sso
└──────────────────────────────────────────┘
2FA 邮件: CQU → CF Email Routing → DO --(VPC)--> /code → 国内节点(唤醒在途 /run)
```

**相对原方案(CF 容器挂代理)砍掉两块复杂度**:① CF Containers 整个去掉;② 不需要「跨网络管理青果动态上游」的中转服务 —— 提取和使用都在国内节点本地。

## 5. 组件设计

### 5.1 国内登录节点

两个 systemd 常驻服务:
- `cqu-login`:现有 `container/server.py` + `container/cqu_login.py` **几乎原样搬过来**(它们本就是 Linux 容器代码)。
- `cloudflared`:Tunnel 连出 CF,私有暴露 `:8080`(无公网入站端口)。

相对现有容器代码的改动**只三处**:

| 改动 | 说明 |
|---|---|
| `cqu_login.py` 的 `chromium.launch()` 加 `proxy=` | 唯一核心代码改动;L1 spike 已验证可跑通 |
| 新增 `acquire_qg_proxy()` | 调 `share.proxy.qg.net/get?key=…&num=1&area=500100&isp=0&format=json&distinct=true`,解析 `data[0].server` 组成 `{server:"http://IP:PORT", username, password}` |
| `server.py` 各端点登录/连 CQU 前先 `acquire_qg_proxy()` | 提取失败/超时 → 端点返回 5xx(DO 走退避);受 `QG_ENABLED` 控制 |

暴露端点:`/run`(登录)、`/service-ticket`(取票)、`/keepalive`(探测)、`/code`(投码,纯内部唤醒)、`/ping`(健康)。前三个均「经青果连 CQU」。

### 5.2 CF 侧接线(cqu-session.ts / wrangler)

DO 三条「连 CQU」出站全部改经 VPC binding 调国内节点:

| DO 动作 | 改前 | 改后 |
|---|---|---|
| 容器登录 | `env.CQU_LOGIN.fetch("https://c/run")` | `env.LOGIN_NODE.fetch(".../run")` |
| 取票(闸内最后一跳) | `ssoClient.getServiceTicket`(ssoFetch→CQU) | `env.LOGIN_NODE.fetch(".../service-ticket")` |
| keepalive 探测 | DO `ssoFetch` 探 CQU | `env.LOGIN_NODE.fetch(".../keepalive")` |
| 2FA 投码 | `env.CQU_LOGIN.fetch("/code")` | `env.LOGIN_NODE.fetch(".../code")` |

- `wrangler.jsonc`:加 `vpc_services`(binding `LOGIN_NODE`);删 `containers`;删 `placement`(容器已无,DO 出站经青果与就近无关)。
- **删除** `CquLoginContainer` 类 + 容器 `Dockerfile`(迁移期先保留作回滚,见 §8）。
- **完全不动**:状态机、熔断/退避(relogin-policy)、single-flight 锁、取票闸四道校验策略、caps 下发、2FA 邮件接收链路。

**取票安全性不退步**:取票闸(host 校验 / quicklogin opt-in / 限流 / 审计)仍在 DO,调 binding 之前先过完;国内节点 `/service-ticket` 只是「拿 DO 给的、已校验的 serviceUrl + cookies,经青果换张 ST」。闸与出站彻底分离。

## 6. 铁律:所有 CQU 出站经青果

包含一个容易忽略的点 —— **取 service ticket 也是「连 CQU」,因此也经青果**;keepalive 探测同理(用户明确要求)。国内节点对 CQU 只暴露青果动态出口,自身 IP 永不出现在 CQU 视角。

## 7. 开关 / 失败回退 / 配置 / 安全

- **全局开关 `QG_ENABLED`(国内节点)**:正常 `on`=经青果;青果整体故障/被封时手动 `off` 让国内节点**临时直连 CQU 救急**(接受 IDC 搞黑风险,非常态)。「全部经青果」架构下,全局灰度退化为此应急开关即足够。
- **失败回退(硬依赖)**:`QG_ENABLED=on` 时青果提取失败 → 端点 5xx → DO 退避,绝不自动直连。
- **配置/secret**:
  - CF:`wrangler` 的 `vpc_services` binding;现有 secret 不变。
  - 国内节点:`QG_EXTRACT_URL`(含 key + `area=500100`)、`QG_AUTH_KEY/PWD`、`QG_ENABLED`、cloudflared Tunnel 凭据。
- **安全性质(不退步)**:CQU 账号密码仍只加密存 CF D1,DO 解密后经 Workers VPC 私有通道传 `/run`,**国内节点用完即弃、绝不落地**。

## 8. 测试 / 上线 / 回滚

- **测试**:纯函数(vitest)覆盖 `acquire_qg_proxy` 的 URL 构造/返回解析 + 失败分类;patchright+青果 e2e 已由 L1 spike 验证;上线后唯一账号真登录看 observability `captcha=0` + 拿 TGT。
- **上线**:① 新 VPS 装环境 + 部署 `cqu-login`(systemd)+ cloudflared 建 Tunnel;② CF 建 VPC Service + wrangler binding + 改 DO + 部署;③ 唯一账号验证 + 观测 keepalive/取票成功率、cloudflared 稳定性几天。
- **回滚**:B 是大改,**迁移期先不删 `CquLoginContainer`/容器代码**,分支跑通 + 灰度观测稳定后再清理;不稳可快速切回容器方案。

## 9. 风险

1. **Workers VPC 仍 beta**(2025-11 发布):API 可能变;beta 期免费可用。
2. **国内 cloudflared → CF 边缘稳定性**:腾讯云/新 VPS 连 CF 可能波动(cloudflared 自动重连,需观测)。
3. **单机 patchright 并发**:大量账号同时登录受单 VPS 内存限制(每 headless chromium ~300-500MB)。当前 1 账号无虞。
4. **青果依赖**:套餐提取额度(登录 + keepalive 均提取)需匹配用量;keepalive 经青果会抬高提取次数,留意成本。

## 10. 被否决的方案(决策记录)

| 方案 | 否决原因 |
|---|---|
| CF 容器直挂青果 | 青果只认国内来源,境外 CF 容器 `client ip not allowed`(三地实测) |
| 改容器 region 到 APAC | 日本(APAC)同样被青果拒;是境内/境外问题,非远近 |
| 青果开通境外/国际线路(A 方向) | 官方明令禁止,无开通途径,白名单无效 |
| 国内 IDC 直连 CQU(省青果) | 固定 IDC IP 扛多账号必被 CQU 搞黑(用户指出,采纳) |
| CF 容器 + 国内节点纯中转(方案 A) | 单点 A/B 都有,A 仅多并发弹性优势;当前用不上,却要写动态上游中转服务,复杂度不值 |
| 国内节点开公网端口 + 强鉴权(B2) | 走裸公网(用户想避免);Workers VPC 更优,B2 仅作 beta 不稳时的 fallback |

## 11. 待办 / 未决

- 新购 VPS 的访问信息(IP/SSH)待用户提供;设计层用占位「国内登录节点」。
- Workers VPC beta 在「DO 内调用 binding」的可用性需部署验证。
- cloudflared 国内稳定性需上线后观测几天。
- 青果账密(本对话中出现的)上线前建议轮换,经 secret 注入。
