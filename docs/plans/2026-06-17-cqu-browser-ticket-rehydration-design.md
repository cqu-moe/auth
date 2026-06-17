# CQU 取票根因终结 + 临时浏览器水化取票改造 — 设计文档

> 2026-06-17 · 分支 `feat/cqu-login-cn-node-proxy` · 状态:设计已确认,待出实现计划(writing-plans)
> 本文以**实测**(节点 `ubuntu@1.14.106.150` + 本机)终结了取票根因,推翻 HANDOFF(06-17)与节点迁移设计(06-16)的定性,给出被实验逼出的修复架构。

## 1. 根因(实测终结)

取票从**任何服务器 IP** 都会触发 CQU 前置的**瑞数(Riverdata)动态 JS 挑战**;只有**带完整瑞数 JS 运行时状态的真浏览器**(跑过那段混淆 JS、持有它现算的 `CtLgrmkSWHBZP` 令牌)能换到 ST。生产用 `httpx` + 3 个 cookie 必然落回登录页 → 判 `SESSION_EXPIRED` → 无限重登。青果"住宅"IP 同样被挑战,帮不上。

### 1.1 推翻了什么

| 旧定性 | 现状(实测) |
|---|---|
| 瑞数封 CF 机房 IP,住宅代理治本(旧 HANDOFF) | ❌ 与代理/IP 错配无关;**青果住宅 IP 同 IP 取票也挂(N3)** |
| 瑞数 JS 令牌 ⇒ 必须每用户 24/7 常驻热浏览器(06-17 HANDOFF) | ⚠️ 一半对:需浏览器,但**完整 `storage_state` 可落盘、在全新浏览器水化**,无需常驻(R1/R2) |
| 青果消 captcha 是登录必需(06-16 迁移) | ❌ 青果取票帮不上;登录还抽风弹 captcha;**成都 IDC 直连登录反而干净** |

### 1.2 实测证据(2026-06-17,本机家用住宅 IPv4 + 节点成都 IDC `1.14.106.150`)

| 取票出口 \ 客户端 | 裸 httpx | curl_cffi 指纹伪装 | 临时浏览器·塞3cookie | 满状态/水化浏览器 |
|---|:--:|:--:|:--:|:--:|
| 家用住宅(本机) | ✅ | ✅ | — | ✅ |
| 成都 IDC 直连 | ❌ | ❌ | ❌(T2/E1/E2) | ✅(登录ST/C) · **完整state水化✅(R1/R2)** |
| 青果住宅 同IP(N3,login==ticket) | ❌ | ❌ | — | ✅(登录ST) |
| 青果住宅 异IP(N2,=生产态) | ❌ | — | — | — |

关键判别:
- **裸 httpx / curl_cffi(真 chrome TLS+H2+头,甚至先拿到服务端 `CtLgrmkSWHBZO`)从所有服务器 IP 全挂** → 拦截层是**瑞数 JS 活令牌**,不是指纹、不是 IP 错配。
- **只塞 3 个 auth cookie 的全新浏览器也挂(E1/E2)**;**水化完整 `storage_state`(实测 12 cookie + 2 个 origin 的 localStorage)的全新浏览器过(R1/R2)** → 取票能力的载体是**完整浏览器状态**,可搬运、可落盘。
- 青果登录抽风:`125.85.80.60` 弹 captcha、`183.227.188.15` 不弹 → 青果 IP 池质量参差。

## 2. 决策

把取票/保活从 **`httpx`** 改为 **"临时浏览器水化完整 `storage_state` → navigate 换 ST"**;**砍青果**,全部直连成都 IDC。**不需要常驻热浏览器**(完整 state 落盘 + 按需起临时浏览器,脉冲式内存)。

## 3. 架构

```
用户进教务 → CquSessionDO(CF,每用户一个)
   ① 取票四道闸照旧(host校验/quicklogin opt-in/限流/审计)—— 不动
   ② 从 D1 取出该用户加密存的【完整 storage_state】
   ▼  env.LOGIN_NODE.fetch(Workers VPC 私有通道,不动)
成都节点 server.py
   /service-ticket: Semaphore(3) → 临时 chromium → new_context(storage_state)
                    → navigate /login?service=… → 嗅 ST → 关浏览器(proxy=None 直连)
   ▼
CQU sso(瑞数被真浏览器现场算过 → 放行)
```

改动落点仅 4 处,其余全不动。

## 4. 组件设计

### 4.1 节点 `/run`(登录)
- `proxy=None` 直连(砍青果登录包)。
- `run_login` 返回**完整 `storage_state`**(`await ctx.storage_state()`:`{cookies:[…], origins:[…]}`)而非 `extract_cookies` 的 3 个;登录 ST 仍返回作首票。

### 4.2 节点 `/service-ticket`(取票)
- 入参 `{serviceUrl, state}`(完整 storage_state)。
- 实现:`async with SEM`(`Semaphore(3)`)→ 起临时 chromium(`--no-sandbox --disable-dev-shm-usage`)→ `new_context(storage_state=state, user_agent=UA, …)` → 装 ticket sniffer → `page.goto(/login?service=<quote(serviceUrl)>, domcontentloaded)` → 等 → `extract_ticket` → `finally: browser.close()`。`proxy=None`。
- 映射:拿到 ST → 200 `{ticket}`;**落回 CAS 登录页(`login-page-flowkey`/`login-croypto`)→ 409**(真过期,交 DO 重登;浏览器已会自愈瑞数,故落登录页基本=TGT 真过期);无 ST 非登录页 / 浏览器崩 → 502(瞬态,DO 退避)。

