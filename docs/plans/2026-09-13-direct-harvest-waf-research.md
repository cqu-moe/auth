# CQU Direct Harvest / 瑞数 WAF 调研与修改方案

日期：2026-09-13

范围：Auth Direct CAS 登录、Direct `my.cqu.edu.cn` harvest、Schedule 个人课表消费。

结论状态：已有生产诊断与隔离探针证据；实现方案可交给 Agent 直接拆任务执行。

## 1. Executive summary

当前 `WAF_CHALLENGE` 主要是一个**误分类的 capture 超时桶**，不等价于“瑞数拒绝浏览器”或“Cloudflare IP 被拦”。

最重要的生产证据是：

- 首个 curriculum document 返回 412，这是瑞数预期挑战。
- 浏览器最终到达 `https://my.cqu.edu.cn/workspace/curriculum`，页面标题为“智慧教务 - 重庆大学”，渲染后 body 约 292KB。
- 多个已登录 API 均为 200：`session/info-detail`、`session/list`、`session-release-schedule`、`judge-release-schedule-stu`、`maxWeek`、`cur-week`、考试列表。
- 失败样本没有 request failure。
- 唯一缺失的必需 capture 是 `my-table-detail`。
- 容器诊断给出 `waitedMs=30000`，正好等于当前 Cloudflare capture 上限。
- 一次性真实 storage-state 探针在约 46.1 秒才捕获到 `judge-release-schedule-stu` 200，已越过普通 harvest 的 30 秒边界。

因此首要修复不是换 IP、专用出口或全量换大容器，而是：

1. 把瑞数 bootstrap、应用 ready、课表请求、响应 body 完成、GET 补数拆成独立状态。
2. 用事件驱动等待替换固定 3 秒登录渲染等待和 30 秒 harvest 盲等。
3. 给 `my-table-detail` 单独 75–90 秒等待预算。
4. 失败前先在同一个 browser context 里 soft wait / soft reload，不要立刻换新浏览器。
5. 只有完整成功后回写刷新后的 storage state。
6. 把 `WAF_CHALLENGE` 拆成稳定错误码。

## 2. 412 到底是什么

瑞数 Botgate 把 412 用作首跳动态挑战响应，不是常规业务语义上的“Precondition Failed”，也不是最终拒绝。

流程：

```
fresh browser / 缺少或过期动态 cookie
  → GET 受保护 URL 返回 412 + 动态 VM JS
  → 真 Chromium 执行 VM
  → VM 写动态 cookie
  → 页面自动 reload / 302
  → 后续请求通过
```

Cookie 对应关系：

| Host | 服务端静态 cookie | VM 动态 cookie | 说明 |
|---|---|---|---|
|`my.cqu.edu.cn` | `CtLgrmkSWHBZS` | `CtLgrmkSWHBZT` | GET API 需要有效 S+T；POST 还需要页面 VM 现算一次性 `CAqWHAeT`。 |
|`sso.cqu.edu.cn` | `CtLgrmkSWHBZO` | `CtLgrmkSWHBZP` | CAS 登录页门禁。 |

Direct 课表的特殊性：

- GET endpoint：有效 S+T 即可。
- POST `my-table-detail`：必须由真实页面自然发起，让 VM 生成 fresh `CAqWHAeT`。
- 重放已用 `CAqWHAeT` 可能 400；缺失则可能 412。

### 隔离 Cloudflare 挑战时间线

以下为未登录隔离探针，时间包含 Chromium 启动：

| Cloudflare location | 412 | 动态 cookie | 302 | 真实 SSO 页 200 |
|---|---:|---:|---:|---:|
| SIN | 5.28s | 6.17s | 10.19s | 11.18s |
| KIX | 3.32s | 4.27s | 7.63s | 8.44s |
| KIX | 3.31s | 4.79s | 13.90s | 14.62s |
| KIX | 3.72s | 5.40s | 16.20s | 16.95s |

早前 MAA / SIN / KIX 样本也均完成挑战。未见“APAC Cloudflare 出口被瑞数随机硬拦”的证据。

## 3. 当前代码链路与失败点

### 3.1 登录

相关文件：

- `container/browser_profile.py`
- `container/cqu_login.py`

当前 Cloudflare profile：

- login navigation 60s；
- 固定 login render wait 3s；
- form navigation 60s；
- post submit wait 20s。

