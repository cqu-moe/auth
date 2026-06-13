# 交接文档：CQU 2FA 邮件取码无人值守会话重绑（session-2）

> 写于 2026-06-13（第二轮收尾，用户睡觉前授权自主完成）。给下一个 session / 醒来的用户。
> 仓库：`/Users/uu/Documents/Coding/cqu-moe/auth`，分支 `feat/cqu-2fa-email-rebind`（**未合并 main**）。
> 关联（只读参考）：`/Users/uu/Documents/Coding/cqu-moe/cqu-api-endpoint-collection`

## 0′. ✅ session-3（2026-06-14，全部 subagent-driven + 审 + 已部署）

**生产当前版本 = `e6fb6ec5`**。本轮四件事，prod 全部上线、git 已 push 同步、PR #4 已含本轮改动：

1. **RESTful 化 CQU 绑定 API**（`ae5bf99` 后端 + `2e243a1` 前端）：资源 = 单数 `/api/cqu/binding`：
   - `POST /api/cqu/binding`（创建/签发地址，新建 201 / 幂等 200；`kind=forward` 仍 403）
   - `GET /api/cqu/binding`（`{address?, bindStatus, sessionStatus}`）
   - `PUT /api/cqu/binding/credentials`（设凭证 + 首登）
   - `GET /api/cqu/binding/events`（WS 升级，← 旧 `/ws`）
   - `DELETE /api/cqu/binding`（解绑，204）
   - admin：`PATCH /api/admin/users/:id/cqu-binding {status:"revoked"|"active"}`（取代旧 `revoke-cqu`/`unrevoke-cqu` 动词端点，查 DO `res.ok` 保 D1↔DO 一致）
   - `cqu.ts` 删旧 `POST/PUT/DELETE /bind` + `GET /status`，**只留 `GET /service-ticket`**。前端 wizard + Settings 全改到新契约（DELETE 处理 204 无 body）。

2. **实时验证码面板（live code view）**（`65571d9`+`e42b82e`+`13c39ca`+`daeb414`+`4d6e6ac`，→ prod `e6fb6ec5`）：用户手动登录 CQU 时能在 Settings 实时看到到达专属地址的码。
   - 后端：`depositCode` 把 `login_2fa` **无条件广播给已连 WS** + 存 pendingCode。**⚠️ 返回值仍保留 silent-failure 告警链**：仅"无在途登录的手动码"从 `return false` 改 `true`（已送达用户面板），容器收码失败/退化态仍 `false`（照样 code_dropped 告警）。
   - 回放发**真实收码 `ts` + 服务端算的 `remainingMs`**（不再用回放时刻 → 修了倒计时锚点错 + 10:01 时钟偏移；回放门槛收紧为"仍在 10min 有效期内"）。
   - **WS keepalive** = `this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping","pong"))`（不唤醒休眠 DO、不计费；前端每 30s 发 `ping`，收到 `pong` 忽略）。
   - 前端 `LiveCodeSection`（折叠面板，仅 bindStatus==="active" 渲染）：**按 code 去重**（解决快速开合/重连堆同码卡）、deadline 本地时钟倒计时、有限重连 5 次 + 重试按钮、onExpire 驱动卡片即时灰化。
   - **关键约束（用户实测确认）**：CQU **同一时间只有一个有效验证码**（上一个没过期发不出新的）→ 无争用歧义，简单广播即可，无需"暂停自动重登"模式。

3. **git 同步**：本地曾领先 origin 8 commit（prod 在跑但没 push）→ 已 `git push`，**PR #4 与 prod 对齐，回滚风险消除**。

4. **CI/CD（GitHub Actions）— 已落地，两条路径均实测通过 ✅**：单一工作流 `.github/workflows/deploy.yml`（`on: push` 所有分支 + `workflow_dispatch`；docs/md `paths-ignore` 不触发）。先过门禁（backend typecheck + test + frontend tsc/build），再按分支：
   - **main → D1 迁移（`wrangler d1 migrations apply --remote`，幂等）+ `wrangler deploy`**（生产，接管 100% 流量）。
   - **其他分支 → `wrangler versions upload`**（上传 0 流量版本，可回滚）。
   - 容器在 ubuntu-latest 自带 Docker 上构建 linux/amd64 镜像（与本地 `npm run deploy` 等价）。actions 用 v5（Node 24，规避 6/16 Node20 弃用）。
   - **⚠️ DO 限制**：本 Worker 用 Durable Objects（CquSessionDO + 容器本身即 DO）→ CF **不为其生成 preview URL**，故分支版本**拿不到可点预览链接**（versions upload 仅做"构建+上传全链验证 + 可回滚版本"）。要可测分支环境只能另建独立预览 Worker（未做）。
   - **配套已完成**：repo secret `CLOUDFLARE_API_TOKEN`（Workers Scripts/D1/Containers:Edit）+ `CLOUDFLARE_ACCOUNT_ID`（=`a666c560407022706a52a703923548d5`）已设；用户已**禁用 CF git-connected Workers Builds**；**PR #4 已 squash 合并进 main**（commit `c55bf91`，远程 feat 分支已删），**main 自动部署已实测成功**（prod 现由 Actions 部署）。
   - 后续可选优化：Docker 层缓存加速容器构建（现每次分支 push 全量重建 chromium 镜像，慢）；如分支 push 太频可把 versions upload 限定到带 PR 的分支。

