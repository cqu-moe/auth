# CQU 增强登录（2FA 邮件取码）无人值守会话重绑 — 设计文档

> 日期：2026-06-12
> 状态：已定稿（待实施）
> 作者：与 Claude 协作头脑风暴产出
> 关联仓库：`auth`（auth.cqu.moe）+ `cqu-api-endpoint-collection`（逆向 API 来源）

---

## 1. 背景与问题

### 1.1 学校认证体系大改（2026-06-10）
重庆大学统一身份认证启用「**增强登录**」，登录页换为 Angular `cas-login-new`：

- **纯密码登录已废除**：密码仅为**第一因素**，必须叠加**第二因素**（短信验证码 / 密保邮箱验证码），或改用微信扫码。
- `sso.cqu.edu.cn` 部署 **瑞数 Botgate WAF（6 代）**：动态加密参数 `CAqWHAeT`、动态 cookie `CtLgrmkSWHBZ*`、反调试 `debugger`、30+ 自动化指纹检测。

### 1.2 现有 `auth` 服务为何失效
`src/services/cqu-sso.ts` 的 `login()` 是**旧的纯 fetch 密码登录**（POST 后等 302 拿 ticket）。在新体系下：
- 第一因素通过后返回的是**二次验证页**（`login-rule-type=second`），不是 ticket → `login()` 必抛 `LOGIN_FAILED`。
- 纯 fetch POST `/login` 会被瑞数判 400/412。
- `src/durable-objects/cqu-session.ts` 的 `relogin()`（纯密码自动重登）因此**彻底失效**。

### 1.3 瑞数下「什么能做、什么做不了」（仓库 2026-06-11 实测真相表）

| 步骤 | 纯请求（Workers `fetch`） | 真浏览器（patchright） |
|------|--------------------------|------------------------|
| 铸瑞数 P（VM 现算） | — | ✅ |
| 第一因素提交（带 pristine P） | ✅ 到 2FA | ✅（表单导航式） |
| 第一因素（浏览器 Angular-XHR 提交） | — | ❌ 400 |
| **发验证码** sendMailCode/sendSmsCode | ❌ **412**（/api/ 与 /linkid/ 镜像、加密头全试过） | ✅（页面原生点击，瑞数 VM 自带 `CAqWHAeT`） |
| 提交验证码（form-nav） | ✅（理论） | ✅ |
| **取 ST**（凭 `SOURCEID_TGC` 换 ticket） | ✅ **瑞数豁免** | ✅ |

**两条硬约束**：
1. **「发验证码」这步纯 Workers 永远做不到**，必须真 stealth 浏览器（patchright）在页面内原生点击。
2. **取 ST 凭 TGT 换 ticket 对瑞数豁免**，纯 fetch 可做（毫秒级、跨 IP）。但 **TGT 有 ~8h 绝对寿命**，到点必须用浏览器重走一次完整 2FA 登录。

### 1.4 目标
让用户的 CQU 会话**无人值守地持续可用**，使其它项目（如实时课表查询）能随时凭会话取 ST 调子系统 API。核心机制：用 **Cloudflare Email Routing 自动捕获密保邮箱 2FA 验证码**，把"每 ~8h 重登需用户实时手输验证码"自动化为"系统自动取码完成 2FA"。

---

## 2. 关键决策（已与用户确认）

| 决策点 | 选择 | 含义 |
|--------|------|------|
| 自动化程度 | **全自动无人值守** | 加密存 CQU 密码；系统每 ~7h 自动用浏览器重登 + 邮件自动取码；用户零操作 |
| 邮件导入 | **密保邮箱直设专属地址**（主）/ 用户转发（辅） | 用户把 CQU 密保邮箱改为我们的专属地址；自己以后用短信/微信登录 |
| 出站邮件 | **零出站** | Email Worker 纯入站消费，永不 forward/reply |
| 浏览器宿主 | **CF Containers + patchright** | 纯 CF，无外部主机 |
| 取码下发 | **推送（WS / HTTP push），不轮询** | 绑定码→浏览器 WS；2FA 码→DO 推容器 |