登录循环固定等 3 秒看 `#login-croypto`，然后 reload。隔离时间线显示动态 cookie 约 4–6 秒出现，真实 SSO 页约 8–17 秒出现，因此 3 秒 reload 有概率打断 VM。

### 3.2 Harvest

相关文件：

- `container/cqu_data_harvest.py`
- `container/server.py`
- `src/services/cqu-node-protocol.ts`
- `src/durable-objects/cqu-session.ts`
- Schedule：`src/services/cqu-harvest.ts`、`src/cron/schedule-sync.ts`

当前行为：

1. 从持久 state 创建 fresh context。
2. navigate `/workspace/curriculum`，允许首个 412。
3. 最多盲等 30 秒直到 expected captures 全齐。
4. 串行执行 in-page GET。
5. 如果 capture 未齐且页面不是 CAS 登录页，抛 `HarvestTransientError`。
6. Container 回 502 `HARVEST_TRANSIENT`。
7. Auth 把这类 transient 全部映射为 `WAF_CHALLENGE`。

这个映射把多种完全不同的问题折叠成一个误导性错误码。

## 4. 证据

### 4.1 生产失败样本

脱敏诊断：

```json
{
  "navUrl": "https://my.cqu.edu.cn/workspace/curriculum",
  "expectedPatterns": ["my-table-detail", "session/info-detail"],
  "capturedPatterns": ["session/info-detail"],
  "missingPatterns": ["my-table-detail"],
  "goto": {"status": 412},
  "waitedMs": 30000,
  "pageUrl": "https://my.cqu.edu.cn/workspace/curriculum",
  "title": "智慧教务 - 重庆大学",
  "pageBody": {"bytes": 292405, "hasTs": false, "hasCasLogin": false},
  "requestFailures": [],
  "elapsedMs": 48315
}
```

生产响应状态：

| Endpoint | 状态 |
|---|---:|
| curriculum document | 412 |
| enrollment-confirm | 200 |
| session/info-detail | 200 |
| session/list | 200 |
| session-release-schedule | 200 |
| judge-release-schedule-stu | 200 |
| maxWeek/1061 | 200 |
| exam list GET | 200 |
| cur-week | 200 |
| my-table-detail | 未观察到 |

结论：

- 瑞数 bootstrap 已完成。
- Direct 应用已到达已登录页面。
- 页面持有的 access token 可用。
- 浏览器未报 network request failure。
- `WAF_CHALLENGE` 在该样本中的真实含义是“课表 capture 缺失”，不是“所有请求被 WAF 拦截”。

### 4.2 一次性真实 storage-state 探针

隔离 Worker 临时创建 OAuth client，调用 Auth `cquHarvest` 使用既有真实 storage state，最后删除 client。未输出 Cookie、token、密码或课表内容。

只捕获 `judge-release-schedule-stu` 的结果：

```json
{
  "elapsedMs": 46132,
  "captureStatus": 200,
  "judge": {
    "status": "success",
    "msg": "判断是否发布课表",
    "data": "",
    "code": "success",
    "ok": true
  }
}
```

解释：

- `data: ""` 不能单独证明“未发布”；OpenAPI 示例同样为空。
- 关键是时间：该前置响应在普通 harvest 的 30 秒 capture 边界之后才可用。

### 4.3 前端 bundle 证据

真实页面加载：

- `https://my.cqu.edu.cn/workspace/static/js/app.57899e34.js`
- 约 2.7MB。

Router：

```
/workspace/curriculum
  → chunk-577be296
  → chunk-7c47d442
  → Curriculum component
```

API service：

```
releaseScheduleStudentNote()
  → POST /coursearrange-param/judge-release-schedule-stu

stuCourseSchedule(sessionId, body)
  → POST /class/timetable/student/my-table-detail?sessionId=...
```

`my-table-detail` 位于冷加载 2.7MB app bundle、lazy route chunks 和多个前置 API 之后。0.25 vCPU basic 容器上，这条链路可能越过 30 秒。

## 5. 根因评估

### 直接原因已经可以闭环

`my-table-detail` 缺失的直接原因不是“请求发了但被瑞数吞掉”，也不是“接口返回 412 后没有恢复”，而是：

```
当前 harvest 在导航后 30 秒停止等待
  → Curriculum 前端还未完成 judge-release-schedule-stu 前置链路
  → 尚未执行 stuCourseSchedule(sessionId, ...)
  → my-table-detail 请求根本没有发出
  → capture 缺失被 Auth 包装成 WAF_CHALLENGE
```

