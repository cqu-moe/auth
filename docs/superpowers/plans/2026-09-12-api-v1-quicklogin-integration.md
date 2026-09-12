# API v1 与已部署 QuickLogin 能力整合计划

状态：用户于 2026-09-12 在核对现有调用方后批准执行。本计划是已完成的 API v1 T00–T17 的补充，不重开原设计审批。

## 目标

把 `codex/quicklogin-implementation` 中已经部署并由 canary 使用的 QuickLogin 设备能力选择性整合进 `codex/api-v1-refactor`，为设备与管理接口提供 `/api/v1` 正式入口，同时保留现有旧入口兼容；把 QuickLogin 扩展仓库的 OAuth 与设备请求迁到 v1。最终只交付本地分支、提交、测试和文档，不 push、不部署、不读取生产 D1/KV、不修改 Cloudflare 线上配置。

## 已核实基线

- API v1 工作区：`/Users/uu/Developer/cqu-moe/auth/.worktrees/api-v1-refactor`；分支 `codex/api-v1-refactor`；补充任务起点 `c1d379984e176d635f01382ae800137ffae0a08e`。
- QuickLogin Auth 来源：分支 `codex/quicklogin-implementation`；当前 HEAD `2f350976694829875c609fbb2f00bf086d329084`；共同祖先 `79026bad4dd29322c458b7517ec0759a91f84c2a`。
- QuickLogin 扩展来源：`/Users/uu/Developer/cqu-moe/quicklogin` 的 `main`/`82bfb12`；0.1.2 仍调用旧 OAuth 与旧设备路径。
- API v1 起点本地基线：Node 68 files / 554 tests；Workers 11 files / 109 tests；root、Workers、frontend TypeScript 均 exit 0。Workers 输出含既有 Container sourcemap/未启用提示，但测试退出码为 0。

## 裁决与约束

原 API v1 计划中的“QuickLogin device 路由不是 main 已存在能力，不恢复”基于 2026-09-11 的 main 快照。现有源码、交接记录和 canary 证据表明迁移 `0009_quicklogin_devices.sql`、两个 QuickLogin DO、OAuth grant 和设备路由已经部署且有两个在线设备，因此该前提失效。

本补充计划只覆盖这项已批准的现实修正：

- 保留 API v1 已完成的 OTP、onboarding、issuer、路由边界、Problem Details、前端模块化和 OpenAPI 结构。
- 不整体合并旧功能分支的文件树；只移植 QuickLogin 功能提交，避免回退或删除 v1/OTP/onboarding 内容。
- QuickLogin 设备正式入口为 `/api/v1/cqu/quicklogin/devices` 及其子资源；旧 `/api/cqu/quicklogin/devices` 精确委托同一实现。
- QuickLogin 管理正式入口位于 `/api/v1/admin/users/{id}/quicklogin-*`；旧 `/api/admin/users/:id/quicklogin-*` 精确兼容。
- QuickLogin 扩展正式调用 `/api/v1/auth/oauth2/authorize`、`/api/v1/auth/oauth2/token` 和 `/api/v1/cqu/quicklogin/devices*`。不扩大 host permissions，不更换 client ID、extension ID、redirect URI、scope 或协议版本。
- 稳定 issuer 仍为 `https://auth.cqu.moe/api/auth`；D01–D05 discovery 永久保留。
- 生产已应用的 D1/DO 迁移历史只追加/对齐，不重编号、不删除、不重写表；`v3` 必须保留 `CquQuickloginAccountDO` 与 `CquQuickloginDeviceDO`。
- legacy 没有自动 Sunset；生产退役仍需部署后的路由计数、OAuth client 清单和单独授权。
- 所有新行为先写或移植会失败的测试并观察 RED，再移植最小实现变 GREEN；每项本地提交前审查 staged diff，不改其他 worktree。

## Task 1：移植 QuickLogin 核心状态、迁移与 DO

**来源：** `codex/quicklogin-implementation` 中 `1afcaff` 至 `bfde2ca` 以及后续维护修复 `d54142b`、`0507647`、`2f35097` 的 QuickLogin 专属文件。

**要求：**