**「发码必须浏览器」躲不掉**：Email Routing 只自动化了**接收**验证码，没有消除**触发发码**的浏览器需求。浏览器仅在每 ~7h 的重登窗口短暂点火，热路径（保活 / 给子系统取 ST）全是 Worker/DO 纯 fetch。

---

## 3. 架构总览

### 3.1 组件（全部在 Cloudflare，扩展现有 auth.cqu.moe）

| 组件 | 角色 | 新/改 |
|------|------|-------|
| `CquSessionDO`（每用户） | 存活会话 cookies、纯 fetch 取 ST 保活、暂存验证码、调度重登、状态机、向浏览器 WS 推绑定码 | **改** |
| `CquLoginContainer`（Container-backed DO） | patchright 跑完整 2FA 登录：铸 P → 第一因素 → 发码 → 等码（被推入）→ 提交 → 导出 TGT | **新** |
| Worker `email()` handler | CF Email Routing 入站消费：地址→用户、SPF+IP 发件人校验、提码 → 投递 DO | **新** |
| Worker 绑定页 + WS endpoint | 用户 onboarding；浏览器 WS 接收绑定确认码 | **新** |
| D1 `cqu_bind_addresses` | 专属地址 token ↔ userId 映射 + 发件人白名单（控制平面） | **新** |
| `cquCredentials`（现有） | 加密密码（无人值守必需） | 复用 |

### 3.2 无人值守重登闭环（每 ~7h，赶在 ~8h 硬顶前）

```
[CquSessionDO.alarm @ login+7h]  ── 主动重登（旧 TGT 还有 ~1h 寿命，重登窗口零停机）──┐
  1. 置 loginInFlight 锁（状态→ 正在重登中）；解密密码
  2. DO 触发 CquLoginContainer.fetch('/run', {studentId, password, service, method:'mail'})
        Container (patchright)：
          GET /login（铸瑞数 P，渲染真实登录页）
          → 填用户名+密码 → 表单导航式 POST 第一因素 → 到 2FA 邮件 tab
          → 原生点「获取验证码」（发码，浏览器内，瑞数 VM 自带 CAqWHAeT）──CQU 发码邮件──┐
          → run() 在此 await asyncio.Event（等码被推入，不轮询）◀──── DO 推 ────┐      │
                                                                              │      ▼
[CQU 2FA 邮件] → {token}@bind.cqu.moe → CF Email Routing → Worker.email()      │  (邮件到达)
   · 目标地址 → 查 D1 → userId                                                 │
   · SPF=pass + envelope=sso@cqu.edu.cn + 源 IP∈202.202.0.0/24 否则丢弃        │
   · 主题分流 + 正则提 6 位码 → DO.depositCode(userId, {code, kind})           │
        → kind=login_2fa：DO 推 container.fetch('/code', {code}) ─────────────┘
          → Container set Event → 填码 → 表单导航式提交（type=mailLogin）
          → 302 + SOURCEID_TGC (+SESSION, rg_objectid)
        Container 返回 cookies → DO
  3. DO 存新 cookies、重置 loginAt、清 loginInFlight（状态→ 正常）、设下次 alarm @ +7h
  4. DO 恢复 15min 纯 fetch 取 ST 保活（瑞数豁免）

[子系统取 ticket]  CquSessionDO.getServiceTicket → 用 cookies 纯 fetch 换 ST（不经 Container、不碰瑞数）
```

**冷热分离**：重组件（Container 浏览器登录）只在每 ~7h 短暂点火 1–2 分钟；热路径（保活、发 ST、实时课表查询）全是 Worker/DO 纯 fetch，毫秒级、零浏览器成本。"刷新频率"与"容器成本"两条独立的线——课表查得再勤，账单只由那 ~7h 一次的容器决定。

---

## 4. Email 取码管道

### 4.1 真实邮件样本（2026-06，已抓）

**登录 2FA 邮件**：
- 发件人 envelope + From：`sso@cqu.edu.cn`
- 主题：`邮件验证码登录`
- 正文（HTML）：`您正在进行统一身份认证，请在页面中输入下方验证码完成验证` + 居中 `<p style="text-align:center">740004</p>` + `请在 600 秒内完成验证`
- **有效期 600s（10 分钟）**