证据链：

1. 生产失败样本中最终页面是已登录“智慧教务”，不是挑战页或 CAS 登录页。
2. `session/info-detail`、`session/list`、`session-release-schedule`、`judge-release-schedule-stu`、`maxWeek`、`cur-week` 等前置 API 均 200。
3. 没有任何 request failure。
4. 真实 storage-state 一次性探针显示 judge 响应约 46.1 秒才可用，已越过普通 harvest 的 30 秒边界。
5. 前端 bundle 明确显示 `my-table-detail` 由 `stuCourseSchedule(sessionId, body)` 在课程表 route 中发起，位于 judge 之后。

因此“为什么缺 `my-table-detail`”在业务时序层面已经闭环：**等待截止时前端尚未走到发起该请求的阶段**。

尚未闭环的是“为什么 0.25 vCPU 冷启动走到 judge 需要 40 多秒”。当前最强解释是 2.7MB app bundle + lazy route chunk 冷解析、多个前置请求、以及旧 storage state 导致的额外授权/挑战。这个底层耗时原因需要 stage instrumentation 与 basic/standard-1 A/B 最终确认，但不应阻塞直接修复：先按事件驱动等待和 90 秒 table 预算修复，同步收集数据。

### 高置信

1. **`WAF_CHALLENGE` 是 overloaded classification。**
   它覆盖 missing capture、browser exception、network exception、non-JSON container response、真实 WAF 响应等。

2. **本次生产失败是 capture timeout，不是瑞数 bootstrap 失败。**
   浏览器到达已登录 Direct 应用，且多个 API 200。

3. **30 秒不是完整课表链路的安全预算。**
   judge 前置响应在真实 state 探针中约 46 秒才捕获。

4. **Cloudflare egress/IP 不是主要修复点。**
   MAA / SIN / KIX 均可通过初始挑战。

### 中置信

1. **0.25 vCPU 冷启动解析 2.7MB JS + route chunk 是主要延迟来源。**
   证据强，但尚未完成 logged-in basic vs standard-1 A/B。

2. **harvest 后丢弃 refreshed state 使后续操作更冷。**
   harvest context 可刷新 S/T 和 my.cqu localStorage，但当前代码关闭 context 后不回写。

### 待验证

`my-table-detail` 未发的精确前端分支尚未证明。候选：

- lazy route chunk 仍在加载/执行；
- prerequisite 响应晚于等待边界；
- judge/user/session 分支未进入课表请求；
- response event 已出现但 body 未完成；
- stale state 导致额外授权/bootstrap。

必须先加 stage counters，不能把任一候选写成最终定论。

## 6. 容器规模与成本

Cloudflare Containers 计费：

- memory：$0.0000025 / GiB-second，按 provisioned memory 计；
- CPU：$0.000020 / vCPU-second，按 active usage 计；
- Workers Paid included：25 GiB-hours/month，375 vCPU-minutes/month。

| Type | vCPU | Memory | 理论最大 active cost/s |
|---|---:|---:|---:|
| basic | 0.25 | 1GiB | $0.0000075 |
| standard-1 | 0.50 | 4GiB | $0.000020 |

90 秒 harvest 例子：

| 场景 | 理论最大 active cost |
|---|---:|
| basic 90s | $0.000675 |
| standard-1 90s | $0.0018 |
| standard-1 若降到 45s | $0.0009 |
| basic 失败并完整重试 3 次，3×90s | $0.002025 |

当前流量下绝对差价很小。1000 次逻辑 harvest/月时：

- basic 90s 大致用完 included memory 与 CPU；
- standard-1 即使时间减半，仍会消耗约 4 倍 memory allowance，可能额外约 $0.7/month memory 超额，另计 CPU 超额。

### 建议

默认先使用 **basic + 事件驱动等待**。当前证据说明存在等待/分类 bug，不足以证明必须全量换大容器。

`standard-1` 只作为 **受控 canary**，用于反复出现 `TABLE_CAPTURE_TIMEOUT` 的测试账号。只有当其显著降低 p95 或消除重试，才考虑推广。

不要用用户主账号做重复容器 A/B。

## 7. 修改方案

### Task 1：生产级 stage instrumentation

修改 `container/cqu_data_harvest.py`，输出脱敏 stage timeline。

Required stages：