### 4.3 节点 `/keepalive`(保活)
- 入参 `{state}`。临时浏览器 navigate 探活(已登录页),**导出刷新后的 `ctx.storage_state()` 回吐**。
- 返回 `{status: active|expired|unreachable, state: <refreshed>}`;`proxy=None`。三态语义沿用("探不通"=unreachable 不误判过期)。

### 4.4 DO + D1
- 存储:`cquCredentials` 里"加密 3 cookie"升级为"**加密完整 `storage_state` JSON**"(仍 KB,AES-GCM 不变)。
- DO 调 `/service-ticket` 传解密后的 state;调 `/keepalive` 传 state,拿回 refreshed state **写回 D1**(C)。`/run` 回来存完整 state。
- **取票四道闸完全不动**(调 binding 前过完)。

## 5. 状态生命周期(C)
- 登录 → 存完整 state。keepalive 每 60min navigate 刷新 → 回写 → **state 永远 ≤60min 旧**。
- 取票时浏览器遇瑞数 cookie 过期会**当场重算自愈**(R2 已证),只要 TGT 没过期。
- TGT/SESSION 真过期 → 取票落登录页(409)/ keepalive expired → DO 触发重登(本就该如此)。
- **风险接受**:state 扛过 60min 间隔未做延时实测;用户据本地体感判定 OK,**上线看日志、持续失败再切回**(见 §9)。

## 6. 内存 / 并发(B + D)
- 实测 4G 节点(总 3.6G,空闲 ~3G available):并发 1/3/5 个临时 chromium(各加载真实瑞数+Angular 登录页),MemAvailable 净跌 ~233/340/500MB,真实人均 ~300-500MB。
- **取票并发上限 `Semaphore(3)`**:留 ~1.5G 给 OS + 一个可能同时在跑的登录浏览器(~500MB/~11min);需要再压可上 4。
- `try/finally` 必关浏览器防泄漏;上线观测 RSS/僵尸。

## 7. 错误处理
- 取票:落登录页→409 / 无票非登录页·崩→502 / 超并发→排队(不拒)。
- keepalive:探不通→unreachable(退避) / 落登录页→expired(重登) / 活→active+回写 state。
- 全程不记录 ticket/cookies/state 明文(沿用现有审计纪律)。

## 8. 砍青果(A,先开关后删)
1. **先开关**:节点 env `QG_ENABLED=0`(`should_use_proxy` 即返回 False → 全 `proxy=None`)。**零代码改动**即可先在节点验证"直连浏览器取票"通不通。
2. **后删**(稳定后):删 `qg_proxy` 调用、两套青果 key(1Password Environment)、相关测试。回滚窗口内保留。

## 9. 上线 / 回滚
- 分阶段:① 节点 `/service-ticket`+`/keepalive` 改临时浏览器 + `QG_ENABLED=0`,DO/D1 改存完整 state、`/run` 返回完整 state;② 灰度观测取票成功率 / 内存 / cloudflared 稳定性;③ 稳定后删青果代码。
- **回滚**:迁移期保留 httpx 取票/keepalive 路径(开关切回);state 存储向后兼容(读不到完整 state 时可触发重登重建)。

## 10. 风险
1. **状态保鲜**(主):state 扛 60min 未实测,用户体感判 OK + 日志兜底(§5/§9)。
2. 临时 chromium 反复起关的长跑稳定性(僵尸/泄漏)→ 上线观测。
3. 取票冷启动 ~1-3s 延迟(可接受;必要时后续加暖浏览器池)。
4. 节点单点 / cloudflared 稳定性(沿用既有风险)。

## 11. 被否决的方案(决策记录)
| 方案 | 否决原因(实测) |
|---|---|
| 继续 httpx / 换 curl_cffi 伪装指纹 | 服务器 IP 上全被瑞数 JS 挑战挡死(本机住宅能过纯属 IP 宽容,服务器无住宅 IP) |
| 住宅代理(青果)让 httpx 取票 | 青果住宅 IP 同样被挑战(N3 同 IP 也挂);且登录抽风弹 captcha |
| 只存 3 cookie 注入临时浏览器 | E1/E2/T2 实测挂(载体是完整 state,非 3 cookie) |
| 每用户 24/7 常驻热浏览器 | 完整 state 可落盘水化(R1/R2)→ 临时浏览器即可,省内存 |
| 登录时预铸常用票 | ST 短效,缓存无意义 |

## 12. 测试
- 节点纯函数单测(pytest):storage_state 入参解析、ST 提取、错误三态分类。
- 浏览器取票 e2e:今天 R1/R2/C 已实测过,固化成一个节点冒烟脚本(免青果直连)。
- 上线灰度:`QG_ENABLED=0` 先验直连浏览器取票成功率,再接管。