**密保邮箱绑定确认邮件**：
- 发件人：`sso@cqu.edu.cn`
- 主题：`密保邮箱绑定验证码`
- 正文：`尊敬的 〈姓名〉(〈学号〉)，您的验证码为：943754，有效期 2 分钟。`
- **有效期 120s（2 分钟，更短）**，正文含 PII（姓名+学号）

### 4.2 ⚠️ 发件人校验：靠 SPF，不靠 DMARC

**实测样本认证头**：`dkim=none`、`dmarc=none (p=none,d=none)`、`spf=pass smtp.mailfrom=sso@cqu.edu.cn`（源 IP `202.202.0.26`/`.36`，即 `smtp/pop3.cqu.edu.cn`，均在 `202.202.0.0/24`）。

→ **cqu.edu.cn 未部署 DMARC、不做 DKIM 签名**，DMARC 这道闸形同虚设，伪造 `From: sso@cqu.edu.cn` 不会被 DMARC 拒。**唯一有效信号是 SPF**（pass 前提是来自 CQU 机房 IP）。

**Worker 发件人校验规则**（多重）：
1. 收件地址（RCPT 本地部分 token）能在 D1 查到 → userId；
2. envelope-from（`message.from`）== `sso@cqu.edu.cn`；
3. **SPF=pass**（读 CF 注入的 Authentication-Results）；
4. 可选叠加：Received 源 IP ∈ `202.202.0.0/24`；
5. 转发模式（kind=forward）额外接受用户登记的转发地址（信任较弱，优先直设）。
> 专属地址 token 随机不可枚举，攻击者须同时**猜中地址** + **从 CQU 机房 IP 发信**才能注入假码——攻击面极小。

### 4.3 提码正则（按主题分流，避开 PII 数字）
- 登录：主题含 `邮件验证码登录` → `(?<!\d)(\d{6})(?!\d)`（正文 "600" 是 3 位不误命中）
- 绑定：主题含 `密保邮箱绑定验证码` → `验证码为[:：]\s*(\d{6})`（**必须用"验证码为"锚定**，否则误吃学号前 6 位）

### 4.4 Email Worker（纯入站，零出站）
```ts
export default {
  async email(message, env, ctx) {
    const token = localPart(message.to);
    const bind = await lookupBind(env, token);              // D1 控制平面解析
    if (!bind || bind.status === "revoked") return message.setReject("unknown recipient");
    if (!senderVerified(message, bind)) return message.setReject("sender not verified"); // SPF+envelope+IP
    const email = await PostalMime.parse(message.raw);
    const hit = extractCode(email.subject, email.text, email.html); // {code, kind:login_2fa|bind_confirm} | null
    if (!hit) return;                                        // 非验证码邮件，静默 drop
    await env.CQU_SESSION.getByName(bind.userId)
      .fetch("https://do/deposit-code", { method:"POST", body: JSON.stringify({ ...hit, sender: message.from, ts: Date.now() }) });
    // 永不 forward()/reply() —— 零出站
  },
}
```

---

## 5. Container 浏览器登录器 + RPC 契约

**核心复用**：仓库 `systems/auth/cqu_login.py`（patchright，2026-06-11 实测打通短信/邮件两条链路）已为自动化设计——`--code-file` 模式发码后轮询取码。我们只把"轮询文件"换成"`await` 一个被 DO 推入的事件"，其余（form-nav 提交、发码点击、ticket 抓取、`storage_state` 导出）**照搬实测脚本**。

### 5.1 Container 类 + 触发
```ts
import { Container } from "@cloudflare/containers";
export class CquLoginContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "20s";   // 登录完成即休眠，停止内存计费
}
```
DO 触发（每用户一个实例，隔离；single-flight 锁见 §7）：
```ts
const password = await decrypt(creds.encryptedPassword, creds.iv, env.ENCRYPTION_KEY);
const resp = await env.CQU_LOGIN.getByName(this.userId).fetch("https://c/run", {
  method: "POST",
  body: JSON.stringify({ studentId, password, service: DUMMY_SERVICE, method: "mail" }),
});
const { ok, cookies, ticket } = await resp.json();
```

