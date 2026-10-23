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

### Auth 邮件发件人

可选 Worker 变量 `AUTH_EMAIL_FROM` 统一配置邮箱验证/更换邮箱 OTP 与密码重置邮件的发件人。值会去掉首尾空白；未设置、空字符串或全空白时，使用 Auth 自身身份 `CQU Auth <noreply@auth.cqu.moe>`。覆盖仅用于已受信任且已验证发件域的 Auth 部署。Resend 客户端保持延迟初始化。

Auth 邮件使用专用 secret `AUTH_RESEND_API_KEY`，不回退到旧 `RESEND_API_KEY`。T17 隔离 Auth 的专用 Wrangler 配置可在 `vars` 中加入以下字段（本地可写入该环境的 `.dev.vars`）；对应账号须已验证发件域：

```json
"AUTH_EMAIL_FROM": "受信任部署 <noreply@auth.cqu.moe>"
```

仅隔离环境设置此覆盖值，生产配置不增加该字段。`schedule-notifications` 队列固定使用 `CQU Schedule <noreply@schedule.cqu.moe>`，并使用独立 `SCHEDULE_RESEND_API_KEY`，不回退到 Auth key。cutover 期间旧生产 `RESEND_API_KEY` binding 保留给已部署旧版本使用；新版本发布确认后再移除。此变量不改变 [Auth 二次验证策略](../adr/0006-sensitive-operation-reauthentication.md)：中央账号邮件 2FA 路由禁用，继续使用 TOTP、恢复码或 Passkey。本配置不涉及学校 CQU 邮件验证码接收。
