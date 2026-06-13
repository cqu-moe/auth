# 交接文档：CQU 2FA 邮件取码无人值守会话重绑（session-2）

> 写于 2026-06-13（第二轮收尾，用户睡觉前授权自主完成）。给下一个 session / 醒来的用户。
> 仓库：`/Users/uu/Documents/Coding/cqu-moe/auth`，分支 `feat/cqu-2fa-email-rebind`（**未合并 main**）。
> 关联（只读参考）：`/Users/uu/Documents/Coding/cqu-moe/cqu-api-endpoint-collection`

## 0. ✅ 已部署 + 已迁移 + PR 已开（session-2 两轮收尾，用户授权）

**生产当前版本 = `62b85cfc`**（2026-06-13 13:24 部署）。本 feature 全部功能 + 本轮收尾（forward 模式、bound_at 修复、限频/告警、审计修复、可观测性、MEDIUM-1 deposit 投递可观测、wizard 文案、expiry 取证诊断）**全部上线**。迁移 `0003` 已 `apply --remote`（bound_at 脏行订正、复验 0 dirty）。
**分支收尾 = PR #4**（https://github.com/cqu-moe/auth/pull/4，feat/cqu-2fa-email-rebind → main，48 commit，**留人工审阅合并**；不直接合以避开失败的 CF 容器构建）。

**仍待办（需用户动作 / 需时间）**：
1. **🟢 转发模式真实样本**（需你动作）：上线给真实用户前，用一封真实转发的 CQU 邮件发到某 forward token 地址，抓 `email.from` 实际形状（SRS 改写/Reply-To）后定校验——见 §3。forward 是 opt-in，没人用之前不影响 direct。
2. **🔵 会话频繁 expired 根因**（需静置采数据）：取证诊断已上线（`new TGT exp=<iso>` 登录时打、`probe says expired: ... page=cas-login|waf-challenge` 过期时打）。**关键操作纪律：别再频繁部署**——本轮 4 次部署反复打断在途重登、制造了虚假高频（见 §2）；让系统静置几个周期，再看诊断日志判定是"定点过期"/"瑞数误判"/"真 TGT 短命"。限频 6/h + 连续失败告警已兜底防失控。
3. **⚪ PR #4 合并**：人工审阅后合并（合并/push main 会触发一次失败的 CF 容器构建，不影响手动部署的 prod）。

```bash
# 运维参考（如需再次部署——但排查 expiry 期间应尽量少部署）：
npm run deploy                                              # 前端构建 + wrangler deploy（沙箱外/Docker）
npx wrangler d1 migrations apply auth-cqu-moe-db --remote   # 迁移（wrangler deploy 不跑迁移）
# 查 expiry 诊断数据（静置后）：observability 搜 "new TGT exp" / "probe says expired"
```

> 已完成并上线的小项：wizard "返回上一步"→"刷新页面重填"文案（efcedc5）；MEDIUM-1 deposit `delivered` 字段使丢码不再误记 accepted（d61f785）。下面 §1 是 session-2 第一轮提交表；第二轮提交 `1c8ef3b`(docs)→`778d6ee`(expiry诊断)→`d61f785`(MEDIUM-1)→`efcedc5`(wizard)。

## 1. 本轮干了什么（7 个提交，`ca08805`→`623478a`）

全部 subagent-driven（implementer → spec 审 → 质量审 / silent-failure-hunter），符合用户"执行用 subagent"约束。

| commit | 内容 |
|--------|------|
| `ca08805` | docs：转发模式设计文档 `docs/plans/2026-06-13-cqu-forward-mode-design.md` |
| `438da4d` | **可观测性**：proactive relogin 日志 info→warn；新增 "relogin OK, new TGT minted"（重登成功此前无日志，是盲区）。**这条已部署（= dc4848f5）** |
| `5970bb6` | **bound_at 修复**（见 §4） |
| `9e17352` | **转发模式后端**（见 §3） |
| `721ccff` | email 审计修复：deposit 失败不再误记 `[email] accepted`，改记 error（silent-failure-hunter HIGH-1） |
| `72a7686` | **转发模式前端 wizard**（绑定方式选择，forward 不等 WS） |
| `623478a` | **重登限频 + 连续失败告警 + proactive 判定纯函数化**（见 §5） |

状态：`npm run typecheck` 干净、前端 `tsc` 干净、`npm run test` **54 绿**（39→54，新增 forward sender-auth 12 + relogin-policy 15 - 既有调整）。工作树干净（除本交接文档）。

## 2. ⭐ 自动重登验证结论（无人值守核心，已生产实证）

上一轮交接说"+7h 自动重登从没真实见证过"。本轮**用 observability 实证了两条路径都工作**：