```text
NAV_START
FIRST_RESPONSE
DYNAMIC_COOKIES_PRESENT
APP_DOCUMENT_REACHED
APP_JS_RESPONSE
ROUTE_CHUNK_RESPONSE
APP_READY_API
JUDGE_RESPONSE
TABLE_RESPONSE_SEEN
TABLE_BODY_READY
GET_FETCH_START
GET_FETCH_END
DONE / stage-specific failure
```

每个 stage 只记录：

- relative milliseconds；
- 去掉 query/fragment 的 URL；
- HTTP status；
- resource type；
- content type；
- body bytes 与 JSON/HTML 形状；
- `hasTs`、`hasCasLogin` 等泛化 marker。

绝不记录：

- cookie 值；
- Authorization；
- `CAqWHAeT`；
- 课程/考试 body；
- student ID；
- storage state。

关键实现修正：Playwright response event 出现时立刻记 `TABLE_RESPONSE_SEEN`，不要等 `resp.text()` 完成才记 seen。body ready 单独记录。

验收：

- response seen 与 body ready 分离；
- body 读取失败不影响 response seen；
- 诊断不含 query、Cookie、Authorization、body 正文；
- container 测试全绿。

### Task 2：事件驱动 CAS 登录等待

替换固定 3 秒 render/reload。

```
navigate SSO login
  ↓
等动态 cookie pair，20s，100ms poll
  ↓
等 login form marker，30s
  ↓
#login-croypto 与 execution/flowkey 均存在后才 submit
```

仅以下情况 reload：

- 20 秒无动态 cookie；
- 30 秒无 login form。

正常路径不得因 3 秒到期 reload。

拟人节奏：

- typing char delay 60–160ms，偶发 250–400ms pause；
- click 前 150–450ms；
- tab 切换后等元素可见，再等 200–500ms。

验收：

- fake timer 覆盖 cookie-before-form、form-before-cookie、双超时、成功；
- 真浏览器 smoke 不靠手动 reload 到 2FA。

### Task 3：Harvest stage-specific wait

替换单一 30 秒 capture loop。

建议常量：

```python
DYNAMIC_COOKIE_WAIT_MS = 30_000
APP_READY_WAIT_MS = 45_000
JUDGE_WAIT_MS = 60_000
TABLE_WAIT_MS = 90_000
HARVEST_OVERALL_TIMEOUT_S = 180
```

状态机：

```
navigate /workspace/curriculum
  ↓ 首个 412 预期
等 S+T cookie
  ↓
等 app-ready API：session/info-detail / session/list / cur-week
  ↓
等 judge-release-schedule-stu response
  ↓
等 my-table-detail response seen
  ↓
等 my-table-detail body ready
  ↓
串行 GET 补数
```

如果 app-ready 与 judge 已完成但 table 缺失：

1. 同 context 继续等 15–25s；
2. 随机等 4–8s；
3. reload 同一 page 一次；
4. 再等 45s；
5. 仍未出现才返回 `TABLE_CAPTURE_TIMEOUT`。

不得在 same-context recovery 前启动全新浏览器。

验收：

- 30 秒不再截断 route；
- same-context recovery 有测试；
- overall timeout 低于 Auth 210s operation budget；
- 所有失败仍保留旧课表数据。

### Task 4：成功后回写 refreshed state

当前 harvest 成功后丢弃 context 的 refreshed storage state。

修改：

1. `harvest()` 在所有 required captures 与 GET 成功后导出 `context.storage_state()`。
2. 仅成功响应携带 state。
3. Node protocol 增加可选 `state`。
4. Auth DO：
   - 检查 size guard；
   - 验证 required CAS cookies 与 origin shape；
   - 仅完整成功后持久化；
   - partial/failed harvest 绝不覆盖好 state。

验收：

- DO 测试证明 failed/partial 不覆盖旧 state；
- oversized refresh 被拒绝且保留旧 state；
- 成功 harvest 原子刷新 state。

### Task 5：拆错误码

用稳定 code 替代泛化 `WAF_CHALLENGE`：

| Code | 含义 |
|---|---|
|`WAF_BOOTSTRAP_TIMEOUT` | 动态 S+T/O+P cookie 未出现。 |
|`WAF_CHALLENGE` | 必需请求实际返回 412。 |
|`APP_READY_TIMEOUT` | 已登录 app document 或前置 API 未出现。 |
|`TABLE_CAPTURE_TIMEOUT` | app/judge ready，但 table 请求从未出现。 |
|`TABLE_BODY_TIMEOUT` | table response seen 但 body 未完成。 |
|`TABLE_REQUEST_HUNG` | table request seen 但无 response。 |
|`SCHEDULE_NOT_PUBLISHED` | 明确证明未发布。 |
|`TABLE_API_REJECTED` | table endpoint 非 2xx。 |

