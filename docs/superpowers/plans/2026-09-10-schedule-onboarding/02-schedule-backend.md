# Schedule 后端任务 05–07

本章 cwd 为 SCHEDULE worktree。先完成 Auth 任务，保留 existing API 与 Queue 消费者的权限、run_id 和通知逻辑。

## 固定 API 类型

在 `src/services/personal-subscription-setup.ts` 导出：
```ts
export type DispatchStatus = 'pending' | 'sending' | 'sent' | 'failed';
export interface PersonalSetupRow {
  user_id: string;
  status: 'created' | 'existing';
  subscription_ids: string;
  run_id: string | null;
  dispatch_status: DispatchStatus;
  lease_token: string | null;
  lease_until: number;
  created_at: string;
  updated_at: string;
}
export interface PersonalSetupSummary {
  status: 'created' | 'existing';
  subscription_ids: string[];
  run_id: string | null;
  dispatch_status: DispatchStatus;
}
export interface DefaultSubscriptionsResponse {
  status: 'created' | 'resumed' | 'existing' | 'skipped';
  subscription_ids: string[];
  run_id: string | null;
  dispatch_status: DispatchStatus | 'none';
}
export function getPersonalSetup(database: D1Database, userId: string): Promise<PersonalSetupRow | null>;
export function summarizePersonalSetup(row: PersonalSetupRow): PersonalSetupSummary;
export function recordExistingSetup(database: D1Database, userId: string): Promise<PersonalSetupRow>;
export function prepareDefaultSubscriptions(env: Env, userId: string, caps: CalendarCaps): Promise<DefaultSubscriptionsResponse>;
```
`subscription_ids` 在数据库是 JSON string，在公开返回中是 string[]。`lease_token`、`lease_until` 仅内部使用，不返回前端。

## Task 05：事务创建三个订阅与持久初始化记录

**Files**
- 新建 `drizzle/migrations/0010_personal_subscription_setup.sql`。
- 修改 `src/db/schema.ts` 添加 `personalSubscriptionSetup` 表映射。
- 新建 `src/services/personal-subscription-setup.ts`。
- 在现有 `src/routes/v2/subscriptions.test.ts` 的真实 D1 fixture 中增加本表初始化/清理及 service 测试，或提取等价共享 fixture 后建独立测试文件。

**Consumes**：Env.DB、现有 CalendarCaps、subscriptions、calendar_links、LINK_FORMATS、token 工具。
**Produces**：上面的 prepare/get/summary/recordExisting 函数。此 Task 不投递 Queue。

- [ ] 红测试先覆盖“有权限、无订阅→三订阅+三默认链接+一个持久记录”，直接调用 prepareDefaultSubscriptions，不能 mock 其内部查询或返回。
```ts
it('creates three personal views atomically for the session user', async () => {
  const result = await prepareDefaultSubscriptions(env, 'userA', FULL_CAPS);
  expect(result.status).toBe('created');
  const rows = await db.select().from(subscriptions).where(eq(subscriptions.userId, 'userA'));
  expect(rows.map(row => row.sourceType).sort()).toEqual(['personal_all','personal_courses','personal_exams']);
  expect(rows.every(row => row.sourceId === 'userA')).toBe(true);
  expect(new Set(rows.map(row => row.syncRunId)).size).toBe(1);
  const links = await db.select().from(calendarLinks);
  expect(links).toHaveLength(3);
  expect(links.every(link => link.isDefault)).toBe(true);
  expect(result.dispatch_status).toBe('pending');
});
```
`env`、`db`、`FULL_CAPS`、`subscriptions`、`calendarLinks`、`eq` 已在该测试文件存在。补全 FULL_CAPS 的 change_notification 字段以匹配当前类型。测试前清空本测试用户的表数据，不能依赖前一用例。
- [ ] 新迁移固定 SQL：
```sql
CREATE TABLE personal_subscription_setup (
  user_id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('created','existing')),
  subscription_ids TEXT NOT NULL DEFAULT '[]',
  run_id TEXT,
  dispatch_status TEXT NOT NULL CHECK (dispatch_status IN ('pending','sending','sent','failed')),
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_personal_setup_dispatch
  ON personal_subscription_setup (dispatch_status, lease_until);
INSERT INTO personal_subscription_setup
  (user_id,status,subscription_ids,run_id,dispatch_status,created_at,updated_at)
SELECT DISTINCT user_id,'existing','[]',NULL,'sent',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM subscriptions;
```
Wrangler 读取 `drizzle/migrations/`。当前 `_journal.json` 只登记到0007，0008/0009为手写迁移；不要为了本任务重生成旧迁移或补写假的 snapshots。新增手写0010并在schema中对应即可；未来生成迁移的历史整理不在本任务中。若0010已被新提交占用，顺延文件编号并同步计划执行记录，不覆盖别人的迁移。
- [ ] 用 Drizzle 添加同名表字段，类型保持上方契约；raw SQL 查询必须与字段命名一致，不映射成第二套存储结构。
- [ ] 实现读与 existing 标记：
```ts
export async function getPersonalSetup(database: D1Database, userId: string) {
  return database.prepare('SELECT * FROM personal_subscription_setup WHERE user_id = ?')
    .bind(userId).first<PersonalSetupRow>();
}
export function summarizePersonalSetup(row: PersonalSetupRow): PersonalSetupSummary {
  return {status:row.status, subscription_ids:JSON.parse(row.subscription_ids), run_id:row.run_id, dispatch_status:row.dispatch_status};
}
export async function recordExistingSetup(database: D1Database, userId: string) {
  const now = new Date().toISOString();
  await database.prepare(`INSERT INTO personal_subscription_setup
    (user_id,status,subscription_ids,dispatch_status,created_at,updated_at)
    VALUES (?,'existing','[]','sent',?,?) ON CONFLICT(user_id) DO NOTHING`)
    .bind(userId, now, now).run();
  const row = await getPersonalSetup(database, userId);
  if (!row) throw new Error('PERSONAL_SETUP_WRITE_FAILED');
  return row;
}
```
JSON 来自本功能自己写入的固定 string[]；若解析损坏，返回服务端错误，不当成“无记录”从而重建订阅。