- **reactive 路径（端到端闭环实锤）**：`04:02:17 session expired server-side, triggering container relogin` → `04:03:08 [email] accepted`（trigger=sso@cqu.edu.cn）→ 无失败日志。**证明：容器登录 + CQU 发 2FA 邮件 + 邮件捕获 + deposit + 容器提交码 全链在生产可用。**
- **proactive 路径（点火实锤）**：临时把 `PROACTIVE_RELOGIN_MS` 调 3min 部署验证版(b6c4fc67) → `10:50:01 [CquSession] 30208415: TGT age >= 7h, proactive relogin` 触发。验证后**已回滚 7h**(dc4848f5)。
- 顺带证伪了上轮的担忧：旧日志里 `relogin rejected: expected 302` 等是**旧版本**(adc3c2da/c62cfda9)的废弃纯 fetch 路径报的，当前 `containerLogin` 路径无硬失败。
- 主噪声是 `NETWORK_ERROR`（CF→CQU 探针超时），属 transient、不误判重登（见 `feedback_cqu_keepalive_network_hang`）。

**残留疑点（值得监控，未阻塞）**：观测到一次会话只活 ~4.8h（04:03 重登成功→08:55 又判 expired），短于 ~8h TGT 寿命。可能是 CQU 发的会话更短、或重登"返回 ok 但 TGT 没真刷新"、或网络抖动造成的真 expired。新加的 "relogin OK" + proactive(warn) 日志今后能帮定位。

## 3. 🟢 转发模式 kind=forward（已实现，上线前需真实样本）

**设计**：`docs/plans/2026-06-13-cqu-forward-mode-design.md`（权威）。
**信任模型**（与用户确认）：主闸不可枚举 token；`direct`= envelope ∈ `["sso@cqu.edu.cn"]`（CF SPF 闸证明 CQU IP，强）；`forward`= envelope ∈ `[用户登记的转发地址]` **且** header `From`=sso@cqu.edu.cn（补 CQU 来源信号、**可伪造**、本质弱于直设；最坏被注入假码导致单次重登失败=DoS 级，非夺号）。

**已实现**：
- 后端 `src/services/cqu-2fa/sender-auth.ts`：`forwardSenderAllowed(envelopeFrom, headerFromAddress, whitelist)`（+ 12 单测）。
- `src/email-handler.ts`：按 `bind.kind` 分叉。forward：envelope 不过→`forward_envelope_mismatch`（记 `message.from` 供用户校正，**不 parse**）；过→parse→`email.from?.address`→header 校验。direct 零回归（parse 抽成 `parseEmail()` helper，逐行确认等价）。
- `src/routes/cqu-bind.ts` `POST /address`：body `{kind?, forwardAddress?}`，forward 校验邮箱、写 `kind=forward`+whitelist=[地址]，幂等不改既有行。
- 前端 `frontend/src/pages/CquBindWizard.tsx`：Step1 加方式选择，forward 收转发邮箱 + 投递性/安全须知；**forward 的 Step2 不建 WS、不等码**（转发模式不改密保邮箱、没有 bind_confirm 这步），首登端到端验证转发是否通。

**⚠️ 上线前置（项目铁律：以真实数据为准，已三次栽在凭样本猜）**：forward 把 `email.from.address === "sso@cqu.edu.cn"` 当 CQU 来源信号。但**不同转发器经 SRS 后 `email.from` 可能被改写/挪到 Reply-To**。启用 forward 给真实用户前，**必须用一封真实转发的 CQU 邮件**发到某 forward 测试 token 地址，抓 `email.from`/`message.from` 实际值，再决定校验是否要放宽到"From 或 Reply-To 含 sso@cqu.edu.cn"。代码内已有铁律注释标注此项。（合并到分支/部署无碍——forward 是 opt-in，不影响现有 direct 用户；但别引导真实用户用 forward 直到验过样本。）

**投递性须知（已写进 wizard 文案）**：cqu.edu.cn 无 DKIM + CF 在 Worker 前强制"SPF 或 DKIM 过一个"。不做 SRS 改写的转发器（保留 envelope=sso@cqu.edu.cn 直转）会被 CF 在投递前拒收。主流（Gmail/QQ/Outlook）都做 SRS/自身 DKIM 重签，OK。

## 4. ⚪ bound_at 修复（已实现）

**真根因（比上轮交接 §5 判断更准）**：迁移 DDL 默认值 `DEFAULT (datetime('now'))` **本身是对的**；bug 在 Drizzle `.default("(datetime('now'))")` 传 JS 字符串→Drizzle 把它当 client-side 默认值、insert 省略该列时**作为绑定参数注入**、覆盖了正确的 DB 列默认值。
**已修**：`schema.ts` 两列改 `.default(sql\`(datetime('now'))\`)`；`cqu-bind.ts`/`cqu.ts` 三处 insert 显式 `boundAt: sql\`...\``；新增 `drizzle/migrations/0003_fix_bound_at_literal.sql`（UPDATE 订正存量字面串行，不重建表）。本地验证不误伤正常行。**0003 需 `--remote` 应用**（见 §0）。

