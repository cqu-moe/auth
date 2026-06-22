# 计划 — Codex 多轮 review 加固修复(PR #10)

> 来源:Codex 5 轮 review(15 发现去重)→ 双盲独立核验(每条 2 个 agent 读真实代码,0 误报)→ 用户定范围"A+B 全部竭尽"。
> 执行方式:subagent-driven-development(每任务 implementer + spec 审 + quality 审 + 修正循环,串行)。每任务 implementer 走 TDD。
> base SHA(本次加固起点):`bedcba6`。分支 `feat/cqu-login-cn-node-proxy` = PR #10。
> **不在范围**:H1 的"abort 是否真不核销 ST"机制验证(需真节点 e2e,仅订正误导注释);测试账号 e2e 冒烟(需真节点)。

## 核验阶段的关键纠偏(实现时必须据此,勿回退到 Codex 原始定性)

1. **ST 的事实来源是 sniffer 从 CAS 302 `Location` 头抓取,不是靠 route abort 拦截。** 故:
   - H1:abort 即使对 redirect target no-op,取票也不破(无-abort 旧版 R1/R2 实测可用)。abort 只是"别让浏览器把一次性 ST 送达目标核销"的**功能正确性**纵深,非取票 load-bearing 路径。本次只订正注释,机制留 e2e。
   - M1:abort host 比对不一致是**功能正确性** bug(漏拦致 ST 可能被送达核销→取票失败),**不是 ST-relay 安全漏洞**(真正的 ST-relay 红线是 `is_allowed_service_url` 的 `*.cqu.edu.cn` 白名单;即便 abort 失配,ST 也只会送到已过白名单的合法 CQU host)。
2. **M5 的"半残 state 覆盖好 state"无可达利用路径**:回写只在 alive 分支,而 alive ⟺ 浏览器刚过瑞数铸票成功 ⟺ `storage_state()` 必完整;"TGT 在但瑞数 cookie 缺"与 alive 自相矛盾。M5 仅作纵深加固。
3. **H4 / M7 / M3 / H1机制 是既存(非本 diff 引入)**,但本 diff 加重了它们(keepalive 改真铸票/回写 state),用户选竭尽全修。实现时心里有数:这些是"修既存+本 diff 加重"。
4. **RPC 入口已安全**(`rpc.ts` 只回 `err.code` 不回 message),H5 泄露仅经 route 入口;修复以节点侧脱敏为根因,DO/route 侧为纵深。

---

## 任务划分(按文件分组,串行执行;T1→T5)

### T1 — 容器取票 helper 修正(`container/cqu_ticket_browser.py` + `container/server.py` 的 M1 部分)

**覆盖发现:M1(low,功能正确性) / M2(low) / M4(low) / M3(low,纵深) / H1-注释订正。**

