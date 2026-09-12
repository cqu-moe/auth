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

## Fix round 1/5（Task 1 审查修复）

### 修复

1. `CquSessionDO.revoke()` 不再在本地撤销前等待 Account DO。现在先递增 binding epoch、清 QuickLogin/browser 登录锁，再提交 `status=revoked`、删除 alarm 与登录状态；最后 best-effort 通知账号 DO。通知失败只写结构化告警，不改变本地撤销结果。
2. Device DO 在浏览器 keepalive 成功后，先把 `pendingKeepaliveMint`（operation ID、铸票时刻和待提交 storage state）持久化。broker 回包丢失时，下次 alarm 先用同一 ID 重试确认，不重复调用浏览器 keepalive；确认后才清 pending 并更新 session。
3. CquSession 的 mint 幂等记录改为单个紧凑 receipt 列表：24 小时 TTL、最多 64 条，并在 CquSession alarm/每次记录时清理；旧 `quickloginMint:*` 单键会被惰性删除。
4. 删除 Task 1 无生产引用的 `client-registration.ts`、`http.ts`、`quota-admin.ts` 及前两者对应的 Task 1 测试；留待 OAuth/HTTP/admin 实际接线任务加入。`oauth-grants.ts` 因 Account DO 直接依赖保留。
5. `quicklogin-login-broker.do.test.ts` 的 coalescing 用例改为悬挂首个 `/run`，在其完成前发出第二请求，验证并发请求只触发一次容器运行。

### RED

命令：

```sh
npm run test:do -- test/do/cqu-session.do.test.ts test/do/quicklogin-device.do.test.ts test/do/quicklogin-login-broker.do.test.ts
```

有效 RED：exit 1；73 tests passed、3 tests failed。

- Account DO 通知故障时 revoke 实际返回 500，期望 200；
- 70 个 `quickloginMint:*` 收据全部残留，期望最多 64；
- broker 回包丢失后 session 没有 `pendingKeepaliveMint`。

首次测试夹具尝试跨 DO 复用 Response/Promise，触发 workerd I/O 上下文限制；调整为无跨上下文对象的 binding stub 后，重新运行得到上述有效产品 RED。并发 single-flight 测试直接通过，证明实现已有 single-flight，原缺口仅是测试未真正覆盖。

### GREEN

```sh
npm run test:do -- test/do/cqu-session.do.test.ts test/do/quicklogin-device.do.test.ts test/do/quicklogin-login-broker.do.test.ts
npm run test:do -- test/do/cqu-session.do.test.ts test/do/quicklogin-device.do.test.ts test/do/quicklogin-login-broker.do.test.ts test/do/quicklogin-account.do.test.ts test/do/quicklogin-migration.do.test.ts test/do/quicklogin-projection.do.test.ts test/do/quicklogin-regression.do.test.ts
npm test -- src/services/quicklogin/*.test.ts
npm run typecheck
npm run typecheck:do
```

结果：

- 修复 focused Workers：3 files、76 tests passed；
- Task 1 Workers 回归：7 files、87 tests passed；
- QuickLogin Node：8 files、56 tests passed；
- 两项 TypeScript 检查均 exit 0。

### 自审与担忧

- `git diff --check` 通过；全仓检索确认三个越界模块已无代码/测试残留引用。
- receipt 上限使存储条数有硬边界；TTL 清理由正常 alarm 和后续 mint 调用触发，长期无活动的最后一组收据会保留到下一次唤醒，但最多 64 条。
- best-effort 账号通知失败时，CquSession 已 fail-closed；Account DO 投影/设备 fencing 会在后续同步机会收敛，本轮没有新增跨 DO outbox。
- Workers 仍打印既有 Containers sourcemap/未启用容器背景噪音，测试 exit 0。

## Fix round 2/5（pending keepalive payload 拆分）

### 修复

1. `StoredDeviceSession.pendingKeepaliveMint` 只保留小 metadata：`operationId`、`mintedAt`、`expiresAt`、`hasStorageState`。
2. 待确认的 serialized browser state 改存 Device DO 独立 key `pendingKeepaliveState`；创建 pending 时在同一 storage transaction 中分别写 session metadata 与独立 payload，不再把现有 state 和新 state 复制进一个 value。
3. broker 回包失败时 metadata/payload 都保留，下次 alarm 先用同一 operation ID 确认，仍不重复浏览器 keepalive。
4. broker 确认后 transaction 更新正式 session 并删除独立 payload；mode-off、禁用、撤销、generation 变化也同步清理 payload。
5. pending metadata 使用 24 小时有效期；`alarm()` 与 `readSession()` 会恢复过期记录，并删除 metadata 与独立 payload。没有 metadata 的孤儿 payload 也会惰性清理。

### RED

```sh
npm run test:do -- test/do/quicklogin-device.do.test.ts
```

结果：exit 1；7 tests passed、3 tests failed。

- 约 70 KiB 的现有 state 与约 70 KiB 的 pending state 同时塞进 session，序列化长度达到 145,249 字符，超过测试锁定的 120 KiB 边界；
- authority 禁用/代次变化后 `pendingKeepaliveState` 仍残留；
- 过期 pending 在 read recovery 后仍保留 metadata/payload。

### GREEN

```sh
npm run test:do -- test/do/cqu-session.do.test.ts test/do/quicklogin-device.do.test.ts test/do/quicklogin-login-broker.do.test.ts test/do/quicklogin-account.do.test.ts test/do/quicklogin-migration.do.test.ts test/do/quicklogin-projection.do.test.ts test/do/quicklogin-regression.do.test.ts
npm test -- src/services/quicklogin/*.test.ts
npm run typecheck
npm run typecheck:do
```

结果：Task 1 Workers 7 files / 89 tests passed；QuickLogin Node 8 files / 56 tests passed；两项 TypeScript 检查 exit 0。

### 自审与担忧

- 大 state 测试确认 session 主 value 低于 120 KiB，独立 pending payload 大于 64 KiB；重试两次发送相同 operation ID，浏览器 keepalive 只执行一次。
- 当前正式 `storageState` 本身仍按既有协议保存在 session；本轮只消除“正式 state + pending state”在同一 value 的重复。
- Workers 仍有既有 Containers sourcemap/未启用容器及 overdue alarm 背景噪音，测试 exit 0。
