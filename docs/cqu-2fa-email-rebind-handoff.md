# 交接文档：CQU 2FA 邮件取码无人值守会话重绑

> 跨 session 接力用。**只记未完成事项 + 必要现状/备查**；已完成的历史细节见 git log、`AGENTS.md`、自动记忆。
> 仓库：`/Users/uu/Documents/Coding/cqu-moe/auth`，分支已并入 **main**（feat 分支已删）。
> 更新：2026-06-14（session-3 收尾，已精简）。

## 现状（一句话）

CQU 增强登录无人值守会话重绑 **已上线并生产实证可用**：自动重登（reactive + proactive 两路径）、RESTful `/api/cqu/binding` API、实时验证码面板、unbind/revoke/un-revoke 全部部署。**CI/CD 已就位**：push main → GitHub Actions 自动迁移 + 部署（接管流量）；其他分支 → `wrangler versions upload`（0 流量版本）。用户本人用 **direct 模式**（密保邮箱直连 `<token>@cquotp.com`），可用，只是会话 churn 偏多（见下 #1）。

---

## 未完成事项

### 1. 🔵 会话频繁 expired 根因（最高优先，需静置采数据）

**现象**：会话寿命常短于 ~8h TGT 寿命（观测到一次 ~4.8h：04:03 重登成功 → 08:55 又判 expired）。
**假设**：「**定点过期**」——按固定时刻而非时长过期（用户提示；某次测试 8h 没过期）。
**取证诊断（已上线）**：
- 登录时打 `new TGT exp=<iso> (ageBudget=<min>)`（`decodeJwtExp`）。
- `getServiceTicket` 非 302 时读 body 分类：`page=cas-login | waf-challenge | other`。
- `runKeepAlive` 打 `probe says expired: ... page=`。

**怎么查**：observability 搜 `new TGT exp` / `probe says expired`。看 `new TGT exp` 的确切过期时刻能**直接验证定点假设**（若多次过期落在同一钟点 → 定点）。
**纪律**：排查期**少动 main**——现在 **main push 即触发生产部署**，会打断在途重登、制造虚假高频。
**已有兜底**：重登限频 6/h + 连续失败告警；主噪声 `NETWORK_ERROR`（CF→CQU 探针超时）是 transient、不误判（见记忆 `feedback_cqu_keepalive_network_hang`）。

### 2. 🔴 转发模式（kind=forward）重开

**现状**：已禁用——前端选项置灰，后端 `/address`(现 `POST /api/cqu/binding`) 对 `kind=forward` 返 403。代码保留（`sender-auth.ts` 双源白名单 + email-handler 分叉）。
**为何禁**：2FA 码 **600s 硬有效期** + 转发多一跳 → Fastmail "Send a copy to" 太慢，码没在容器 **570s** 窗口内到（实测：22:33 到用户邮箱、容器 22:43 报 `code never arrived`）。
**重开前置**：① 投递可靠性——码要在容器 570s 内到（试 Fastmail 账户级**原生 Forwarding**〔DKIM 重签 + 即时〕或其它即时转发）；② 确认 CF 邮件闸不拒无 DKIM 的转发件；③ **真实样本验证**：用一封真实转发的 CQU 邮件抓 `email.from`/`message.from` 实际值，定校验是否放宽到 Reply-To（不同转发器经 SRS 可能改写 From）。

### 3. ⚪（可选）CI 容器构建提速

现每次分支 push 全量重建 chromium 容器镜像（慢）。可加 Docker 层缓存；或把 `versions upload` 限定到带 PR 的分支，减少无谓构建。

---

## 关键事实备查（仍生效，避免重新踩坑）

- **收信域 = `cquotp.com`**（zone apex catch-all）。CQU 密保邮箱校验**拒域名含连字符**、**拒过长本地部分** → 地址 token 取 **16 位**。
- **发件人校验**：验 envelope `message.from` ∈ 白名单（`["sso@cqu.edu.cn"]`）。CF 平台在 Worker 前已强制 SPF-or-DKIM；cqu.edu.cn 无 DKIM → 到达 Worker 且 envelope=sso@cqu.edu.cn 的必已过 SPF。**不是** ARC 头（那是转发路径才有，曾踩坑）。
- **2FA 码 / 绑定确认码有效期 ~10min**（邮件正文写的"2分钟"不准）。
- **CI/CD**：`.github/workflows/deploy.yml`（`on: push` 全分支 + dispatch；md/docs `paths-ignore`）。main → 迁移 + deploy；分支 → versions upload。**DO 限制**：本 Worker 用 Durable Objects → CF 不生成 preview URL，分支版本无可点预览链接（要可测分支环境只能另建独立预览 Worker）。secret `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` 已设；CF git-connected Workers Builds 已禁用。
- **部署坑**：`wrangler deploy` 不跑 D1 迁移（CI 里单独 `migrations apply --remote`）；容器构建需 Docker（CI runner 自带）。
- 其余架构/gotcha 见 `AGENTS.md` 与自动记忆 `project_cqu_2fa_email_rebind`。
