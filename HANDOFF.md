# Handoff — Codex 多轮 review + 双盲核验 + 14 项加固已实现并双审,待真节点 e2e 冒烟

> 取代上一版("待 Codex 多轮 review")。本会话:Codex 5 轮 review → 双盲独立核验(0 误报)→ subagent-driven 实现 14 修复 + H1 注释订正 → 每任务 spec+quality 双审 + 最终整体审查(Ready for production)。**故意未 merge**(push main = 自动部署生产;merge 前仍欠真节点 e2e 冒烟 + H1 机制验证)。

## 一句话
对 PR #10(浏览器水化取票/keepalive,砍青果)的加固分支,本会话用 Codex(gpt-5.5 xhigh)跑 5 轮聚焦 review,对 15 条去重发现做**双盲独立核验**(每条 2 个互不知情 agent 读真实代码,**0 误报**),按用户定的"A+B 全部竭尽"范围用 **subagent-driven-development** 串行实现 14 项修复 + H1 注释订正,每任务过 spec 合规 + code quality 双审(发现回填),最后一道整体审查判 **Ready for production**(待 out-of-scope 的真节点项)。

## 当前状态
- 分支 `feat/cqu-login-cn-node-proxy` = **PR #10**(https://github.com/cqu-moe/auth/pull/10),**已 push**(HEAD = 本轮 docs 提交);OPEN,未 merge。feature 分支 push 只触发 `versions upload`(0 流量版本),**不部署生产**;只有 merge/push `main` 才经 GH Actions 部署接管 auth.cqu.moe。
- 工作树:干净(本 HANDOFF 这次更新除外)。
- 绿基线(本会话实跑,432 测试):

```bash
npm run typecheck && npm run typecheck:do      # 两个 tsconfig(根 + test/),都要干净
npm run test                                   # vitest Node pool, 266 passed
npm run test:do                                # vitest Workers pool(DO 集成), 10 passed(启动期 stderr 噪音是预期的,exit 0)
cd container && python3 -m pytest -q           # 节点 Python, 156 passed
```

## 本会话提交(`bedcba6..HEAD`,全 SSH 签名 G)
| commit | 任务 | 内容 |
|---|---|---|
| `2413681` | T1 | 取票 helper:M1 abort host 规范化比对(host 小写+443≡无端口)+ allowlist 返 canonical;M2 排除 CAS 自身不 abort 初始导航;M4 cleanup 移出持槽窗口(release-before-cleanup)+ 注释订正;M3 start() 取消清理;H1 abort 注释订正 |
| `44d1d76` | T2 | 节点端 `/service-ticket` 异常脱敏(body+log 只回类型名,H5 根因)+ keepalive 外层 catch log 脱敏(M9)+ `/run` 套 `is_allowed_service_url`(H3 纵深) |
| `a18aab7` | T3 | TS 纯函数层:`TGT_EXPIRED→409`(H4 映射)+ `classifyNodeTicketResponse`/route 不回显节点派生串(H5 纵深)+ `hasValidTgt` 三件套(M5,satisfies 编译期绑定 CasCookies) |
| `180217e` | T4 | DO 方法体:`putStateGuarded` 真守卫绝不抛穿 alarm(H2)+ 防复活 check-and-set 覆盖三写回分支(M7)+ recordKeepaliveMint 审计先于 put 不冒泡(M6)+ legacy 取票 setAlarm 加速(M8)+ catch TGT_EXPIRED setAlarm+re-throw(H4 接法)+ relogin 回写套 hasValidTgt(M5);抽纯谓词 TDD;审计行抽 helper 防 schema 漂移 |
| `3e02d3a` | T5 | 引入 `@cloudflare/vitest-pool-workers` DO 集成测试(独立 `vitest.workers.config.mts`+`test:do`)锁 H4(409 非500+setAlarm)/M7(revoke 不复活,control 组反证)/transient/H2;不破坏 Node pool |
| `3c6480b` | 收尾 | alarm 分支 2 条澄清注释(H4 不 setStatus / proactive 不重 put) |
| `4210395` | docs | 计划文档 + 上一版 HANDOFF |

## 核验阶段的关键结论(已落实进实现,别推翻)
1. **ST 事实源是 sniffer 从 CAS 302 `Location` 头抓取,不靠 route abort 拦截。** 故 H1 abort 即使对 redirect no-op,取票也不破(无-abort 旧版 R1/R2 实测可用);abort 仅"别让 ST 被送达核销"的功能正确性纵深,**非 ST-relay 安全闸**(真红线是 `is_allowed_service_url` 的 `*.cqu.edu.cn` 白名单)。→ H1 本次只订正注释,机制留 e2e;M1 定性为功能正确性非安全。
2. **M5 无可达利用路径**:回写只在 alive 分支、alive⟺浏览器刚铸票成功⟺state 完整,"半残态"与 alive 自相矛盾。M5 仅纵深加固。
3. **H4/M7/M3/H1机制 是既存(非本 diff 引入)**,本 diff 加重了它们,用户选竭尽全修。
4. 双盲核验 **0 误报**:15 条代码事实全坐实,分歧只在严重度/verdict 标签。原始判决(15 条 × 2 agent)在本会话 Workflow 输出 `tasks/wnmeu24v4.output`(session transcript dir;需回看仲裁依据时用)。

