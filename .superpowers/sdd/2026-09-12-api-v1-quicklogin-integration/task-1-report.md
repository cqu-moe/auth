# Task 1 Report: QuickLogin 核心状态、迁移与 Durable Objects

## Status

DONE

- 目标工作树：`/Users/uu/Developer/cqu-moe/auth/.worktrees/api-v1-refactor`
- API v1 基线：`7f2270d`
- 移植来源：`2f350976694829875c609fbb2f00bf086d329084`
- 未部署、未访问生产、未 push。

## 实现

1. 移入 `src/services/quicklogin/**` 的核心协议、账号 reducer、Cookie envelope、配额策略、账号/设备/登录 broker client、维护调度、迁移、投影、outbox、OAuth grant 辅助与模式判断。
2. 以真实 `CquQuickloginAccountDO` 和 `CquQuickloginDeviceDO` 替换 Worker 入口中的兼容占位导出；兼容模块文件仍保留，未删除历史兼容代码。
3. 选择性移入来源 HEAD 的 `CquSessionDO` broker 改动：
   - 设备级独立容器路由；
   - 共享验证码 FIFO lease；
   - binding epoch 与迟到结果 fencing；
   - keepalive mint 去重；
   - bind/revoke/destroy 通知账号 DO；
   - device mode 下由账号 DO 状态决定 broad-ticket eligibility。
4. 加入 D1 migration `0009_quicklogin_devices.sql` 与 Drizzle 投影 schema。
5. 合并 Env、Worker exports、Wrangler bindings/vars/migration graph 和 Workers 测试变量；`v3` 最终同时声明 account/device 两个 SQLite DO。
6. 把 `quicklogin_device_limit` 合并到共享 capability 目录，并让该额度拒绝“空值=无限”。
7. 加入最新维护语义：瞬时失败退避、失败维护恢复、过期 retry alarm 唤醒，以及 Cookie 空值过滤。对应生产文件与来源 HEAD 字节一致。

## 文件

### 新增

- `drizzle/migrations/0009_quicklogin_devices.sql`
- `src/durable-objects/cqu-quicklogin-account.ts`
- `src/durable-objects/cqu-quicklogin-device.ts`
- `src/services/quicklogin/**`
- `test/do/quicklogin-account.do.test.ts`
- `test/do/quicklogin-device.do.test.ts`
- `test/do/quicklogin-login-broker.do.test.ts`
- `test/do/quicklogin-migration.do.test.ts`
- `test/do/quicklogin-projection.do.test.ts`
- `test/do/quicklogin-regression.do.test.ts`

### 修改

- `shared/capabilities.ts`
- `src/db/schema.ts`
- `src/durable-objects/cqu-session.ts`
- `src/index.ts`
- `src/services/cqu-2fa/code-lease.ts` 与测试
- `src/services/cqu-browser-routing.ts` 与测试
- `src/services/entitlements.ts`
- `src/types.ts`
- `vitest.workers.config.mts`
- `wrangler.jsonc`

## RED

### 核心纯函数

命令：

```sh
npm test -- src/services/quicklogin/*.test.ts
```

预期且观察到的失败：exit 1；10/10 suites 因 `./account-reducer`、`./cookie-envelope`、`./maintenance` 等生产模块不存在而失败，0 tests 执行。

### Durable Objects / broker

命令：

```sh
npm run test:do -- test/do/quicklogin-account.do.test.ts test/do/quicklogin-device.do.test.ts test/do/quicklogin-login-broker.do.test.ts test/do/quicklogin-migration.do.test.ts test/do/quicklogin-projection.do.test.ts test/do/quicklogin-regression.do.test.ts test/do/quicklogin-revocation.do.test.ts
```

预期且观察到的失败：exit 1；7/7 suites 因 `account-client` / `login-broker-client` 缺失而失败。首次 sandbox 运行被 localhost listen EPERM 阻断，授权本地 workerd 监听后得到上述有效 RED。

### 必要支撑 seam

命令：

```sh
npm test -- src/services/cqu-browser-routing.test.ts
npm run typecheck
```

预期且观察到的失败：

- browser routing 1/10 失败：期望 `quicklogin:user-a:device-a`，实际仍用 `user-a` 定位容器；
- TypeScript exit 2：`quicklogin` 尚不属于 `LoginKind`，`BrowserRoute` 尚无 `containerKey`，共 5 个错误。

## GREEN

### Focused Node

```sh
npm test -- src/services/cqu-2fa/code-lease.test.ts src/services/cqu-browser-routing.test.ts src/services/quicklogin/*.test.ts
```

结果：exit 0；12 files passed，89 tests passed。

### Focused Workers

```sh
npm run test:do -- test/do/quicklogin-account.do.test.ts test/do/quicklogin-device.do.test.ts test/do/quicklogin-login-broker.do.test.ts test/do/quicklogin-migration.do.test.ts test/do/quicklogin-projection.do.test.ts test/do/quicklogin-regression.do.test.ts test/do/cqu-session.do.test.ts
```

结果：exit 0；7 files passed，84 tests passed。

### TypeScript

```sh
npm run typecheck
npm run typecheck:do
```

结果：两项均 exit 0，无诊断。

### 完整相关回归

```sh
npm test
npm run test:do
```

结果：

- Node：exit 0；78 files passed，619 tests passed；
- Workers：exit 0；17 files passed，131 tests passed。

## 自审

- `git diff --check`：exit 0。
- `src/services/quicklogin/**`、两个真实 DO、0009 migration 和最终纳入的 6 个 QuickLogin DO 测试与来源工作树逐文件一致。
- `CquSessionDO` 工作树 blob 与来源提交 blob 相同；相对 API v1 HEAD 的 diff 只包含 QuickLogin broker/隔离变化。
- 保留 API v1 `createApp` Worker 入口、`Principal` / request auth cache 类型、authentication、Problem Details、OTP/2FA、append-only 0000–0008 migrations。
- 未恢复 `LOGIN_NODE` 或 retired node fallback；`BrowserRoute.backend = node` 仅保留受控 410 兼容语义。
- 未修改 HTTP device route、API v1 quicklogin route、auth-config OAuth hook、admin UI/API 或 frontend。
- `quicklogin-revocation.do.test.ts` 在 GREEN 阶段暴露其真实 OAuth authorize 前置依赖；按 brief 将该测试及专用 fixture 留给后续 OAuth hook 任务。账号/device/reducer 测试仍覆盖核心 revoke、generation fencing 与墓碑语义。
- 暂存前将只选择本报告列出的 Task 1 文件并审查 cached diff。

## 担忧 / 非阻塞说明

- Workers 全套 exit 0，但测试环境仍打印既有 Containers sourcemap、未启用容器实例与 overdue alarm 背景噪音；未造成测试失败。
- `QUICKLOGIN_DEVICE_MODE` / client / extension origin 使用来源部署值，但本任务没有部署。
- OAuth grant helper 位于 `src/services/quicklogin/**` 并已编译；实际 auth hook、HTTP routes 与端到端 OAuth/revocation 测试仍由后续任务接入。
