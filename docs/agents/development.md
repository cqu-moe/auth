# 开发与验证

## 本地开发

- 根目录 `.dev.vars` 提供本地 secrets；`BETTER_AUTH_URL` 应与本地服务一致。变量名及 bindings 查 `wrangler.jsonc`，值不写入文档。
- 前端 `createAuthClient` 使用同源 `/api/v1/auth` basePath；需要 baseURL 时使用绝对地址。
- 邮件客户端延迟初始化，避免缺少 Resend key 时使无关路由失败。
- 前端构建产物不入 Git；修改设计系统消费页面时读取安装包内随版本分发的 DESIGN.md。

## 按改动验证

| 改动 | 验证入口 |
| --- | --- |
| 后端类型/纯函数 | `npm run typecheck`、`npm test` |
| DO/会话时序 | 另跑 `npm run typecheck:do`、`npm run test:do` |
| HTTP 契约/鉴权边界 | [API 文档](../api/README.md) 的生成与校验流程，另跑 `npm run check:boundaries` |
| 前端 | `pnpm --dir frontend build`；相关页面行为、设计检查与 lint 按前端 scripts 执行 |
| 浏览器容器 | 按 `.github/workflows/test.yml` 的 container 测试方式；现场登录另作验收 |

## 部署与证据

部署前读取当前 `package.json`、Wrangler 配置和 `.github/workflows/`。旧交接中的部署工作流及分支状态仅为历史，不假定 push 就会上线。`npm run deploy` 会实际部署，需在用户授权范围内执行。

报告区分本地检查、CI、合并、Worker 部署与已登录业务验收。分支版本上传不能当作生产部署，也不能假定 DO Worker 有可用的 preview URL；需要时核实独立预览环境。