## 未决 / 剩余风险(merge 前必过,需真节点)
- **2 条 e2e 冒烟仍欠**(仓内零证据;见 `docs/plans/2026-06-17-...-plan.md` 验收清单):
  ① **ST 未被消费**——浏览器对目标 host `abort()` 是否真没把一次性 ST 送达核销(取票后用同 `serviceUrl?ticket=<ST>` GET 断言 ST 仍可校验 / 或 abort 计数 vs 发出计数)。
  ② **keepalive 60min 保鲜链路**——回吐 refreshed state 的瑞数 cookie 是否真刷新、刷新后取票仍 200。
- **H1 机制**:patchright 顶层导航重定向 abort 是否真生效——静态判不出,需真节点抓 network trace。**即便不生效也不破取票(sniffer 兜底)、不破 ST-relay 防线(allowlist 兜底)**,故已降级为非阻塞。
- **未集成测试覆盖**(已知):真 input-gate 并发交错(DO I/O 隔离禁,M7 用"同一 storage 写 revoked"因果近似)、`/run` 2FA 往返、>90s 真超时。

## 下一步
1. 真节点跑上面 2 条 e2e 冒烟 + H1 机制验证。节点测试脚手架(成都 IDC VPS、systemd-run 长任务、`op run` 注入青果 env、机密只经文件 stdin)见 `git show 4f1cfd9:HANDOFF.md`。
2. e2e 全过 → merge main(= GH Actions 自动迁移+部署生产)。

## 环境 / 坑(本会话踩过)
- **Bash cwd 跨调用残留**:`cd container` 后,后续 git 命令要先 `cd /Users/uu/Documents/Coding/cqu-moe/auth`,否则路径重复(`container/src/...` not found)。
- **提交走 1Password SSH 签名**:1Password 锁定时报 `failed to fill whole buffer` → 让用户解锁(终端)。**用默认 git 身份,禁 `-c user.*`/`--author` 覆盖**。
- **vitest 双 pool**:`npm run test`(Node pool,纯函数,`src/**/*.test.ts`)与 `npm run test:do`(Workers pool,DO 集成,`test/do/**`)include 互斥,互不干扰。`@cloudflare/vitest-pool-workers@0.16.9` 与 vitest 4.1.7 兼容;0.16.x 用 `cloudflareTest()` 插件(非旧 `defineWorkersProject`);配置须 `.mts`(仓库非 ESM);`LOGIN_NODE` 是 vpc_services remote → `remoteBindings:false` + `vi.spyOn(env.LOGIN_NODE,"fetch")` mock(DO 的 `this.env.LOGIN_NODE` 与测试 `env.LOGIN_NODE` 同隔离区同对象);DO I/O 隔离禁真跨 DO 交错。
- **DO 方法体 Node pool 测不了**(`import cloudflare:workers`)→ 可判定逻辑下沉 `src/services/cqu-node-protocol.ts`(无 cloudflare 依赖)先 TDD,时序行为用 vitest-pool-workers。
- **DO storage(KV-backed,`new_classes`)单 value 硬上限 128KiB**;完整 storageState 体量不受控 → `putStateGuarded` 真守卫(超限丢刷新态保旧态,绝不抛穿 alarm,否则 keepalive 豁免限流 → 重复铸票环)。alarm handler 抛异常 → CF 自动重试;非 storage I/O(fetch)await 期间 input gate 开 → revoke 可交错 → 写回前须 check-and-set。

## 敏感信息提醒
- 测试账号密码**曾在更早历史对话出现,建议轮换**(密码不在本仓任何文件)。节点机密经 1Password Service Account 注入,磁盘零明文(见项目记忆)。

## Suggested skills(下个 session)
- `verify` / `webapp-testing` / `agent-browser` — 真节点 e2e 冒烟(SSH 进成都 VPS 或节点侧跑取票脚本抓 network trace)。
- `cloudflare:durable-objects` — 扩充 DO 集成测试(vitest-pool-workers 基建已落地)。
- `superpowers:test-driven-development` — e2e 出需修项时(纯函数先 TDD)。
- `superpowers:finishing-a-development-branch` — e2e 过后 merge main。
- `codex` / `superpowers:receiving-code-review` — 若再跑一轮 Codex 复核。

## 参考
- PR #10:https://github.com/cqu-moe/auth/pull/10
- 本轮计划/任务:`docs/plans/2026-06-22-codex-review-hardening-plan.md`
- 设计/旧计划(含 e2e 冒烟验收清单):`docs/plans/2026-06-17-cqu-browser-ticket-rehydration-{design,plan}.md`
- 纯函数协议层:`src/services/cqu-node-protocol.ts`(+`.test.ts`);DO 集成测试:`test/do/`
- 项目记忆:`~/.claude/projects/-Users-uu-Documents-Coding-cqu-moe-auth/memory/project_cqu_login_cn_node_proxy.md`