### 5.2 容器内（Python + patchright，包 cqu_login.py）
```
POST /run {studentId,password,service,method}        ← DO 触发，长连接，~1–2 分钟后返回
  → do_first_factor()          # load + form-nav 密码 → 2fa
  → switch_2fa_tab("mail") → request_code()   # 浏览器原生点发码
  → await CODE_EVENT[session]  # 等 DO 推码（不轮询）
  → submit_code() (form-nav, type=mailLogin)
  → 抓 ST ticket + storage_state → 抽 SOURCEID_TGC/SESSION/rg_objectid
  ← 200 {ok:true, cookies:{...}, ticket}

POST /code {code}                                    ← DO 在收到邮件码时推入
  → CODE_EVENT[session].set(code)                    # 唤醒 /run
  ← 200
```
> aiohttp（async）单进程内 `/run` 与 `/code` 两个 handler 共享 `asyncio.Event`；DO 单线程在 `await /run` 间隙能并发处理 `depositCode` 并发起 `/code` 推送（CF DO 并发模型允许 await 点交错）。

### 5.3 wrangler.jsonc（增量）
```jsonc
{
  "containers": [{ "class_name": "CquLoginContainer", "image": "./container/Dockerfile",
                   "max_instances": 5, "instance_type": "standard-1" }],
  "durable_objects": { "bindings": [
    { "name": "CQU_SESSION", "class_name": "CquSessionDO" },
    { "name": "CQU_LOGIN",   "class_name": "CquLoginContainer" }
  ]},
  "migrations": [{ "tag": "v2", "new_sqlite_classes": ["CquLoginContainer"] }]
}
```
Dockerfile：`linux/amd64` + Debian + Chromium + `pip install patchright` + `patchright install chromium` + 最小 aiohttp server 包住 `cqu_login.py` 的 `run()`。`instance_type` 先 `standard-1`（4 GiB）；`basic`（1 GiB）降本待实测（§9）。

---

## 6. 会话状态机（6 态）

| # | 状态 | 含义 | 存储 |
|---|------|------|------|
| 1 | **正常** active | 会话活、TGT 有效、取 ST 保活中 | DO `status=active` + D1 bind `active` |
| 2 | **正在重登中** relogging | single-flight 容器重登在途；**旧 TGT 仍在服务**（零停机、免费） | DO `loginInFlight={token,startedAt}` |
| 3 | **正在绑定中** binding | 已发专属地址、等密保邮箱确认 / 首次登录 | D1 bind `pending` |
| 4 | **过期** expired | 撞 ~8h 硬顶且重登失败（密码改了/邮件断了/瑞数变） | DO `status=expired` |
| 5 | **Revoked** | 用户/管理员吊销，或连续失败禁用 | D1 bind `revoked` + DO destroy |
| 6 | **未绑定** unbound | 无 cquCredentials 行 | 无 D1 行 / DO 无 state |

**迁移**：
```
未绑定 ──开始绑定──▶ 正在绑定中 ──(邮箱确认+首登成功)──▶ 正常
正常 ──(+7h alarm / 保活探测失效)──▶ 正在重登中 ──成功──▶ 正常
                                          └──失败──▶ 过期 ──退避重试──▶ 正在重登中
正常/过期 ──解绑/吊销──▶ Revoked ──删──▶ 未绑定
```
> 单次重登实测 ~1–2 分钟（等邮件是大头）。因在 +7h 主动触发、旧 TGT 还有 ~1h 寿命，重登窗口内 DO 继续用旧 cookies 取 ST 服务子系统——**零停机、零额外花费**。

> **现状说明**：当前 D1 `cquCredentials.status` 是个 vestigial 字段（schema 默认 `active`，代码无任何路径改它）；真状态此前只在 DO（`active|expired|error` + `unbound`）。本设计将状态收敛为上述 6 态并 D1↔DO 同步以便后台可观测。

---

## 7. 数据模型 + 对现有代码的改动