- [ ] prepareDefaultSubscriptions 的控制流固定：
  1. `caps.sync===false` 返回 skipped/[]/null/none，无写入。
  2. 有记录：created→resumed，existing→existing；不创建、不旋转链接。
  3. 当前用户已有任何订阅：recordExistingSetup 后返回实际存储行；若并发已写created，返回resumed而非覆盖它。
  4. 无记录且无订阅：`resolveQuota(caps.sub_limit) < 3` 时抛已有 `EntitlementError('QUOTA_EXCEEDED',409,'订阅额度不足，无法准备三个个人订阅')`。
  5. 生成 runId、三条subscription id、三条link id与token。使用现有 generateUniqueToken/linkTokenExists，不改变 token 生成算法。
  6. 一个 D1 batch 写 setup+三条订阅+三条链接；setup.user_id PK 是并发创建门闩。一个语句失败整批回滚。
  7. batch异常后读取 setup：若存在，返回该已提交结果（竞争请求胜出）；若不存在，重新抛出真实异常，不吞掉未成功的写入。

固定批写模板：
```ts
const definitions = [
  ['personal_all','我的全部课表'],
  ['personal_courses','我的课程'],
  ['personal_exams','我的考试'],
] as const;
const runId = crypto.randomUUID();
const now = new Date().toISOString();
const rows = await Promise.all(definitions.map(async ([type,name]) => ({
  id:crypto.randomUUID(), linkId:crypto.randomUUID(), type, name,
  token:await generateUniqueToken(token => linkTokenExists(drizzle(env.DB), token)),
})));
const ids = rows.map(row => row.id);
await env.DB.batch([
  env.DB.prepare(`INSERT INTO personal_subscription_setup
    (user_id,status,subscription_ids,run_id,dispatch_status,created_at,updated_at)
    VALUES (?,'created',?,?,'pending',?,?)`).bind(userId,JSON.stringify(ids),runId,now,now),
  ...rows.map(row => env.DB.prepare(`INSERT INTO subscriptions
    (id,user_id,source_type,source_id,source_name,is_personal,is_active,
     sync_status,sync_run_id,sync_trigger,sync_requested_at,created_at,updated_at)
    VALUES (?,?,?,?,?,1,1,'queued',?,'initial',?,?,?)`)
    .bind(row.id,userId,row.type,userId,row.name,runId,now,now,now)),
  ...rows.map(row => env.DB.prepare(`INSERT INTO calendar_links
    (id,subscription_id,token,formats,is_default,created_at,updated_at)
    VALUES (?,?,?,?,1,?,?)`)
    .bind(row.linkId,row.id,row.token,JSON.stringify(LINK_FORMATS),now,now)),
]);
```
Cloudflare D1 batch 的事务/失败回滚语义已按官方文档核对：<https://developers.cloudflare.com/d1/worker-api/d1-database/#batch>。不要用三个现有 POST 串行调用代替批写，原POST会各自入队。

