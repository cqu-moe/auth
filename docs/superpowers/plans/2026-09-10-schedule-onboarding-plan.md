# Schedule 新用户接续与首次同步 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. `superpowers:subagent-driven-development` is an alternative only if the user requests delegation. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 注册、验证、绑定在 Auth 连续完成；返回 Schedule 后自动准备三个订阅，使用已确认的现有订阅列表同步反馈。

**Architecture:** 复用 Auth 的本地 redirect 链，把 `/cqu/bind` 作为认证完成后的目标。Schedule 用一个受会话保护的默认订阅初始化操作、一个 D1 初始化/投递状态表，以及现有个人订阅同步组处理首次同步。Dashboard 只接入新的数据准备过程和固定提示组件。

**Tech Stack:** Auth：React 19、React Router、Better Auth、Hono、Drizzle/D1、Vitest。Schedule：Vue 3、Pinia、现有 Card/Button/Badge、Hono、D1、Cloudflare Queue。遵循各仓锁文件，不升级框架，不新增运行时 UI 或动画依赖。

**Spec:** `../specs/2026-09-10-schedule-onboarding-design.md`

## Global Constraints

- 用户批准的是第二版「现有订阅列表」预览。不得重新设计，不得做周课表网格。
- 固定文字、结构、图标和动效以规格与冻结预览为准。不得擅自润色、扩写或替换设计。
- 生产中保留原 Dashboard 业务逻辑。禁止以演示组件整体替换 Dashboard。
- 不得把演示账号、3/10 常量、假链接、假成功计时器、底部预览工具带到生产。
- 一次只做一个 Task：先红测试，后实现，再跑该 Task 验证；不能提前实现后面的任务。
- 无权限不新增开通引导；沿用现有 caps，不新增权益查询接口，不自动补授权益。
- 保持 API 错误码和数据字段名；新增契约只能使用各章列出的名称。
- 所有写入身份只取认证 session；来源参数不代表权限。
- 新旧绑定状态兼容、邮箱验证、2FA、Cookie 所有权、额度、冷却、Queue run_id、共享链接与通知规则不可简化。
- 已提交/删除的订阅不能被首次初始化反复恢复；三个订阅共享同一正常初始同步。
- 测试通过不等于真实新用户动线已验收。最终报告分别写自动测试、浏览器模拟和真实环境证据。
- 不得 push、运行生产 migration 或部署，除非后续用户明确授权。使用仓库现有 Git 身份，禁止覆盖 author。

## 先读这些文件

1. 本文件。
2. 规格全文。
3. `2026-09-10-schedule-onboarding/00-frozen-reference.md`。
4. 当前 Task 所在章节。每章含输入输出、修改范围、代码段与测试要求。

| Task | 章节 | 完成物 |
| --- | --- | --- |
| 01 | 01-auth.md | 保留并验证已有状态/学校链接修复 |
| 02 | 01-auth.md | 认证接续工具、保护路由与验证链 |
| 03 | 01-auth.md | 绑定 bootstrap、刷新恢复、真实成功页 |
| 04 | 01-auth.md | 邮箱跨标签、密码恢复和 Auth 集成测试 |
| 05 | 02-schedule-backend.md | D1 初始化表、事务创建三个订阅 |
| 06 | 02-schedule-backend.md | 初始 Queue 投递恢复、单同步组 |
| 07 | 02-schedule-backend.md | defaults API、列表元数据与删除保护 |
| 08 | 03-schedule-frontend.md | 入口 URL 与首次初始化接续 |
| 09 | 03-schedule-frontend.md | 固定 FirstSyncNotice 组件与状态推导 |
| 10 | 03-schedule-frontend.md | 在原 Dashboard 接线、保留所有既有操作 |
| 11 | 04-validation.md | 全链路验证、冻结设计比对与交接 |

依赖顺序：01→02→03→04→05→06→07→08→09→10→11。不得跳过接口章节直接画页面。

## 工作目录与起始状态

- AUTH：`/Users/uu/Developer/cqu-moe/auth`
- SCHEDULE：`/Users/uu/Developer/cqu-moe/schedule-cloudflare`
- 计划目录位于 AUTH 的 `docs/superpowers/`。跨仓运行命令必须明确 cwd。
- 编写时 AUTH HEAD：`79026bad4dd29322c458b7517ec0759a91f84c2a`。
- 编写时 SCHEDULE HEAD：`ac88ffbc15b142dcf0ea3b9da58baae41c070b0d`。
- AUTH 有五个本轮已完成、未提交的文件，见冻结 baseline。它们属于本任务，不得 reset 掉，也不要重复实现。
- SCHEDULE 有既存未跟踪文档与构建文件；这些不是本计划的产物，禁止 `git add .`。

执行前只读命令：
```sh
pwd
git status --short
git rev-parse HEAD
git config user.name
git config user.email
```
在两个仓各运行一次。若身份缺失，按用户 AGENTS.md 停在提交步骤并询问；本地开发检查可继续。HEAD 已变化时先比对任务涉及的文件与冻结 baseline；保留后来改动，不强行覆盖。

正式开发用两份隔离 worktree。按 `superpowers:using-git-worktrees` 选择路径；分支统一 `codex/schedule-onboarding`，可在两个独立仓库使用同名分支。把已确认的五文件补丁带入 Auth worktree；先 `git apply --check`，确认未包含在当前 HEAD 后才应用，不重复套用。

## 进度记录

执行者在本目录新增 `execution-log.md`，每 Task 记录：仓库/HEAD、红测试命令及关键失败、改动文件、绿测试命令及结果、提交 SHA、未完成项。禁止写凭据或完整订阅 token。

单任务结束再提交，明确列文件：
```sh
git diff --check
git diff --stat
git diff --cached --check
```
提交消息建议随各 Task 给出。若当前会话只授权本地改动未授权提交，则记录通过情况而不提交。禁止跳 hook、force push、改写无关历史。

## 设计变更判定

允许：把预览的固定文本绑定到真实状态；复用现有组件；为手机换行补最小样式；修复明确可访问性问题。
不允许：更换布局、字体、配色、卡片数量逻辑、交互入口；添加解释卡片或新导航；缩短代码时删除鉴权/恢复/冷却；为了通过截图检查修改冻结参考。

如果真实业务约束与预览冲突，保留设计，报告具体冲突与最小解决办法。不能自行把产品设计重新做一遍。

## 完成条件

Task 11 的所有必测项有结果；未亲测的真实账号流程明确标为未验证。没有任何 TODO 型业务占位、硬编码假状态或测试跳过。交付两个仓库的改动清单与本地提交，不把本次计划请求当发布授权。