**改动:**
1. **M1 — host 比对规范化**:`service_host_of` / `should_abort_request` 改用规范化元组比较 `( (u.hostname or "").lower(), 端口归一(None==443) )`,不再用原始 `netloc` 字符串。同时让 `container/server.py` 的 `is_allowed_service_url` 通过后**返回 canonical URL**(小写 host、去 :443),`service_ticket_handler` 把 canonical 值传给 `fetch_service_ticket_browser`/`_hydrate_navigate`,使整链口径单一。保持 `service_host` 为空时 fail-open(不误拦)的现有语义。
2. **M2 — 排除 CAS 自身**:`should_abort_request` 当 `request_url` host == SSO host(`sso.cqu.edu.cn`)时**绝不 abort**(放行瑞数+CAS `/login` 初始导航)。(上游红线侧的 SSO 黑名单放 T3 的 service-url 校验,不在本任务。)
3. **M4 — 注释订正 + deadline 对齐**:(a) 订正 `cqu_ticket_browser.py` 顶部与 finally 内关于"持槽 45s/总 80s/预算被外层超时吞并"的失实注释,改为真实取消语义:`asyncio.wait_for` 超时取消后,finally 内的 `close(10s)`/`stop(5s)` 是**加性**消耗,持槽最坏 = overall_timeout+10+5 ≈ 60s、总最坏 ≈ 95s。(b) **二选一对齐**(实现者选更稳的):优先把 close/stop cleanup **移出持槽窗口**(先 `TICKET_SEMAPHORE.release()` 再 cleanup),使持槽回到 ≤45s 与注释一致;若改动风险大则改为把 `NODE_DEADLINE_MS`(在 `src/services/cqu-node-protocol.ts`)提到 ≥ 真实上界(35+45+10+5=95s,留余量 ~100-105s)并同步订正 `cqu-node-protocol.ts` 顶部"节点最坏≈80s"注释。**注:若选后者会动 TS 文件,与 T3 有文件重叠——优先选前者(纯容器侧 release-before-cleanup)。**
4. **M3 — start() 取消清理**:用 `pw=None; try: pw=await async_playwright().start(); ... finally: if pw: await wait_for(pw.stop(),5)` 包裹,使 `start()` 内部被取消(pw 仍 None)时也有清理路径;best-effort 即可(patchright 在 start 未完成态未必能完全干净停,接受)。
5. **H1-注释订正**:把代码里把 abort 描述成"防 ST 被核销的防线"的注释,改为真实语义:"sniffer 从 302 `Location` 头抓 ST 是事实源;abort 仅尽力拦页面后续向目标服务发起的请求,对顶层导航重定向 patchright 不保证拦截(待 e2e 锁定)"。

**TDD(pytest,`container/test_cqu_ticket_browser.py` 等):**
- M1:`service_host_of("https://my.cqu.edu.cn:443/x")` 与 `should_abort_request` 对 `https://my.cqu.edu.cn/x?ticket=ST` 判定一致(大写/`:443`/无端口三变体都对齐);新增 upper/443 mismatch 回归用例(先红)。
- M2:`should_abort_request("https://sso.cqu.edu.cn/login?service=...", service_host="sso.cqu.edu.cn")` 返回 False(放行初始导航)。
- M3/M4:cleanup 顺序/超时为时序行为,记为 e2e/manual;注释订正无需测试。M1/M2 是纯函数必须 TDD。

**验收:** typecheck 无关;`cd container && python3 -m pytest -q` 全绿且新增用例覆盖 M1/M2。

---

### T2 — 容器节点端脱敏 + /run 纵深(`container/server.py` + `container/cqu_login.py` + `container/test_keepalive.py`)

**覆盖:H5(medium,节点侧根因) / M9(low) / H3(low,纵深)。**

**改动:**
1. **H5(节点侧根因)**:`server.py` 的 `service_ticket_handler` 两个 except 分支(transient 502 / expired 409)**不再回 `str(e)`**,也**不再 `log.warning("...: %s", e)` 打原始异常**;改为返回稳定错误码/异常类型名(对齐 `keepalive` handler 的脱敏:`type(e).__name__` 或固定串如 `"transient"`/`"session_expired"`),日志同样只打类型名。`ExpiredError`/`NoTicketError` message 是常量可保留或收敛为类型名。
2. **M9**:`server.py` keepalive 外层兜底 catch 的 `log.warning(..., %s, e)` 改为只记 `type(e).__name__`(body 已脱敏,补齐 log)。
3. **H3(纵深)**:`run_handler` 在取到入参 `service` 后、调 `run_login` 前加 `if not is_allowed_service_url(service): return 400`(复用 T1 已规范化的同一纯函数,与 `service_ticket_handler` 对齐),消除 `/run` 与 `/service-ticket`/`/keepalive` 的不对称。**不改 DO 契约**(DO 本就只传 DUMMY_SERVICE)。

**TDD(pytest):**
- H5:新增 `test_service_ticket` 用例——构造 `_hydrate_navigate`/分类抛出含敏感串(如 `"SOURCEID_TGC=xxx"`)的异常,断言 `/service-ticket` 响应体**不含**该敏感串(只含类型名/稳定码);用 `assertLogs` 断言**日志不含**该敏感串(先红)。
- M9:`test_keepalive.py` 加 `assertLogs` 断言 keepalive 外层 catch 日志不含 secret(先红)。
- H3:`test_service_url_allowlist.py` 或新增,断言 `/run` 对非 `*.cqu.edu.cn` 的 `service` 返回 400(先红)。