Schedule retry：

- `WAF_BOOTSTRAP_TIMEOUT` / `APP_READY_TIMEOUT` / `TABLE_CAPTURE_TIMEOUT`：有界退避；
- `SCHEDULE_NOT_PUBLISHED`：本 run 不重试；
- `TABLE_API_REJECTED`：默认 fail-closed，除非明确 transient。

### Task 6：Retry 与 jitter

同一逻辑操作内：

- Ruishu VM 执行期间不加人工 delay；
- same-context soft recovery 先于新浏览器；
- GET fetch 串行，间隔 250–800ms random；
- soft reload 最多一次。

Queue 外部重试：

| Attempt | 当前 | 建议 |
|---:|---:|---:|
| 1 → 2 | 30s fixed | 30–60s random |
| 2 → 3 | 120s fixed | 120–240s random |
| 3 → 4 | 300s fixed | 300–600s random |

不要随机化：

- `CAqWHAeT`；
- POST URL cipher；
- 已有 storage state 的浏览器身份。

### Task 7：稳定 identity pool

只在 fresh login / 新 storage state 创建时选择 identity，并全程绑定。

示例：

```json
{
  "profileId": "stable-2",
  "viewport": {"width": 1536, "height": 960},
  "locale": "zh-CN",
  "timezoneId": "Asia/Shanghai",
  "userAgentSource": "native-patchright"
}
```

规则：

- 新 CAS login 时分配 profile；
- `profileId` 与 session state 一起持久化；
- 该 state 后续所有操作使用同一 profile；
- 仅新 login 可换 profile，绝不在既有 state 中途换；
- 不手写任意旧 Chrome UA，除非镜像确实包含对应 build；
- 初期 UA 用 native Patchright，只变化 viewport/profile metadata；
- locale/timezone 固定，除非提供真正匹配的多个浏览器 build。

这满足“身份池”的思路，同时避免把未验证的 UA 伪装当成结论。

### Task 8：合并 Schedule 两阶段 harvest

当前 Schedule：

1. 第一阶段：table + session list + exam GET；
2. 若缺学期开始日期，第二阶段再次 navigate，取 session detail。

这会冷加载 2.7MB app 两次。

首选容器原语：

1. capture session info；
2. parse `curSessionId`；
3. 同一 page 内 GET `/api/resourceapi/session/info/{curSessionId}`；
4. 一并返回第一阶段 capture 与动态 semester detail。

如不能立刻加入 generic primitive，应新增 narrowly typed Direct personal-harvest operation，不扩大 SSRF 面。

验收：

- 常见逻辑 harvest 只 navigate app 一次；
- semester begin date 仍 mandatory；
- 课程/考试解析与旧数据保护不变。

## 8. 后续实验

### E1：basic timing distribution

使用授权测试账号，不使用用户主账号。

- 20 次真实 logged-in harvest；
90 秒 table 预算；
- 随机调度；
- 收集每个 stage p50/p95。

指标：

- table 成功率；
- app JS / route chunk / app-ready / judge / table 时间；
- retry 次数；
- 是否保留旧数据。

### E2：basic vs standard-1

随机顺序执行 20 basic + 20 standard-1。

必须使用同一测试账号与相同 identity profile。

比较：

- app JS duration；
- route chunk duration；
- app-ready；
- judge；
- table response/body；
- active seconds；
- retry count。

只有显著降低 p95/retry 才推广 standard-1。

### E3：same-context recovery

在 app-ready 且 judge 成功但 table 缺失的样本上测量：

- 再等 25s 的恢复率；
- soft reload 的恢复率；
- 与全新浏览器的成功率/耗时对比。

### E4：refreshed-state persistence

A/B：

- 当前持久 state；
- 成功 harvest 后刷新的 state。

测量：

- initial 412 rate；
- S+T 出现时间；
- app-ready 时间；
- table 成功率。

### E5：identity pool

初始 4 个 stable profile：

- native Patchright UA；
- zh-CN；
- Asia/Shanghai；
- 仅变化 viewport/window metadata。

fresh login 时分配并持久化。比较 stable native identity 与 4-profile pool。

