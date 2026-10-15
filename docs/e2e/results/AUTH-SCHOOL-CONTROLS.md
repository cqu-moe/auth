# AUTH-SCHOOL-CONTROLS

2026-10-16。已修复最终审查接受的 P2：学校负控必须命中指定测试、指定断言及指定失败原因；其他失败、额外错误或清理失败不能算负控成功。**最终干净签名源码的真实三项 self-check 通过；未运行完整学校套件，未修改 integration、推送或创建 PR。**

## 版本与范围

- 私有 worktree：`/Users/uu/Developer/cqu-moe/.agent-worktrees/e2e-20261015/tickets/AUTH-SCHOOL-CONTROLS`。
- Branch：`codex/e2e-20261015-auth-school-controls`；创建前确认没有同名 branch/worktree，未复用他人目录。
- 固定原始提交：`45ddb371495974dcfc86dbabb2c340183cfc7988`。
- 首次签名修复：`64122740da6a2406719056eb02c6f92b34c497c3`。
- **最终实际测试源码：`d0ba5c2143643f697e7173143cfb8d440e58d0c0`**。框架 `vcs.dirty=false`，真实 assertion runtime 前后源码指纹相同：`641e1728e9bac70caf80077fc3b997be6d63c351082f8ea23f9879913249608f`。
- 后续报告/证据提交只归档本报告及产物，不再修改这三个执行/说明文件；其实际最终 tip 由根报告补记。

读 root/repo AGENTS、RTK、实施合同、Auth spec/AUTH-03 及最终独立审查、开发约定、完整 self-check/runner/旅程/实际历史报告；使用 test-audit 和 worktree-flow。节点版本 Node `22.22.3`，继续固定 `e2e@0.21.0` / web `0.15.0` / Miniflare `4.20260521.0`，从已准备 AUTH-OAUTH-CI 克隆复制依赖到本票，未改写其他 checkout、锁文件或共享依赖。

生产修改 **0**。相对 45ddb，执行/说明差异仅三个 school 文件 `+98/-20`：

- `control-evidence.mjs`：专用于现有三个学校控制的收据核对，不运行/替代业务，也不提供通用框架。
- `self-check.mjs`：保留原三个真实命令和 exit1 要求，调用上述核对；只有三项全部通过才写 `controls.json`。
- `README.md`：说明控制接受边界和收据。

## 收口行为与 test-audit 归属

学校 self-check 是该失败控制命令的 owner，CI 原有 school job 已调用它。正常业务套件无法证明“故意破坏失败”是否因预期原因失败；本补丁保护这个独立门禁，不重复学校业务断言，没有新增生产 flag、导出、API、schema 或内部 mock。

| 控制 | 现在必须满足 |
| --- | --- |
| assertion | sole selected test 的 `testId/file/titlePath/targetId` 精确为 mobile 学校绑定主旅程；选中/执行/失败各 1，其他结果计数 0；唯一 attempt 为 body/test/`ASSERTION_FAILED`，消息包含 `故意错误的学校绑定入口`，实际 locator/expected/observed/matches 与该预敏感断言一致；无 framework run、secondary、runtime、artifact 或 cleanup 错误；保留真实截图。 |
| zero | 真实 runner.log 只有 `configuration error NO_TESTS (collection)`；实际收集并全部被指定空 grep 排除、no tests executed、仅 1 error；框架确实未写 report，runner 记录相应 ENOENT；runtime 清理完成。允许历史 `scenarios` 和当前 `framework-report` 两种已实证阶段，但 failure.stage 必须与实际 stage 一致。 |
| pin | 真实启动失败对象精确为 `Auth commit does not match the pinned dependency`；startup/not-started，无 runtime resources、artifact/cleanup 错误。 |

## 旧误接受 → 新拒绝的真实收据边界证据

[回放结果](AUTH-SCHOOL-CONTROLS-evidence/readback/readback.json)和[原命令脚本](AUTH-SCHOOL-CONTROLS-evidence/audit/readback.mjs)已归档。实际 `node .e2e/control-review/readback.mjs` exit0，**17 checks**：

1. 从真实历史 `AUTH-04/.e2e/oauth-negative-1792079417393/assertion-mobile/mobile/1-d0d928b0d053` 复制未经改写的 report/runtime/log/PNG；该 OAuth 预敏感失败实际 runnerExitCode=1、runtime.result=failed、cleanup passed、directoryRemoved=true，只有一个执行/失败和真实 PNG。
2. 直接从固定 45ddb 的 `git show ...:e2e/school/self-check.mjs` 提取旧收据接受代码执行，不重写一份旧判断。**旧代码接受**该真实但与学校负控无关的失败；新生产自检实际使用的 `checkSchoolControl` **以 Unexpected selected school test 拒绝**。输入文件与原历史文件逐字节一致，hash/源路径列在 readback.json；只调整归档目录布局，未伪造业务失败或改写错误。
3. 真实历史本机 `school-negative-1792068166920` 与已下载学校 Linux CI `38750075601` 的 `school-negative-1792075483794`，各三项原控制均被新 checker 正确接受。15 份实际来源 report/runtime/runner 文件保留 SHA-256。
4. 另 10 个明确标记为 **derived receipt-corruption** 的边界控制，分别证明错断言原因、错 code、错 observed、额外 run error、secondary error、attempt cleanup、runtime cleanup、artifact error、无关 collection error 和无关 startup error 均拒绝。这些是收据验证器输入边界检查，不冒称额外真实浏览器运行；它们与第 1 项未经改写的真实回归证据分开存放。