**验收:** `python3 -m pytest -q` 全绿,新增 H5/M9/H3 用例。

---

### T3 — TS 纯函数层(`src/services/cqu-error-status.ts` + `src/services/cqu-node-protocol.ts` + `src/routes/cqu.ts`)

**覆盖:H4(纯函数映射部分) / H5(DO/route 侧纵深) / M5(hasValidTgt 强化)。**

**改动:**
1. **H4(映射)**:`cqu-error-status.ts` 把 `TGT_EXPIRED` 加入 `CODE_TO_STATUS` 映射为 **409**(可行动态,语义同 `SESSION_INACTIVE`/`NEEDS_REAUTH`),让 route/RPC 调用方拿到 409 而非伪装崩溃的 500。
2. **H5(纵深)**:`cqu-node-protocol.ts` 的 `classifyNodeTicketResponse`(及相关)**不把 raw `body.error` 拼进 detail**,改为只记 `status` 或对 `body.error` 过 `sanitizeNodeDetail`(该函数已存在,目前仅 keepalive 用)。`src/routes/cqu.ts` 对 WAF_CHALLENGE/TGT_EXPIRED 等不把 `err.error` 原样回客户端,只回 `code`(对齐 `rpc.ts:188`)。
3. **M5(强化)**:`hasValidTgt` 升级为"关键 SSO cookie 组合存在"——要求 `SOURCEID_TGC` + `SESSION` + `rg_objectid` 三件套(对齐 `cqu-sso.ts` 的 `CasCookies`/3-cookie 契约),而非只查 `SOURCEID_TGC` 非空。(是否强制 origins 非空取决于真节点实测哪些 localStorage load-bearing → 不在静态层硬编码,留 e2e。)

**TDD(vitest Node pool,`*.test.ts`):**
- H4:`cqu-error-status` 新增 `TGT_EXPIRED → 409` 断言(先红)。
- H5:`cqu-node-protocol.test.ts` 新增——含敏感串的 `body.error` 经 `classifyNodeTicketResponse` 后 detail **不含**该敏感串(先红)。
- M5:`hasValidTgt` 对"仅 SOURCEID_TGC、缺 SESSION/rg_objectid"返回 false;三件套齐返回 true(先红)。

**验收:** `npm run typecheck` 干净;`npm run test` 全绿,新增 H4/H5/M5 用例。

---

### T4 — DO 方法体(`src/durable-objects/cqu-session.ts`)

**覆盖:H2(medium) / M7(medium) / M6(low) / M8(low) / H4(DO 接法) / M5(回写校验接法)。**