不在既有 state 上轮换身份。

## 9. “百分百稳定获取课表”的目标态方案

### 9.1 可承诺与不可承诺的边界

任何外部系统客户端都无法在学校服务整体不可用、账号被冻结、密码失效、教务系统未发布课表、或学校强制改变协议时保证“立即成功”。因此工程上可交付的百分百承诺应定义为：

> 在学校服务可用、用户账号有效、课表已发布的前提下，系统不因瑞数挑战、前端加载慢、单次容器冷启动、单次网络抖动或单次 capture 超时而放弃；持续按有界策略尝试，直到拿到完整、结构有效、非空的课程与考试数据。若学校侧暂不可用，系统保留最后一次有效课表，标记明确的可重试错误，并在后续自动恢复。

换言之：

- **成功判定 100% 严格**：只有拿到 `my-table-detail` 2xx、有效 JSON、课程结构、学期日期和考试结构，才允许落库。
- **数据完整性 100%**：失败绝不覆盖旧课表。
- **可用性目标**：学校可用时最终成功，不把一次 30 秒超时当成终态。
- **不可抗力**：学校自身不可用时进入可解释退避，不伪造成功。

### 9.2 目标态架构

```
Schedule Queue
  ↓
Auth CquSessionDO（单一用户状态与预算）
  ↓
Direct Harvest Orchestrator
  ├─ Phase A: 复用持久 storageState / identity profile
  ├─ Phase B: 瑞数 bootstrap（S+T cookie 事件等待）
  ├─ Phase C: 智慧教务 app ready（app.js + route chunk + 前置 API）
  ├─ Phase D: judge-release-schedule-stu
  ├─ Phase E: my-table-detail response + body
  ├─ Phase F: 同一 context 内 dynamic semester detail + exam GET
  ├─ Recovery L1: 继续等待 25s
  ├─ Recovery L2: 同 context reload 一次，再等 45s
  ├─ Recovery L3: 重建 fresh browser context，复用同一 storageState
  └─ Recovery L4: 自动 CAS relogin 一次，重建 state 后再跑 A–F
  ↓
严格结构校验 / 非空校验 / 旧数据保护
  ↓
成功后回写 refreshed storageState + identity profile
  ↓
D1 / ICS
```

### 9.3 一级路径：Direct 浏览器 organic harvest

这是主路径，不应换成纯 HTTP。

固定原则：

1. **真实 Patchright 页面自然发起 POST**，不手工构造、不重放 `CAqWHAeT`。
2. **首个 412 视为预期挑战**，不作为失败。
3. **事件驱动等待**：
   - S+T cookie 出现；
   - app ready API 200；
   - judge 200；
   - table response seen；
   - table body ready。
4. **`my-table-detail` 专用 90 秒预算**。
5. **整体 harvest 180 秒预算**，仍低于 Auth 210 秒容器操作预算。
6. **同一浏览器 context 内先恢复**，不得一失败就换新浏览器。
7. **成功后回写刷新后的 state**，减少下一轮冷启动。
8. **一次逻辑同步只导航一次 app**，动态补 semester detail，避免重复加载 2.7MB bundle。

### 9.4 二级恢复：fresh context + 同一登录态

如果 same-context recovery 失败：

1. 关闭旧 page，但保留已验证 storageState；
2. 新建 browser context；
3. 使用同一 identity profile；
4. 重新执行 Direct harvest；
5. 禁止切换 UA / locale / timezone / viewport；
6. 仅在 table 仍未发出时返回 `TABLE_CAPTURE_TIMEOUT`，进入下一级。

### 9.5 三级恢复：自动 CAS relogin 一次

如果 fresh context 仍失败，或诊断显示：

- S+T cookie 无法生成；
- 页面反复落 CAS；
- TGT_EXPIRED；
- token/session 过期；

则执行一次自动 CAS relogin：

1. 解密既有凭据；
2. 使用现有邮件 OTP 流程；
3. 事件驱动等待 SSO 表单，不用固定 3 秒 reload；
4. 生成新 storageState；
5. 继承同一 identity profile；
6. 立即重跑 Direct harvest；
7. 只在完整成功后覆盖旧 state。

### 9.6 四级兜底：有界外部重试

Queue 级重试采用全抖动指数退避：

| Attempt | 延迟 |
|---:|---:|
| 1 → 2 | 30–60s |
| 2 → 3 | 120–240s |
| 3 → 4 | 300–600s |
| 4 → 5 | 600–900s |