### 7.1 D1 新增表
```ts
export const cquBindAddresses = sqliteTable("cqu_bind_addresses", {
  token: text("token").primaryKey(),                    // 专属地址本地部分（随机不可枚举）
  userId: text("user_id").notNull().unique(),
  kind: text("kind").notNull().default("direct"),       // direct | forward
  senderWhitelist: text("sender_whitelist").notNull(),  // JSON 字符串数组
  status: text("status").notNull().default("pending"),  // pending | active | revoked
  boundAt: text("bound_at").notNull().default("(datetime('now'))"),
  lastCodeAt: text("last_code_at"),
});
```
> Better Auth CLI 不支持本项目函数式 `createAuth`，migration 需手写 SQL（见 CLAUDE.md）。

### 7.2 DO `CquSessionDO` 运行时状态增量
```ts
interface SessionState { /* …现有… */ loginAt: number; }   // TGT 铸造时刻 → +7h 主动重登
// 另存（单独 storage 键）：
//   loginInFlight: { token: string; startedAt: number }            // single-flight 锁（= 状态"正在重登中"）
//   pendingCode:   { code: string; kind: string; expiresAt: number } // 仅短信/邮件码瞬时落点（TTL 短、单次消费）
```

### 7.3 并发保护：single-flight 登录锁（新增，必须）
DO 单线程只串行"单次 handler 调用"，而一次容器重登是**跨多个 alarm tick 的长异步**。若 +7h 主动 alarm 与"保活探测失效触发的重登"撞车，或用户手动 rebind 撞调度 → 会**并发点火两个容器登录**（双发码、双成本、cookie 写竞争）。
- 触发容器前置 `loginInFlight={token,startedAt}`；完成/超时（如 >3min）才清；重入直接复用在途，不再点火。
- `codeToken`/本次登录 session 一次性、per-login，保证旧码不被另一次登录消费。

### 7.4 `src/services/cqu-sso.ts`
| 函数 | 处置 | 原因 |
|------|------|------|
| `login()`（纯 fetch 密码登录） | **退役** | 瑞数 + 2FA 下纯 fetch 新登录已死；新登录全走 Container |
| `getServiceTicket()` | **保留**（热路径核心） | 凭 TGT 取 ST 对瑞数豁免、纯 fetch 可做 |
| `checkOnline()` / cookie 工具 | 保留 | 保活探针仍用 |
| `parseLoginPage` / `encryptAesEcb` 登录加密 | **下沉到 Container**（Python） | 登录逻辑搬进容器 |

### 7.5 `src/durable-objects/cqu-session.ts`
- `init`：不再调已死的 `ssoClient.login()`，改为触发 Container 登录，记 `loginAt`。
- `alarm`：① 保活探针（`getServiceTicket` 纯 fetch）保留；② **新增 +7h 主动重登**；③ `relogin()` 从"纯 fetch 密码登录"换成"触发 Container"（含 single-flight 锁）。
- 新增 action：`deposit-code`（Email Worker 调；按 kind 分流：`login_2fa`→推容器 `/code`，`bind_confirm`→WS 推浏览器）、`trigger-relogin`。
- `getServiceTicket` action 保留（子系统课表入口不变）。

### 7.6 `src/index.ts`
- `email()` handler（§4.4）。
- 绑定 onboarding 路由（§8）+ **浏览器 WebSocket endpoint**（Hibernatable WS，DO 推绑定确认码）。
- 末尾 `app.all("*")` catch-all **务必保留**（CLAUDE.md 明令）。

---

## 8. 取码下发：推送（不轮询）

```
                    ┌─ 绑定确认码 ─→ 【浏览器 ⇆ DO：WebSocket】──→ UI 秒显（人读了填进 CQU）
Email Worker 收码 ──┤   （hibernatable WS；2min TTL 下轮询来不及，WS 是正解）
  → DO.depositCode  └─ 2FA 登录码 ──→ 【DO → Container：HTTP 推】──→ run() 里 await 的事件被 set
                        （控制通道本就存在，比容器侧再开 WS 更简单、零轮询）
```
- **绑定码 → 浏览器**：DO 原生 Hibernatable WebSocket，连着不烧钱。用户打开绑定页即连 DO，码一到 `ws.send` → UI 秒显。
- **2FA 码 → 容器**：DO 用已有控制通道 `container.fetch('/code',{code})` 推入；容器 `run()` 在发码后 `await asyncio.Event`，`/code` handler `set()` 唤醒。纯事件驱动、零轮询。
- 全链路无轮询：收信是 Email Routing 事件，下发是 WS/HTTP 推，容器内是 asyncio 事件唤醒。

