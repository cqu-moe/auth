# API v1 cleanup ledger

基线：`225d1c66d9b15ae13b9c710227649c1d47516aa4`。本账本只记录本分支可由引用、测试或运行入口证明的删除/合并；不以总行数为目标。

| 原实现 / 重复点 | 处理 | 替代与证据 |
| --- | --- | --- |
| frontend 从 `src/capabilities.ts` / `src/user-roles.ts` 的5处跨层导入 | 删除旧位置，纯定义移至 `shared/` | `npm run check:boundaries` AST解析；shared测试与两端typecheck |
| CQU route/binding 的重复 JWT/session 验证与 scope 二次验签 | 删除各路由内联实现 | `src/middleware/authentication.ts` + `src/services/oauth-scopes.ts`；同请求验签一次测试 |
| forward 新建分支在 `FORWARD_MODE_DISABLED` return 后的不可达白名单代码 | 删除 | forward创建403、旧forward读取/邮件sender测试保留 |
| `src/index.ts` 中HTTP装配与SPA fallback混合 | 移出 | `src/app.ts` 负责API/legacy/discovery/ASSETS；index保留fetch/email/queue/命名导出 |
| `frontend/src/pages/Admin.tsx` 2289行混合页面 | 拆成38行页面组合 | `features/admin/{Users,Invitations,Entitlements,OAuthClients}Section.tsx` 与共享ui；frontend tsc/lint/build |
| Settings/Wizard 两份WebSocket URL、解析、重连与timer生命周期 | 删除内联transport | `frontend/src/lib/api/binding-events.ts` + `shared/cqu-events.ts`；fake timer和真实Workers 101测试 |
| Settings/Wizard/Admin 三份剪贴板timer实现 | 合并 | `frontend/src/components/CopyButton.tsx`；admin compact wrapper只保留视觉差异；卸载timer测试 |
| 前端散落旧 `/api/auth`、`/api/cqu`、`/api/admin` fetch | 删除业务页面直接旧路径 | `frontend/src/lib/api/*` 与显式 auth basePath；静态扫描、transport测试 |
| `db:generate` 与 build阶段隐式 `npm install` | 删除 | SQL迁移仍手写；`build:frontend` 仅运行已安装依赖的build |
| API产物人工更新风险 | 增加生成/漂移门禁 | `generate:api`、`check:api`、`lint:api` 与CI；2026-09-12 补充为 runtime/OpenAPI/CF/endpoints/coverage 精确集合比较 |
| frontend 手写 QuickLogin `PublicDevice`/list/preference/quota DTO | 删除重复声明 | 改为 `shared/api-types.generated.ts` 的 `components["schemas"]` 索引；生成、frontend typecheck 和组件测试约束 |
| 全量 115-operation legacy Auth 文档投影 | 从当前生成物删除 | 当前仅 15 个批准过渡操作；运行时、两份 OpenAPI、endpoint/coverage manifests 集合均为 153 |
| canonical QuickLogin OPTIONS 通配注册 | 改为五个精确资源 | 固定-origin handler 复用；operation inventory 与 Workers CORS/404/405 回归约束 |
| 全局Hono CORS提前吞掉未知OPTIONS | 删除全局自动preflight | 只在runtime精确path和请求method匹配时返回204；QuickLogin按资源返回实际methods |
| handler手写JSON解析与OpenAPI请求体复制 | 合并 | `src/api/validation.ts` + route Zod schema；OAuth/entitlement/CQU/QuickLogin统一媒体与strict合同 |
| OpenAPI路径鉴权猜测 | 删除 | `docs/api/auth-policy.json`覆盖153个runtime operation并参与`check:api`集合/security漂移检查 |
| Account DO追加式outbox | 改为稳定key有界合并 | projection按revision、device按deviceId、revoke按grantId保留最新；256 critical硬上限采用失败背压，不静默丢撤销 |

## 明确保留

- `src/routes/{admin,cqu,cqu-bind,cqu-quicklogin}.ts`：迁移期 legacy 映射和部分 canonical adapter 仍复用这些 handler；删除会复制或破坏兼容逻辑。旧地址退役后再反转/移除。
- `src/routes/admin.ts` 的旧公开挂载虽已退役，但OAuth与CQU绑定的canonical adapter仍调用其中已审计handler/helper；本修复波不为减行拆除，留待反转依赖后单独清理。
- `src/utils/error.ts`：仅供 legacy 成功/错误形状；canonical 使用 `src/api/problem.ts`。
- 原有9个 SQL migration 加现有 `0009_quicklogin_devices.sql`、Durable Object migration graph、`CquQuickloginAccountDO` / `CquQuickloginDeviceDO` 兼容导出、`NODE_RETIRED` 拒绝分支、旧 forward 数据读取和邮件处理、Schedule RPC。
- QuickLogin 公开 export envelope 仅描述扩展必须消费的协议字段；grant、账号 DO state、存储的 browser state、pending state 均不进入公开 schema。
- D01–D05 issuer discovery 永久保留；QuickLogin 0.1.2 OAuth/device 与旧 reset callback 暂时保留，待真实流量和两设备升级证据后单独移除。
- 历史设计/计划/HANDOFF 内容：仅在当前文档顶部标注新状态，历史证据不批量改写。

## 规模与责任

- Admin 页面入口：2289行 → 38行；功能代码转为4个可独立定位的Section。
- 新增 schema、测试和机器契约会增加总行数；这些是外部合同与回归证据，不计为应删除的业务重复。
