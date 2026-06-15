# 交接文档:第一方一体化 + 分级权益(Entitlements)

> 跨 session 接力用。**只记现状 + 已定决策 + 未完成项**;完整设计见 `docs/plans/2026-06-14-firstparty-entitlements-design.md`,实现步骤见 `docs/plans/2026-06-14-firstparty-entitlements-plan.md`,接入契约见 `docs/subsystem-integration-guide.md`。
> 仓库:`/Users/uu/Documents/Coding/cqu-moe/auth`。创建:2026-06-14(brainstorm session 收尾)。

## 现状(一句话)

**设计 + 实现计划 + 接入文档已定稿,代码实现尚未开始。** 这是一次纯 brainstorm→plan session,产出 4 份文档(下方指针),无任何 src/ 改动。下个 session 从 plan 的 **Task A1** 开始执行。

## 文档指针

- 设计:`docs/plans/2026-06-14-firstparty-entitlements-design.md`
- 实现计划(TDD,逐任务):`docs/plans/2026-06-14-firstparty-entitlements-plan.md`
- 子系统接入契约(替换了旧 `oauth-integration-guide.md`,已 git rm):`docs/subsystem-integration-guide.md`
- 本文档:接力索引

## 已定决策(不要重新 brainstorm,直接落地)

1. **第一方 ≠ 第三方,按拓扑分道**:① 同账户 `*.cqu.moe` Worker = 共享 cookie + Service Binding RPC(日历/教评**主线**);② `*.cqu.moe` 非 Worker = cookie + JWT;③ 别的域/浏览器插件 = OAuth+PKCE。自家 client 一律 `skipConsent`。
2. **分级 = per-user entitlements**(不是 tier!):事实源是 `user_entitlement(userId,subsystem,capability,value)` 表,admin 直接按用户授予;能力分 **flag(布尔)** 与 **quota(直接存数字,null=无限)**;能力目录用 **TS 常量(方案 A)** `src/capabilities.ts`;**预设保留**作 admin 一键套用便利(非事实源)。caps 经 `customSession`(SPA)+ `customAccessTokenClaims`(JWT,按 client→subsystem 只盖该片)下发,子系统**只读 boolean/数字**。
3. **CQU 取票 = 按子系统最小权限**(沿用现有 `oauth_client_cqu_scopes` 双层校验),**caps 不参与普通取票**。
4. **离线取票**:DO 常驻 CAS 会话,用户不在场也能出票;拓扑① 后台直接 RPC,②③ 用 `offline_access` refresh token。
5. **浏览器插件快捷登录 = 方案 b**:落 `sso.cqu.edu.cn/login?service=XXX` → 取 XXX 的 ST → 跳 `XXX?ticket=ST`。**不导出 TGT**。auth 侧只需:`?serviceUrl=` 接口 + 严格 host 校验 + `cqu:ticket:any` scope + `cqu.quicklogin` per-user opt-in。**插件本体不在本仓库范围。**

## 未完成项

### 1. 🔴 执行实现计划(主线)
按 plan 推荐顺序 **A1→A2→A3→B1→B2→B3 → D1→D2→D3→D4→D5→D6 → C1→C2 → B4**。Phase A/B 不改取票行为(可先全链路验证 caps);Phase D 是取票安全核心。

### 2. 🟡 待用户确认:日历/教评是否真走拓扑①
设计按「① 同账户 `*.cqu.moe` Worker」作主线写。若某子系统其实是 VPS/别栈,降级到②(同套设计兼容,身份从 RPC 实时改 JWT 离线)。不阻塞 Phase A/B/D,只影响 C 的接线对象。

### 3. 🟡 实现期需 Context7 核对的 API(训练记忆可能过时)
- better-auth `jwt` 插件 payload 定制钩子名(`definePayload`?能否拿 client_id) — Task B2。
- `advanced.crossSubDomainCookies` + `trustedOrigins` 当前用法 — Task C1。
- `WorkerEntrypoint` RPC + service binding 当前写法,**且单 Worker 能否同时 export Hono fetch + WorkerEntrypoint**;不行则拆 `auth-internal` Worker 或 RPC 走内部 HTTP — Task C2。