---

## 9. 一次性绑定流程（Onboarding）

用户在**自己真实浏览器**操作（避开瑞数自动化）：
1. auth.cqu.moe opt-in → 系统签发 `<token>@bind.cqu.moe`，D1 写映射（status=pending = "正在绑定中"）。
2. 用户去 CQU 自服务中心 `safe-center/bind-email-password/bind`，把**密保邮箱设为该地址**。
3. 用户在 CQU 页点"发送验证码" → CQU 发绑定确认码到该地址 → Email Worker 捕获（kind=`bind_confirm`）→ DO 经 WS **秒推**给绑定页 UI（2min TTL 内）。
4. 用户把码填进 CQU 自服务 → 绑定完成 → 系统标记 D1 status=active。
5. 用户录入 CQU 密码（加密存）；被告知**以后自己登录改用短信/微信**。

---

## 10. 安全模型与风险（必须正视）

**爆炸半径**：本系统为每个用户托管「**CQU 密码 + 密保邮箱控制权**」≈ 对该 CQU 账号的**近乎完全接管能力**（随时以用户身份登录、收密码重置/安全告警邮件、过邮箱二次验证改绑定）。单点（auth.cqu.moe / D1 / `ENCRYPTION_KEY`）失守 → 所有已绑用户 CQU 账号暴露。

**缓解措施（分层）**：
1. 密码静态加密：D1 存 AES-256-GCM（现有），`ENCRYPTION_KEY` 走 wrangler secret；建议进一步按 userId 派生子密钥。
2. 入站校验：**SPF=pass + envelope + 源 IP**（**不靠 DMARC**，cqu.edu.cn 未部署）；专属地址不可枚举；非验证码邮件静默 drop。
3. 零出站：永不 forward/reply，杜绝中继滥用。
4. 码最小暴露：TTL 短、单次消费、消费即清、按用户 DO 隔离；推送而非长存。
5. 内部端点鉴权：DO↔Container 走 CF 内部、不公开；WS 绑会话鉴权。
6. 并发保护：single-flight 登录锁（§7.3）。
7. 审计：每次登录尝试 / 收码（发件人+时刻）/ 发 ST 全留日志。
8. 知情同意 + 一键解绑：显式 opt-in，向用户讲清"将托管你的密码与密保邮箱"；解绑 = 删 D1 + DO destroy + 提示改回密保邮箱并改密码。
9. 限频：重登频率上限、发码上限。

**合规提醒**：本方案自动化对抗学校 2FA + 瑞数 WAF，且托管他人密保邮箱，**几乎肯定违反 CQU 使用条款**，对用户是重大信任索取。作为知情同意用户的个人自动化，风险由项目方承担。

**运行期失败模式**：瑞数升级（patchright 对版本不敏感，需监控）/ CQU 改邮件格式（提码正则失效 → 告警）/ 邮件投递延迟（退避重试）/ TGT 寿命变动 / 密保邮箱不接受外部域。

---

## 11. 成本与容量（CF Containers，2025-10 费率）

### 11.1 费率（Workers Paid $5/月起，Containers 无免费层）
| 资源 | 费率 | 月含额度 |
|------|------|---------|
| 内存 | $0.0000025 / GiB·秒 | 25 GiB·时（90,000 GiB·秒） |
| vCPU | $0.000020 / vCPU·秒（**按实际利用率**） | 375 vCPU·分（22,500 vCPU·秒） |
| 磁盘 | $0.00000007 / GB·秒 | 200 GB·时（720,000 GB·秒） |

实例：`standard-1` = 1/2 vCPU / 4 GiB / 8 GB（安全选）；`basic` = 1/4 vCPU / 1 GiB / 4 GB（激进下限）。

