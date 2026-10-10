# CQU Auth

Cloudflare Workers 上的统一认证服务：Hono、D1、Better Auth 与 React SPA。

## 工作约定

- 根目录使用 `npm ci`；`frontend/` 使用其锁文件和 `packageManager` 指定的 pnpm。命令以各自 `package.json` 为准。
- 正式 HTTP API 使用 `/api/v1`。OAuth issuer 保持 `https://auth.cqu.moe/api/auth`；discovery 与已退役业务路径分别处理。
- 数据库迁移全部手写下一个编号的 SQL。`drizzle/migrations` 没有 Drizzle meta 基线，自动生成会重建已有表；`schema.ts` 只提供应用表查询类型。
- 用户界面使用简体中文。提交使用有效 Git 身份与现有签名配置；1Password 签名失败时报告并等待解锁。

## 按任务读取

- 修改 HTTP 路由、schema、鉴权或生成类型前，读 [API 契约](docs/api/README.md)。保留 `src/app.ts` 的 API 错误处理及 ASSETS fallback。
- 修改 OAuth、角色、权益或数据库访问前，读 [认证与数据约定](docs/agents/auth-contracts.md)；子系统接入再读 [接入契约](docs/subsystem-integration-guide.md)。
- 修改 CQU 登录、取票、keepalive、会话存储或撤销前，读 [CQU 会话约定](docs/agents/cqu-session.md)。
- 修改前端、运行验证或准备部署前，读 [开发与验证](docs/agents/development.md)。
- 历史交接与执行记录从 [HANDOFF.md](HANDOFF.md) 查找；它们不证明当前分支或生产状态。

## Agent skills

- Issue tracker：处理 issue、规格或任务拆分前，读 [GitHub Issues 约定](docs/agents/issue-tracker.md)。
- Triage labels：分类或变更 issue 状态前，读 [标签映射](docs/agents/triage-labels.md)。
- Domain docs：探索领域、命名或设计决策前，读 [领域文档约定](docs/agents/domain.md)。
- 技能按任务选用：排障用 diagnosing-bugs，模块边界用 codebase-design，领域术语与 ADR 用 domain-modeling，代码审查用 code-review，PR 描述用 pr；修改 Agent 文档用 writing-for-agents。已安装 Matt 插件时优先使用 mattpocock-skills 命名空间；技能不可用时按仓库约定完成任务并说明缺失。