1. 先移植纯函数、账号/设备 DO 和 CQU broker 的测试，确认在 API v1 分支因模块/能力缺失而失败。
2. 移植 `src/services/quicklogin/**`、真实 `CquQuickloginAccountDO`、`CquQuickloginDeviceDO`、必要的 CquSessionDO broker 改动、schema 和 `drizzle/migrations/0009_quicklogin_devices.sql`。
3. 合并 `Env`、Worker 导出、Wrangler bindings/vars/migration graph；保留 v1 的 Worker 入口与历史导出，不恢复已退役节点路径。
4. 保留最新维护退避、过时代次唤醒、Cookie 空值过滤和配额/撤销语义。
5. 运行新增纯函数测试、全部 QuickLogin DO 测试、CquSession 回归及两项 TypeScript 检查；提交 Conventional Commit。

## Task 2：接入 v1 设备 HTTP、OAuth grant 与 legacy 兼容

**要求：**

1. 先添加真实 app/Workers 测试：v1 设备注册/列表/开关/删除/status/refresh/export 当前 404；旧路径在实现后必须与 v1 共享状态和权限。
2. 把 QuickLogin OAuth grant 绑定、access-token 验证和 device principal 接入当前 `createAuth`，同时保持 v1 basePath、稳定 issuer、OTP/2FA/customSession 行为。
3. 设备 API 使用当前 v1 验证/错误层；扩展 Bearer 路径保持协议错误体，网站 session 路径保持 no-store、同源要求和用户隔离。不得把坏 Bearer 降级成 session。
4. v1 路由只实现一份业务 handler；旧设备路径由集中 legacy 路由精确转发，不使用 HTTP redirect，不复制 DO 调用。
5. 更新 runtime 操作枚举与负例：错误方法 405、未知子路径 JSON 404、OPTIONS CORS 只允许固定 extension origin、禁用模式 503。
6. 运行 OAuth、设备路由、认证、legacy、OTP/2FA 和 Workers 集成测试及类型检查；提交 Conventional Commit。

## Task 3：迁移 Auth 网页设备管理与管理员配额入口

**要求：**

1. 先移植 QuickLogin settings、设备列表、quota editor 的交互测试，并针对当前拆分后的 `features/admin` 与统一 API client 写失败请求断言。
2. 新增 v1 管理资源：policy preview/initialize、quota preview/apply；保留原权限、preview token、revision、防并发覆盖和事务语义，旧地址集中兼容。
3. Settings 只在用户 eligible 时显示 QuickLogin 管理；设备列表走 v1 session API。Admin 在现有模块化页面中接入额度编辑，不把 `Admin.tsx` 重新膨胀成旧单文件。
4. 所有请求复用 `frontend/src/lib/api` 的 v1 基址、ApiError、204/no-store 处理；不恢复散落 fetch 或后端 `src` import。
5. 运行相关组件/API client 测试、frontend typecheck/lint/build、边界检查；提交 Conventional Commit。

## Task 4：迁移 QuickLogin 扩展客户端到 v1

**工作区：** 从 QuickLogin `main` 新建隔离分支 `codex/quicklogin-api-v1-client`，不得修改其主工作目录。

**要求：**

1. 先添加/修改请求捕获测试，使旧硬编码路径导致 RED；测试断言 authorize、token、register、status、enable、refresh、export 全部使用 v1。
2. 只改固定 API 路径，不改变 PKCE、state、offline_access、grant 复用、token 存储、设备 ID/generation、重试和 Cookie 应用语义。
3. 保持现有 `https://auth.cqu.moe/*` host permission；路径变化不得新增权限或远端可控 URL。
4. 运行扩展全部测试、typecheck、build、package/manifest 验证；不上传商店、不发布；提交 Conventional Commit。

## Task 5：契约、Cloudflare 产物、文档与最终验收

**要求：**

1. 为所有新 v1/legacy/admin QuickLogin 操作补同源运行时 schema、OpenAPI、Cloudflare 投影、auth policy、endpoint kind 和覆盖说明；扩展协议错误响应不得被错误包装。
2. `generate:api` 后检查 runtime ↔ OpenAPI ↔ endpoints ↔ Cloudflare 集合；连续生成无漂移。永久 discovery 与仍保留 legacy 明确登记。
3. 更新原 API v1 execution-log、acceptance-results、cleanup-ledger 和当前接入文档，说明原计划前提为何被修正、QuickLogin 哪些能力被保留、哪些退役条件仍未满足。
4. 运行原 API v1 验收命令全集，加 QuickLogin Auth 全部 Node/Workers 测试和扩展全部门禁；记录实际退出码、测试数和已知环境噪声。
5. 最终做任务级审查和整分支审查。报告两个工作区/分支/commit，并明确未 push、未部署、未上传 Cloudflare schema、旧路由仍未退役。