---

## 0. ✅ 已部署 + 已迁移 + PR 已开（session-2 两轮收尾，用户授权）

**生产当前版本 = `b0301f99`**（2026-06-13 晚最新）。本 feature 全部 + 本轮所有收尾均上线：bound_at 修复、限频/告警、审计修复、可观测性、expiry 取证诊断、MEDIUM-1 deposit 可观测、wizard 文案、容器登录失败诊断、**forward 模式已禁用**、**unbind/revoke/un-revoke**、**Settings 绑定区块重写**。迁移 `0003` 已 `apply --remote`（bound_at 0 dirty）。

**本轮关键决策与发现（重要）**：
- **🔴 转发模式已禁用**（前端选项置灰不可选 + 后端 `/address` 对 `kind=forward` 返 403）。真实样本实测：Fastmail "Send a copy to" 是**真转发、保留 envelope=`sso@cqu.edu.cn`**（非 SRS，**推翻原"转发必被 SRS 改写"假设**）；但**码没在容器 570s 窗口内送达**（CQU 22:33 即发到用户邮箱、容器 22:43 报 `code never arrived`；疑 CF 邮件闸拒收无 DKIM 的转发件、或 Fastmail 转发太慢）。根因：**2FA 码 600s 硬有效期 + 转发多一跳 → forward 对"限时取码登录"不可靠**。代码保留（forward 白名单已改双源 §3），待更快/可靠的转发方案（如 Fastmail 账户级原生 Forwarding，DKIM 重签 + 即时）再开。
- **解绑/吊销三件套**（后端齐；前端按用户要求只做 unbind）：
  - **unbind**（用户自助彻底删）：`POST /api/cqu/bind/unbind` = 删 cqu_credentials + cqu_bind_addresses + DO destroy。Settings "解除绑定"调它。
  - **revoke**（admin 禁用、留墓碑）：`POST /api/admin/users/:id/revoke-cqu` = D1 status→revoked + DO revoke(setStatus revoked + deleteAlarm + 清 loginInFlight，**保留**凭证/state)。
  - **un-revoke**（admin 恢复）：`POST /api/admin/users/:id/unrevoke-cqu` = D1 status→active + DO unrevoke(setStatus expired + setAlarm now → 用保留凭证自愈)。
  - 语义：unbind=删光 / revoke=禁用留墓碑 / un-revoke=恢复。三者自洽。两个 admin 端点查了 DO `res.ok`，避免半撤销谎报成功。
- **Settings 绑定区块重写**（原是旧死逻辑：内联学号/密码 → 已废弃的纯 fetch `POST /api/cqu/bind`）。现：展示**专属邮箱地址(可复制)** + "绑定"跳向导 `/cqu/bind` + "解除绑定"调 unbind + 会话状态三态徽标。个人信息/修改密码区块未动。
- **用户本人已切回 direct**（CQU 密保邮箱直连 `3fl0jmlb3dyt76lq@cquotp.com`、撤掉 Fastmail 转发规则）——direct 稳。

**仍待办（需用户动作 / 需时间）**：
1. **🔵 会话频繁 expired 根因**（需静置采数据，最高优先）：取证诊断已上线（登录打 `new TGT exp=<iso>`、过期打 `probe says expired: ... page=cas-login|waf-challenge`）。疑"**定点过期**"（用户提示：按固定时刻而非时长过期；某次测试 8h 没过期）。**操作纪律：别频繁部署**（会打断在途重登造假高频）。限频 6/h + 连续失败告警兜底。用户已在 direct，会话可用（重登能成），只是 churn 偏多。静置后看 `new TGT exp` 的确切过期时刻能直接验证定点假设。
2. **🔴 转发模式重开**（已禁用，见上"关键发现"）：重开前必须解决投递可靠性——码要在容器 570s 内到。试 Fastmail 账户级原生 Forwarding（DKIM 重签+即时）或其它即时转发；确认 CF 闸不拒。代码已留（白名单双源 §3、前端置灰、后端 403）。
3. **⚪ PR #4 已过时 + 合并 main**：PR #4（github.com/cqu-moe/auth/pull/4）创建于早期 commit，**缺本轮 forward-禁用 / unbind/revoke / Settings 等改动**——需 `git push` 更新分支（或重建 PR）。合并/push main 会触发失败的 CF 容器构建（不影响手动部署 prod）。
4. **⚪ 旧端点清理**：`cqu.ts` 的旧 `DELETE /api/cqu/bind`（漏删 cqu_bind_addresses）+ 旧 `POST/PUT /bind`（纯 fetch 登录，已废弃不可用）可日后删。

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
