# CQU 绑定「转发模式」(kind=forward) — 设计文档

> 日期：2026-06-13
> 状态：已定稿（待实施，subagent-driven）
> 关联：`docs/plans/2026-06-12-cqu-2fa-email-rebind-design.md`（母设计，§4.2 原转发构想已因 envelope 校验变更而失效，本文取代之）

---

## 1. 背景

母系统已上线「直设模式」(`kind=direct`)：用户把 CQU 密保邮箱改为我们签发的专属地址 `<token>@cquotp.com`，CQU 直接把 2FA/绑定邮件发到该地址。直设的发件人校验为 `envelopeSenderAllowed(message.from, ["sso@cqu.edu.cn"])`——依赖 CF 平台在 Worker 前的 SPF 闸（cqu.edu.cn 无 DKIM，故凡 envelope=sso@cqu.edu.cn 且到达 Worker 的邮件必来自 CQU 授权 IP）。

**转发模式**让用户**保留自己的邮箱作为 CQU 密保邮箱**，在自己邮箱里设转发规则，把 CQU 的验证码邮件转发到 `<token>@cquotp.com`。好处：用户不必放弃密保邮箱（仍能自己收 CQU 安全邮件），只是"抄送"一份验证码给我们。

### 关键障碍（为何不能照搬直设）
邮件经用户邮箱转发后，**信封 MAIL FROM 被 SRS 改写**成转发方地址（不再是 `sso@cqu.edu.cn`）。CF 的 SPF 闸此时校验**转发方域**，只证明"来自该转发服务"，不证明"内容来自 CQU"。原始 `sso@cqu.edu.cn` 只剩在**邮件头 `From`** 里（可被伪造）。因此现有 `envelopeSenderAllowed(message.from, ["sso@cqu.edu.cn"])` 对转发邮件必然失败，信任模型必须重做。

---

## 2. 信任模型（已与用户确认）

与直设对称，复用 `senderWhitelist` 字段，仅内容与附加校验不同：

| 模式 | 主闸 | envelope 校验 | 附加校验 |
|------|------|--------------|---------|
| `direct` | 不可枚举 token | `envelope ∈ ["sso@cqu.edu.cn"]`（CF SPF 闸证明 CQU IP，**强**） | 无 |
| `forward` | 不可枚举 token | `envelope ∈ [用户登记的转发地址]`（证明"穿过了该用户的转发器"，SPF 对转发方域成立） | parse 后 `email.from.address === "sso@cqu.edu.cn"`（补回 CQU 来源信号，**弱、可伪造**） |

### 安全性陈述（必须知情同意）
- 转发模式信任 = **不可枚举 token（主闸）** + **envelope ∈ 用户转发地址** + **header From=sso@cqu.edu.cn（可伪造）**。
- **本质弱于直设**：header From 不是签名、无密码学保证。若 token 泄露，转发模式比直设更易被注入伪造邮件。
- **最坏后果有限**：注入的 6 位码最终提交给 CQU，假码 CQU 对不上 → 单次重登失败（**DoS 级**），**非账号接管**（夺号需攻击者拿到 CQU 真实下发的码，而该码只发到用户邮箱+我们地址）。
- envelope ∈ 转发地址这道闸的价值：挡住"仅知道 token 者直投"（攻击者无法以转发方身份过 SPF），把可行攻击收窄为"先把伪造邮件塞进用户邮箱再被转发"。

### 投递性陷阱（写进用户文案）
cqu.edu.cn **无 DKIM**，CF 在 Worker 前强制"SPF 或 DKIM 过一个"。若用户的转发器**不做 SRS 改写**（保留 envelope=sso@cqu.edu.cn 直转），转发器 IP 不在 cqu SPF 内 → SPF=fail + 无 DKIM → **CF 在进 Worker 前就拒收，邮件根本到不了**。只有会 SRS 改写 / 用自身 DKIM 重签的转发器（Gmail、QQ、Outlook 等主流都会）才转得进来。

---

## 3. 数据模型（schema 已就位，无需 migration）