这个回归证明的是旧自检可接受错误旅程的失败产物，不声称原学校负控历史运行曾真的发生该误归因。

## 一次最终真实三项自检

先前在 `6412274` 的首次真实尝试保留为 `first-attempt/`：assertion 的故意失败和清理正确，zero 也真实 NO_TESTS，但新 checker 最初只接受历史 `scenarios` 阶段，当前 runner 已使用 `framework-report`，外层因此 exit1，未执行 pin。该失败没有被改判通过。

修正这一实际元数据兼容问题并签名到 d0ba5c2 后，重新完成所要求的 **一次最终固定源码三项自检**。这是有已观察失败理由的定向重验，没有重复正常九旅程/完整学校套件。

| 最终实际输出 `.e2e/school-negative-1792087982965` | 结果 |
| --- | --- |
| 外层 self-check | **exit0**，仅三项全部核对后生成 `controls.json`。 |
| assertion | 内部 exit1；发现9、选中/执行/失败1，passed/skipped/interrupted/flaky0；精确学校 `ASSERTION_FAILED` 和故意文本，实际 heading 为 `欢迎回来`；单 attempt cleanup complete、secondaryErrors=[]、run.errors=[]；runtime cleanup passed、sourceUnchanged=true。 |
| zero | 内部 exit1；实际 NO_TESTS、零执行、无 report；框架报告读取阶段 ENOENT 与原始日志同时保留；runtime cleanup passed。 |
| pin | 内部 exit1；精确 commit mismatch，startup/not-started，没有分配 runtime。 |

[最终控制收据](AUTH-SCHOOL-CONTROLS-evidence/final-native/controls.json)、[最终原始日志（gzip）](AUTH-SCHOOL-CONTROLS-evidence/audit/final-self-check.log.gz)、[实际浏览器观察](AUTH-SCHOOL-CONTROLS-evidence/audit/final-native-driver.json)、[清理独立核对](AUTH-SCHOOL-CONTROLS-evidence/audit/cleanup-verify.json)。

实际观察本票私有 TMPDIR 下的 Chromium PID **41469**，`headless/basic password store/mock keychain` 均为 true，profile `playwright_chromiumdev_profile-AodUcj`。退出后该 PID 和准确 profile 均消失，私有 worktree `.auth-e2e-*` 目录为 0。没有读取用户浏览器 profile 或密钥链；既有 1Password 仅用于用户要求的配置签名。

首次与最终各两份已分配 runtime 的唯一 fixture image（共 **4**）均通过 `docker image inspect` 的准确 No such image、各自 ancestor 查询为空独立核对。runtime 均返回 containerObjectsRemoved/proxyObjectsRemoved/fixtureImageRemoved=true。控制在学校绑定前失败，实际没有启动学校业务/代理对象，**removedContainerIds=[] / removedProxyIds=[] 是如实结果**，不能称为新增完整绑定/代理删除证明。未执行全局 Docker 清理或触及历史保留对象。

## 具体命令、检查与签名

以下均在本私有 worktree；除记录的首次 native 尝试和默认沙箱签名连接失败外，最终相关命令 exit0：

```sh
node .e2e/control-review/readback.mjs
npm run typecheck:e2e
node_modules/.bin/tsc -p e2e/school/tsconfig.json
node --check e2e/school/control-evidence.mjs
node --check e2e/school/self-check.mjs
node --check .e2e/control-review/readback.mjs
VITE_POSTHOG_PROJECT_TOKEN= VITE_POSTHOG_HOST= npm --prefix frontend run build
python3 .e2e/control-review/native-driver.py
python3 .e2e/control-review/cleanup-verify.py
python3 .e2e/control-review/publish.py
git diff --check
git verify-commit HEAD
```

`native-driver.py` 实际执行 `node e2e/school/self-check.mjs`，仅指定本票私有 TMPDIR 和禁用遥测变量，观察该准确临时路径的进程标志并检查消失。原始脚本/日志已归档；脱离原 worktree 布局回放历史输入时需按 manifest 源/副本映射定位，不将归档回读称为重新跑业务。

提交前核验有效身份 `User-Unauthorized <69748465+UserUnauthorized@users.noreply.github.com>`，`commit.gpgsign=true`、`gpg.format=ssh`。默认沙箱首次签名无法连接既有 1Password socket；按授权升级权限后成功，未覆盖身份或修改签名配置。两个执行提交均由既有 SSH key 签名；最终 d0ba5c2 verify-commit 为 Good signature，fingerprint `SHA256:kFBsDXcJS4MSU8XzdxOS6OXw1GWgslmAJ01pZuIHgrg`。

## 证据完整性与最终边界

[证据 manifest](AUTH-SCHOOL-CONTROLS-evidence/manifest.json)记录 **58 份文件**的存储/原始 bytes 与 SHA-256；另有 manifest 自身。文本日志/trace 使用确定性 gzip 原样保留，解压逐字节等于原输入，避免为了 Git 空白规则改写原日志。扫描已知合成密码/secret、JWT 形状和 TOTP URI，**problems=[]**。五张 PNG 只有两种不同哈希，均已实看：登录表单未填写，密码字段遮罩，无敏感值。没有 DB、原始邮件、浏览器 profile、HAR 或生产用户数据。

没有新远端 CI 声明，没有取消/dispatch 父 45ddb CI；没有修改 integration、main、生产文件、依赖锁、execution/status/coverage、他人 checkout，没有 push/PR/发布/部署。父仍拥有 integration 和最终审查/推送；本票只交付固定源码、定向证据及签名提交。