每个 run 最多 5 次外部尝试。之后保留旧数据并标记可重试错误，等待下一个 cron/manual refresh。不要无限重试，避免把学校风控打热。

### 9.7 为什么这不是“再等久一点”这么简单

仅把 30 秒改成 90 秒能显著改善，但还不是目标态。目标态同时解决：

- 过早判定：capture 与业务阶段绑定；
- 冷启动成本：成功后回写 refreshed state；
- 重复加载：两阶段合并；
- 错误误导：WAF 与前端未发起分开；
- 行为一致性：identity profile 与 storageState 终身绑定；
- 失败污染：结构校验和旧数据保护；
- 外部重试雪崩：有界全抖动。

### 9.8 验收标准

实现 Agent 完成后必须证明：

1. 一次真实用户 Direct harvest 拿到 `my-table-detail` 2xx 与有效课程 JSON。
2. `my-table-detail` response seen 与 body ready 都有毫秒级时间。
3. judge、route chunk、app ready、table 各阶段时间可观测。
4. 正常路径只加载一次 curriculum app。
5. 人为延迟 table 响应时，90 秒内不误报 WAF。
6. table 未发出时，same-context reload 能恢复。
7. harvest 成功后 refreshed state 被持久化。
8. harvest 失败后旧 state 与旧课表均不变。
9. CAS relogin 后继承 identity profile。
10. Queue 重试延迟带随机抖动且有上限。
11. 任何失败都不会用空课程/空考试覆盖旧数据。
12. 连续 20 次授权测试账号 harvest 全部拿到完整结构；若出现失败，日志能定位到唯一阶段。

### 9.9 上线后的运行目标

按学校可用时统计：

| 指标 | 目标 |
|---|---:|
| 第一轮 harvest 成功率 | ≥ 90% |
| same-context recovery 后成功率 | ≥ 96% |
| fresh context 后成功率 | ≥ 98% |
| 自动 relogin 后最终成功率 | ≥ 99.5% |
| Queue 有界重试后最终成功率 | 接近 100%（学校可用时） |
| 数据污染 / 空数据覆盖 | 0 |

如果 standard-1 canary 将 p95 或成功率改善到足以抵消 4 倍内存成本，再将重复失败用户迁移到 standard-1；否则保持 basic。

## 10. Rollout

1. 先合 instrumentation 与错误分类，不改等待行为。
2. 部署 Auth，观察一个 cron cycle。
3. 合 event-driven wait 与 same-context recovery。
4. 用授权测试账号跑 E1/E2。
5. 合 Schedule phase merge 与错误码处理。
6. Auth 先部署，Schedule 后部署。
7. 监控：
   - stage success rate；
   - table p50/p95；
   - retry rate；
   - 旧日历保留；
   - active seconds；
   - 用户可见错误文案。

回滚触发：

- 任何空课表/空考试覆盖；
- credential death 被误判；
- p95 接近 210s budget；
- 容器内存失败；
- identity 变更后 `WAF_BOOTSTRAP_TIMEOUT` 上升。

## 11. 调研结束时的部署与清理状态

- Production Auth 已包含脱敏 harvest diagnostics：commit `89d39a0` / Worker version `acc11586…`。
- 该诊断不改变 harvest 流程。
- 一次性真实 state Worker 已删除。
- 临时 OAuth client readback 为 0 行。
- 未输出 Cookie、token、密码或课表正文。

无账号数据隔离探针 `cqu-waf-probe-20260913`、
`cqu-waf-timeline-probe-20260913`、`cqu-waf-bench-basic-20260913` 和
`cqu-waf-bench-standard-20260913` 的 Worker、Container 与 probe image tag
均已删除。最终只保留生产 `cqu-moe-auth-cqulogincontainer` 及其镜像。

## 12. 给实现 Agent 的执行顺序

1. Stage timeline + response-seen/body-ready 分离。
2. 登录固定 3s reload 改事件驱动。
3. `my-table-detail` 90 秒专用等待 + same-context recovery。
4. 拆稳定错误码。
5. 成功后回写 refreshed state。
6. 合并 Schedule 两阶段导航。
7. Queue retry 加有界 jitter。
8. 授权测试账号跑 basic vs standard-1 与 identity pool 实验。

不要从 IP rotation、dedicated egress、全量 standard-1 开始。当前证据不支持这些作为首要修复。