**改动:**
1. **H2 — putStateGuarded 变真守卫**:以**真实硬限 ~128KiB**(与 100KiB 告警阈值分离)判定:超限时**不让 `put` 抛穿 alarm**——keepalive 回写路径**丢弃刷新 state、保留旧 state**(旧 state 已能取票,刷新只是续期)并照常 `setAlarm` 继续保活;所有 put-state 处用 try/catch 兜底,捕获写入失败降级(保旧态+排下次 alarm),使 alarm **永不因 state 落盘失败而抛进自动重试**。同缺陷在 `getServiceTicket`(热路径)/`relogin` 回写处一并降级,避免热路径 500。
2. **M7 — 防复活(check-and-set)**:`runKeepAlive()` 返回后、写 active 前**重新读 status**;若 cur ∈ {revoked, unbound, needs_reauth}(或与 alarm 进入时快照不符)则直接 return,放弃本轮 `setStatus("active")`/`putStateGuarded`/`setAlarm`。**expired→relogin 分支与 proactive-relogin 分支同样补此守卫**(relogin 后只查 needs_reauth 不查 revoked 是漏的)。
3. **M6 — 审计与记账解耦**:`recordKeepaliveMint` 内**先无条件打 `st_mint` 审计 `console.log`**(已铸票是既成事实),再 try/catch 包住 `storage.put("stMintLog")`;put 失败补打 `recorded:false` 告警**并吞掉异常不向 alarm 冒泡**(catch 范围只罩自身 put,勿吞 runKeepAlive 其它需冒泡异常)。
4. **M8 — legacy 取票加速自愈**:`getServiceTicket` 的 `!this.state.storageState` legacy 分支抛 `SESSION_INACTIVE` 前,加 `setStatus("expired")` + `setAlarm(Date.now())`(复刻 `unrevoke()` 现成模式),把退化窗口从 ≤1 keepalive 周期压到下次 alarm tick。**仍严守"绝不把旧 3-cookie 当 storageState 发节点"**(本就没发,保持)。
5. **H4(DO 接法)**:`getServiceTicket` 调 `mintServiceTicketViaNode` 处 catch `CquSsoError && code==="TGT_EXPIRED"` 时 `setAlarm(Date.now())`(把下轮 keepalive/relogin 提前,复用 relogin 的 single-flight,**不在热路径同步重登**——会阻塞 DO 单线程+2FA 邮件往返数分钟)。配合 T3 的 409 映射,route/RPC 拿到 409 且系统快自愈。
6. **M5(回写接法)**:`relogin` 回写(直接 `fresh.storageState = result.state`)也套 T3 强化后的 `hasValidTgt` 完整性校验(目前只靠 `!result.state` 兜空)。

**测试策略:**
- 能抽**纯函数**的逻辑(守卫判定阈值、check-and-set 的状态判定谓词、记账解耦的顺序契约)抽到 `cqu-node-protocol.ts` 或新纯函数文件,**vitest Node pool TDD**。
- 方法体内时序行为(alarm 重试、input-gate 交错、put 落盘失败降级)**记为 T5 的 DO 集成测试**(Node pool 不能 import DO)。
- 同步更新 `CLAUDE.md` 的 doc drift:"15 分钟 alarm" → 实际 60min(`KEEPALIVE` 间隔)。

**验收:** `npm run typecheck` 干净;`npm run test` 全绿(新增纯函数用例)。方法体行为待 T5 集成测试覆盖。

---

### T5 — DO 集成测试基建(`@cloudflare/vitest-pool-workers`)

**覆盖:L1(low) + 回归锁住 T4 的 H4/M7/H2 方法体行为。**

**改动:**
1. 引入 `@cloudflare/vitest-pool-workers`,新建独立 vitest 配置/项目跑 Workers pool(当前 `vitest.config.ts` 只用 Node pool,不能 import `cqu-session.ts`)。**不破坏现有 Node pool 测试**。
2. 集成用例(mock `env.LOGIN_NODE.fetch`):
   - **H4/L1**:节点 409 → 断言 DO `/service-ticket` action 返回 HTTP **409**(非 500)、断言 `setAlarm` 被排(快自愈)、断言 on-demand 不同步重登。
   - **transient**:节点 502 / `AbortError` → 断言 status **不变**、走退避、**不**触发重登。
   - **M7**:keepalive fetch 期间注入 revoke → 断言回来后**不复活**(status 仍 revoked、不 setAlarm)。
   - **H2**(尽量):超大 refreshed state → 断言不抛穿 alarm、保留旧 state、不重复铸票。

**验收:** 新 Workers pool 测试全绿;`npm run test`(Node pool)仍全绿;`npm run typecheck` 干净。

---

## 全部任务后

1. 派 final code-reviewer 审整个 `bedcba6..HEAD` 加固 diff。
2. 走 `superpowers:finishing-a-development-branch`。
3. 更新 `HANDOFF.md` + 项目记忆:本轮 Codex review + 核验 + 修复落定;剩余 H1 e2e + 2 条 e2e 冒烟仍需真节点。
4. **不 merge**(push main = 自动部署生产);merge 前仍需真节点 e2e 冒烟(HANDOFF 已列)。