`cqu_bind_addresses`（`src/db/schema.ts`）：
- `kind: text` = `"direct" | "forward"`（已存在，默认 `direct`）
- `senderWhitelist: text`（JSON 字符串数组，已存在）
  - direct: `["sso@cqu.edu.cn"]`
  - forward: `["<用户转发地址的实际 envelope>"]`

---

## 4. 组件与数据流

### 4.1 发件人校验（`src/services/cqu-2fa/sender-auth.ts` + `src/email-handler.ts`）
保留纯函数 `envelopeSenderAllowed`。新增 forward 分支所需的 header-From 校验（纯函数，可单测）：

```
forwardSenderAllowed(envelopeFrom, headerFromAddress, senderWhitelist):
  envelopeSenderAllowed(envelopeFrom, senderWhitelist)   // envelope ∈ 用户转发地址
  && headerFromAddress.trim().toLowerCase() === "sso@cqu.edu.cn"
```

`email-handler.ts` 按 `bind.kind` 分叉校验顺序：
- `direct`：token → envelope ∈ whitelist → parse → extractCode（**现状不变**）
- `forward`：token → envelope ∈ whitelist → **parse** → header From === sso@cqu.edu.cn → extractCode
  - parse 提前到 header-From 校验前（header From 在 MIME 内）。parse 发生在 envelope 已过 whitelist 之后（已确认穿过该用户转发器），风险可控；`MAX_RAW_SIZE` 上限保留。

### 4.2 地址签发（`src/routes/cqu-bind.ts` `POST /address`）
当前硬编码 `kind:"direct"` + `senderWhitelist:["sso@cqu.edu.cn"]`。改为按请求体的绑定方式分叉：
- `direct`：同现状。
- `forward`：body 带用户转发邮箱地址 → 校验是合法邮箱 → 写 `kind="forward"`, `senderWhitelist=[该地址]`。
- 用户身份仍只取自 session/JWT（绝不取客户端入参作 userId）。

### 4.3 前端 wizard（`frontend/src/pages/CquBindWizard.tsx`）
Step 1（说明）后加"绑定方式"选择：
- **直设**（推荐，更安全）：走现有流程。
- **转发**：让用户填自己的转发邮箱地址；展示转发设置指引 + 投递性须知（必须用会 SRS 改写的转发器）+ 安全弱化告知。
- 文案明确转发模式的信任弱化与"最坏是单次重登失败、非夺号"。

### 4.4 SRS 兜底（v1 简化版）
用户登记的转发地址可能与 SRS 改写后实际 envelope 不一致 → 邮件被 envelope 闸拒、用户永远收不到码。
- **v1**：forward 邮件若 `header From=sso@cqu.edu.cn` 但 `envelope ∉ whitelist`，打一条**显著日志**记录实际 envelope（`[email] rejected reason=forward_envelope_mismatch from=<实际>`），便于运营/用户据此校正登记地址。**不**自动放行（安全优先）。
- **v2（不在本次范围）**：首封转发邮件的实际 envelope 经 WS 回显给绑定页，用户一键确认后写入 whitelist。

---

## 5. 实现铁律（项目历史教训）
- **header From / envelope 的实际形状必须用一封真实转发样本确认**再定校验/正则（本项目三次栽在"凭样本/文档猜"）。实现期需用户用真实邮箱转一封 CQU 邮件到测试 token 地址，抓 `email.from` 与 `message.from` 实际值。
- PostalMime 的 `email.from` 在不同转发器下可能是 `sso@cqu.edu.cn`，也可能被改写为 `sso=cqu.edu.cn@forwarder` 或挪到 `Reply-To`——以真实样本为准，必要时校验放宽到"From 或 Reply-To 含 sso@cqu.edu.cn"。

---

## 6. 测试
- **纯函数单测**（vitest Node pool，可测）：`forwardSenderAllowed` 各分支（envelope 命中/不命中 × header From 命中/不命中 × 大小写/空白）。
- **集成**：靠真实转发样本 + 真实 onboarding（email-handler/DO 不可单测，沿用项目现状）。

---

## 7. 范围边界
- **v1 做**：信任模型校验分叉、地址签发分叉、前端绑定方式选择、SRS 兜底日志、纯函数单测。
- **v1 不做**：SRS 首封自动确认 UI（v2）；转发模式的多地址白名单（单地址足够）。
