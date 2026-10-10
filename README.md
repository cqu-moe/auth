# CQU Auth

重庆大学统一认证服务，提供账户登录、CQU SSO 绑定、OAuth/OIDC 与子系统权益。生产入口：[auth.cqu.moe](https://auth.cqu.moe)。

- 开发及 Agent 约定：[AGENTS.md](AGENTS.md)
- 子系统接入：[接入契约](docs/subsystem-integration-guide.md)
- HTTP schema、鉴权与生成规则：[API 文档](docs/api/README.md)
- 历史执行证据：[交接入口](HANDOFF.md)

本地分别安装根目录 npm 依赖和 frontend 的 pnpm 依赖，配置本地 `.dev.vars` 后按各自 `package.json` 启动。检查和部署边界见 [开发与验证](docs/agents/development.md)。