## 5. ⚪ 限频 + 告警（已实现）

`src/services/cqu-2fa/relogin-policy.ts`（纯函数 + 15 单测）：
- `shouldProactiveRelogin(...)`：proactive 判定抽成纯函数（alarm 内联条件零行为变化，顺带补上验证用单测）。
- `shouldThrottleRelogin / pruneAttempts`：**重登频率上限 6/h**（滑动窗口）。放在 `relogin()` 内、`containerLogin()` 之前——**首登 `initSession` 不经过 `relogin()`，绝不被限流**。命中→`console.error ALERT`+跳过（不记录本次，窗口自愈）。正常 ~1/8h，6/h 是纯 runaway/防瑞数后备闸。
- 连续重登失败 ≥3 → `console.error ALERT`（storage `reloginFailures`，failed 增/ok 重置/in_flight 不动）。
- 设计 §10 的「发码上限」经重登限频间接达成；显式"每绑定收码上限"(email handler 侧，风险丢合法码) **deferred 到 v2**。

## 6. 已知小项 / deferred（不阻塞，记录备查）

- **转发 wizard 文案**：`INVALID_FORWARD_ADDRESS` 错误提示写"请返回上一步"，但 wizard 无应用内返回按钮（刷新会清状态）。是既有 codebase 既有文案模式（direct 也这么写）。Minor，建议软化为"请刷新页面重填"。
- **MEDIUM-1（既有、可辩护，未改）**：DO 的 `deposit-code` action 无论码是否真送达容器都回 200 → email-handler 的 `depositOk` 不反映端到端。想更准可让 DO 在 login_2fa 无主码/容器 push 失败时回非 200。
- **~4.8h 早夭疑点**：见 §2，监控。
- **SRS 首封自动确认 UI**：v2（v1 只记日志供校正）。
- **分支未合 main**：本轮用户未选合并。收尾可用 `superpowers:finishing-a-development-branch`。注意带容器后 CF Workers Builds(Git CI) 无 Docker、构建不了镜像，合并后仍需本地 `npm run deploy` 上容器。

## 7. 部署/环境硬事实（沿用上轮，复述关键）

- Worker `cqu-moe-auth`(=auth.cqu.moe)；**当前活跃版本 `dc4848f5`**（10:54 部署，回滚版）。容器 App `cqu-moe-auth-cqulogincontainer`，instance_type basic。
- D1 `auth-cqu-moe-db`（id `135e9272-b7f6-4672-925a-f813dba5ad40`），迁移已到 0002 remote；**0003 待 apply**。
- 已绑用户 1（学号 30208415，direct，active）。
- `npm run deploy` = build:frontend + wrangler deploy（本地 Docker 构建+推容器镜像）。**坑**：① wrangler deploy 不跑 D1 迁移；② CF Workers Builds 无 Docker，容器镜像必须本地构建（不能靠 push-main 自动带容器）；③ 部署/Docker 需沙箱外（`dangerouslyDisableSandbox`）。
- secrets 齐：ENCRYPTION_KEY / BETTER_AUTH_URL / BETTER_AUTH_SECRET / RESEND_API_KEY。
- 容器超时不变量：`CODE_WAIT_TIMEOUT=570s` < 2FA 码 600s；`RUN_TOTAL_TIMEOUT=660s`；`LOGIN_LOCK_TTL_MS=720s`。改一个连带改全部。
- 测试：vitest Node pool，只能 TDD 纯函数（`src/services/cqu-2fa/*.test.ts`，现 54 绿）；DO/容器/email-handler 靠 typecheck + 真实集成。

## 8. 方法论 / git（沿用）

- 实现必须 subagent（本轮全程 implementer + spec 审 + 质量审/silent-failure-hunter）。
- git 默认身份签名（1Password SSH）；commit body 结尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。**禁止** `-c user.name=` 覆盖身份。
- 查 CF 资源/日志优先 Cloudflare MCP（observability `query_worker_observability`、bindings `d1_database_query`）；注意 D1 直查含 token/PII 会被守卫拦，只选非敏感列。
- observability 实测：info 级日志**可见**（一度误判不可见）；happy-path keepalive 成功不打日志（"无日志"不等于"alarm 死了"，要看 OTEL span 或 [verify] 类诊断）。

## 9. 建议下个 session 开场

1. 读本文档 + §1 提交 + §3 设计文档。
2. `git log --oneline -12`、`git status`、`npx wrangler whoami`。
3. 若用户要上线：§0 部署 + 迁移 + 复验。
4. 转发模式给真实用户前：§3 真实样本验证。
5. 视情况：限频阈值 review、§6 小项、合并 main。