- [ ] 真实 D1 测试矩阵：
  - 重复调用两次：三个订阅/三个链接/一个setup，第二次resumed，token/id不变。
  - `Promise.all` 同用户两次：都可得到已提交状态，只存在三条。
  - 两用户并发：各自三条，source_id均为各自session user.id。
  - caps.sync=false：无任何写入。
  - sub_limit=0/1/2：409额度语义，无半成品；3与null成功。
  - 有一条旧订阅：existing，不补其他两条，不改旧链接。
  - 人为制造本次一条默认链接 token UNIQUE 冲突：三条订阅与setup整批回滚。
  - setup已created后删除其中一条再prepare：仍resumed，不复活。
  - DB异常但无已提交setup：返回错误，不伪装创建成功。
- [ ] `npm test -- src/routes/v2/subscriptions.test.ts` 与 `npm run typecheck`。提交建议 `feat(schedule): initialize default subscriptions atomically`。

## Task 06：首次投递恢复和单同步组

**Files**
- 新建 `src/services/personal-setup-dispatch.ts` 及测试。
- 修改 `src/cron/schedule-sync.ts`：producer开头调用未投递setup恢复；consumer只补已完成重复消息检查。
- 扩充 `src/cron/schedule-sync.harvest.test.ts`。

**Consumes**：Task05 的持久记录；现有 ScheduleSyncMessage 与统一 runId 的同步消费者。
**Produces**：
```ts
export function dispatchPersonalSetup(env: Env, userId: string): Promise<void>;
export function dispatchPendingPersonalSetups(env: Env): Promise<void>;
```

- [ ] 红测试先固定正常初始化只入队一条：用真实记录、mock Queue.send 外部边界；断言消息的 subscriptionId 属于当前setup、userId为本用户、runId为三条共同runId、trigger='initial'。不得发送三条消息。
- [ ] claim 使用服务端原子条件更新。lease为60秒，lease_token每次随机，WHERE必须同时含user_id、status='created'、dispatch_status未sent及lease_until到期条件。
```ts
const nowMs = Date.now();
const token = crypto.randomUUID();
const now = new Date(nowMs).toISOString();
const claim = await env.DB.prepare(`UPDATE personal_subscription_setup
  SET dispatch_status='sending', lease_token=?, lease_until=?, updated_at=?
  WHERE user_id=? AND status='created' AND dispatch_status!='sent' AND lease_until<=?`)
  .bind(token,nowMs+60_000,now,userId,nowMs).run();
if (claim.meta.changes !== 1) return;
```
已claim才读该用户本次run的实际订阅，按固定 `personal_all` 优先选择仍存在的一条。不存在任何同run目标（用户已删除/已手动新run替代）就把该lease标sent，不恢复删除内容。
- [ ] 发送一条消息并更新持久投递状态。final UPDATE 带user_id AND lease_token，过期owner不能覆盖新owner。
```ts
await env.SCHEDULE_SYNC_QUEUE.send({
  userId,
  subscriptionId: target.id,
  runId: row.run_id!,
  trigger: 'initial',
} satisfies ScheduleSyncMessage);
await env.DB.prepare(`UPDATE personal_subscription_setup SET dispatch_status='sent',
  lease_token=NULL, lease_until=0, updated_at=? WHERE user_id=? AND lease_token=?`)
  .bind(new Date().toISOString(),userId,token).run();
```
这里 `row` 是 getPersonalSetup 读取且status=created/run_id非空的本次行；`target` 是当前用户、同run_id的已有订阅。校验run_id非空后再构造消息，生产代码可用局部const收窄，不要求非空断言。
- [ ] Queue.send失败：带owner条件把dispatch_status改failed、lease_until设now+60s；将本run现存订阅标为 `QUEUE_UNAVAILABLE`，前端得到真实失败。不要回滚已创建订阅或链接。恢复投递前只将本run的 QUEUE_UNAVAILABLE 行重新置queued、清理对应错误，不覆盖新run或其他终态。对于从未开始（sync_started_at为空）的初次待投递/QUEUE_UNAVAILABLE行，把sync_requested_at设为这次实际投递时间，避免长时间停机后producer马上用cron新run覆盖刚恢复的initial。已经运行或正在capacity重试的请求时间绝不重置。
- [ ] producer的 `enqueueScheduleSync(env)` 开头先 `dispatchPendingPersonalSetups(env)`；此函数每次最多处理25条status=created且未sent、lease到期的行。单条恢复失败记录事件后继续其他用户，不使整个cron退出。请求重试同样调用dispatchPersonalSetup，不需要新基础设施或用户凭据。
- [ ] Queue不是DB事务的一部分。发送成功、sent标记写入前崩溃可造成同run重复投递，不能声称exactly-once。consumer读取subscription时额外读取sync_status，若消息runId匹配且sync_status为success或error终态则ack-return，放在markSyncRunning之前。queued自动重试仍可执行；旧run仍走原stale检查。不要更改全局markSyncRunning状态机或取消capacity退避。
- [ ] 添加真实consumer回归：一个initial消息把同run三个视图都写成success，抓取一次；同run终态重复投递不再次抓取；旧run不覆盖新run；失去sync权限时不抓取；一个视图删除后不复活。现有每batch promise缓存、共享ICS预生成和通知去重都保留。
- [ ] 并发/恢复测试：同时dispatch同用户只有一个send；有效lease不重复send；lease过期可接续；send失败标failed且不丢订阅；投递重试不创建新token；过期owner不能改写新lease；手动新run后旧setup不再投递。
- [ ] 运行该service测试与现有 `schedule-sync.harvest.test.ts`、`schedule-sync.test.ts`、`sync-status.test.ts` 和typecheck。提交建议 `feat(schedule): dispatch and recover one initial personal sync`。