> 注:文档已过一轮对抗式审查(技术可行性/安全/一致性),下列红线是审查后加固结论,直接遵循。

## 关键技术红线 / 坑(避免重新踩)

- **serviceUrl 校验是全局最敏感处**(CVE-2022-39369 ST-relay,CVSS 8.0):解析前拒 `\` 与非 ASCII;`new URL()` 后判**解析后** hostname、https-only、拒 userinfo/异常端口、强制 ToASCII、拒尾点;**裸 `endsWith` 禁用**;**只返回/只用 canonical `href`**(round-trip 不是安全控制)。Task D1 绕过向量一个都不能少。
- **DO 是唯一万能闸**:host 校验 + `cqu.quicklogin` opt-in + 限流 + 审计**全部落 `DO.getServiceTicket`**——route/RPC/cookie 三入口都汇于此,放路由层会被 RPC 直调绕过。
- **cookie 绕过缺口(两层)**:`scope.ts:12-14` 无 Bearer 直接 `next()` + `cqu.ts:10-35` 收 cookie → 今天 cookie 用户能取 4 个符号 key 票而无授权校验。修复要**同时**关符号 key 授权(no-Bearer 不再 blanket next)和 serviceUrl host 校验(Task D3)。
- **JWT caps 最小披露是安全属性**:钩子拿不到 client_id 时**禁止盖全量**(泄露完整能力图给 XSS 可达的插件 client),只能盖空 `caps:{}` 或改 oauthProvider token 钩子(Task B2);`cqu.quicklogin` 别盖进 SPA 会话(Task B1 排除 `cqu`)。
- **`cqu:ticket:any` 爆炸半径**:`*.cqu.edu.cn` 可能含 open-redirector → 逼近 TGT;优先正向 URL 白名单,否则短 TTL(5–15min)+ 监控 distinct host + 审计(设计 §6.5)。
- **RPC clientId 必须鉴权**:持广域 scope 的 RPC 调用要验 clientId(client_secret/binding 映射),不能只自报(Task C2)。
- **D1 迁移**:App 自有表(`user_entitlement`)用 `db:generate`;只有 Better Auth 表才手写 SQL;`sql\`(datetime('now'))\`` 必须 `sql` 包裹;App 表走 drizzle/d1,Better Auth 表走 `(await auth.$context).adapter.*`。
- **admin 权限坑**:`statement` 仍 spread `defaultStatements`,superAdmin 仍 spread `adminAc.statements`,否则内置端点 FORBIDDEN→伪装 500。
- **部署**:push main 即生产部署 + 迁移;开发在 worktree/分支推进。换域名同步 `BETTER_AUTH_URL` + `trustedOrigins`。
- `src/services/cqu-sso.ts:94-127` 的 `getServiceTicket(cookies, serviceUrl)` **已接受任意 URL,保持不改**(校验全在上层)。

## 建议技能(suggested skills)

- `superpowers:executing-plans` — 逐任务执行 plan(主入口)。
- `superpowers:test-driven-development` — 每个可单测任务先写失败测试(尤其 Task D1/A3)。
- `superpowers:subagent-driven-development` — 若本 session 内派子 agent 逐任务实现 + review。
- `context7-mcp` / Context7 MCP — 核对 better-auth jwt/cookie/RPC 当前 API(上方未完成项 #3)。
- `cloudflare:durable-objects` + `workers-best-practices` — 改 DO 取票分支 + RPC entrypoint 时。
- `better-auth-best-practices` — caps 下发钩子(customSession/jwt/customAccessTokenClaims)。
- `claude-md-management:revise-claude-md` — 实现后同步 CLAUDE.md。

## 备查:为什么这么设计(一句话)

业界一致:第一方静默授权非 hack(MS/Auth0/Keycloak/Logto)、分级用 entitlements 而非 ReBAC(无关系图/单租主)、ST-relay 必须 redirect_uri 式精确校验(RFC 9700 / CVE-2022-39369)。详见设计文档附录。