### 11.2 用量假设
- 重登频率：TGT ~8h 硬顶 → 每 ~7h 一次 ≈ **103 次/用户/月**（24/7 在线）。
- 单次时长：冷启+Chromium+铸P+第一因素+发码+**等邮件**+提交 ≈ **50s 典型**（30s 乐观 / 120s 保守）；重试系数 ×1.3。
- 等邮件那段是**满内存空转**，是成本大头（Chromium 2FA 态不能跨会话迁移，无法中途休眠）。

### 11.3 单次成本（standard-1，50s）
内存 200 GiB·s=$0.00050 + vCPU ~7–10 vCPU·s≈$0.00016 + 磁盘 400 GB·s=$0.00003 ≈ **$0.0007/次**（含重试 ≈ $0.0009）。

### 11.4 月度总成本（含重试、扣免费额度、+$5 基础）
| 用户数 | 容器计算 | 总计/月 |
|--------|---------|---------|
| 10 | ~$0.4 | ~$5.4 |
| 50 | ~$3.8 | ~$8.7 |
| 100 | ~$8.2 | ~$13 |
| 500 | ~$44 | ~$49 |
| 1000 | ~$89 | ~$94 |

**成本结构内存独大**（provisioned 4 GiB × 活跃秒数）；vCPU 按实际利用率（登录大半时间空转等邮件，CPU≈0，吃到红利）；磁盘可忽略。

### 11.5 三个降本旋钮
1. **实例 4 GiB → 1 GiB（basic）**：内存成本 ÷4，100 用户 ≈ $7.6/月；免费额度从 ~3.6 涨到 ~14 个持续用户。**代价**：Chromium 单页在 1 GiB 偏紧，需实测不 OOM（`--single-process --disable-dev-shm-usage`）。第一期就验证。
2. **缩短等邮件空转**：50s→30s 近线性砍 ~40%（压邮件延迟 + 拿码即拆除）。
3. **降频率**：不需 24/7 就别 24/7。清醒时段 ~16h 保活 → ~69 次/月；纯按需重登（查询发现会话死才点火）可砍 70%+。

### 11.6 两条独立的成本线（关键）
**保活/取 ST 是纯 fetch，几乎免费**（每用户每月几美分）；只有**容器重登**烧钱，而它被 TGT ~8h 寿命封顶（~103 次/月），**与查询频率无关**。即「实时课表」想查多勤都接近零成本——它走纯 fetch 热路径，不点火容器。
> 反面：若误把"容器登录"设成每 5 分钟一次（没必要）→ 8,640 次/用户/月 ≈ $7.5/用户/月，纯浪费。

---

## 12. 待逆向 / 待验证（实施前）
- [x] 真实 2FA 邮件样本（发件人/主题/正文/TTL/认证头）— 已抓，见 §4.1。
- [x] 绑定确认邮件样本 — 已抓，确证绑定发 6 位码、TTL 2min。
- [x] cqu.edu.cn 无 DMARC/DKIM、SPF 有效 — 已确认，校验改用 SPF+IP。
- [ ] **密保邮箱是否接受外部域** `@bind.cqu.moe`（有些系统限制域）— 实测。
- [ ] **CF Email Routing 是否会把 SPF-fail 邮件投递到 Worker**（决定我们 setReject 的把关位置）— 实测。
- [ ] **`basic`（1 GiB）Chromium 不 OOM** — 实测（成本 ÷4）。
- [ ] 专用收信 zone/域名选定（**勿在 cqu.moe 顶级开 catch-all**，会劫持现有 @cqu.moe 收信）。

---

## 13. 实施顺序建议（详见后续 writing-plans 实施计划）
1. **逆向闭合**：实测密保邮箱接受外部域 + Email Routing SPF 行为 + basic OOM。
2. **Email 管道**：D1 表 + `email()` handler + 提码正则 + SPF 校验（先 log 不 reject 验证）。
3. **Container**：Dockerfile + aiohttp 包 cqu_login.py（`/run` + `/code` 事件）；本地跑通端到端登录。
4. **DO 改造**：状态机 6 态 + single-flight 锁 + +7h 主动重登 + deposit-code 分流；退役 `cqu-sso.login()`。
5. **WS 下发** + 绑定 onboarding 页。
6. **端到端无人值守闭环**联调 + 审计/告警 + 限频。
```