## Task 07：默认订阅 API、列表恢复信息与删除保护

**Files**
- 修改 `src/routes/v2/subscriptions.ts`。
- 更新 `src/routes/v2/subscriptions.test.ts`。
- 新增的路由放在该app的动态路径之前，继承现有AUTH_LIMITER与sessionMiddleware。

**Produces**：
- `POST /api/v2/subscriptions/defaults`：无请求体；201创建、200恢复/已有/跳过。响应为 DefaultSubscriptionsResponse。
- `GET /api/v2/subscriptions`：保留 subscriptions/count，新增 `personal_setup: PersonalSetupSummary | null`，纯读取。
- DELETE：写入持久existing标记后删除，初始化不恢复用户删除的订阅。

- [ ] 红测试使用现有Hono fixture，fakeAuth增加可传的cquBindStatus，默认active；保留一个undefined兼容用例。断言结果不只看mock send。
```ts
it('initializes defaults through the authenticated route', async () => {
  const app = buildApp('userA', FULL_CAPS);
  const response = await app.request('/defaults', {method:'POST'});
  expect(response.status).toBe(201);
  const body = await response.json() as DefaultSubscriptionsResponse;
  expect(body.subscription_ids).toHaveLength(3);
  expect(body.dispatch_status).toBe('sent');
  const list = await (await app.request('/')).json() as {subscriptions:{user_id:string}[]};
  expect(list.subscriptions).toHaveLength(3);
  expect(list.subscriptions.every(row => row.user_id === 'userA')).toBe(true);
});
```
- [ ] 路由顺序与权限：
  1. 当前user来自 `c.get('user')`，caps来自 `c.get('caps').calendar`。
  2. 无sync：200 skipped，既不写setup也不查学校状态，不增加权益提示。
  3. bindStatus明确非active：409 `CQU_BINDING_REQUIRED`；unknown：503 `CQU_BINDING_STATUS_UNKNOWN`。unknown不能当unbound，不自动引用户重绑。
  4. 调prepareDefaultSubscriptions；created/resumed时调dispatchPersonalSetup；重新get记录返回最新dispatch_status。
  5. 额度异常沿用既有EntitlementError→errorResponse；不可恢复DB错误为503 `DEFAULT_SUBSCRIPTIONS_FAILED`，message「订阅准备未完成，请重试。」。
  6. Queue失败只影响dispatch_status=failed，已创建的响应依旧返回真实IDs；不能声称sync成功。

不接受userId/sourceId/studentId或自选订阅类型。即便请求带query/body身份字段，也不能影响当前用户；最好无体端点直接忽略body，不从body构建任何数据库字段。

- [ ] GET增加元数据：读取getPersonalSetup，存在则summarize。旧前端忽略新增字段，新前端对缺字段视为null，不把“未知”解释成初始化未完成而擅自创建。
- [ ] DELETE用同一个D1 batch先 `INSERT ... ON CONFLICT(user_id) DO NOTHING` existing marker，再原删除（仍先验证订阅归属）。已有created marker不覆盖。删除失败不能留下半个用户数据删除结果，FK cascade继续保留。
- [ ] 路由测试覆盖：未登录401；无sync skipped零写入；pending/revoked/unbound409；unknown503；他人ID注入不影响归属；配额不足全批不建；重复POST不换token；GET无写入；删除最后一个后再次POST不恢复；Queue失败显示failed且三行存在；sent后反复POST不重新入队或绕过手动刷新配额。
- [ ] 更新所有依赖精确list shape的既有测试，新增字段显式断言，禁止删掉原鉴权/配额用例。新增表必须加入所有使用list/DELETE的D1测试fixture，避免“生产迁移有、测试表没有”。
- [ ] `npm test`、`npm run typecheck`。提交建议 `feat(schedule): expose idempotent default subscription setup`。
