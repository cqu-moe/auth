# CQU 会话约定

实现入口：`src/durable-objects/cqu-session.ts`；主机策略：`src/services/service-url.ts`；浏览器协议：`src/services/cqu-node-protocol.ts`。

## 取票与凭证

- 所有取票入口收敛到 DO 的取票策略：校验 serviceUrl、scope/客户端授权、广域 quicklogin opt-in、限流和审计。新增入口不得绕过 DO 直接调用 SSO client。
- serviceUrl 只允许 HTTPS 的 CQU 子域。浏览器节点保留同策略的第二层校验；中止导航不代替主机白名单。
- HTTP Bearer、RPC client secret、网站会话各自遵循对应入口的鉴权契约，不能把一种凭证当作另一种的通行证。
- TGT cookie 为 `SOURCEID_TGC`；会话还涉及 `SESSION` 与瑞数 cookie。完整浏览器 `storageState` 才能用于水化，不拿旧三-cookie 状态代替。
- D1 的学校密码使用 AES-256-GCM；完整 storageState 存在 DO storage，应用层未另行加密。排查时不得将两者的保护边界混称，也不得输出会话内容。
- CQU SSO 请求需要浏览器 User-Agent；Workers AES-ECB 的 IV 使用空字符串。

## 时序与自动重登

- 账号与 QuickLogin 设备均不发定时 CAS 探活。真实业务取票失败仍走原有恢复路径；验证码等待、操作超时、失败退避、撤销和设备离线暂停各自保留。
- 每次成功登录用 `sampleCquReloginAt` 抽取一次重登时间并持久化为 `reloginAt`：99% 在 6–7 小时、1% 在 4–6 小时。旧账号会话在加载时、旧设备会话在维护时只迁移一次；状态查询、DO 重启和 alarm 重试沿用同一时间。平台延迟、验证码等待及失败退避可能使完成时间晚于计划时间。
- QuickLogin 会话可用期按 `loginAt + 7h` 计算，与随机重登时间分开，刷新期间保留尚可用的旧会话。设备自身心跳与 WebSocket 心跳用于在线状态，不是学校探活。
- 升级前已经出票的 QuickLogin 探活回执仍可完成去重记账；该兼容路径只操作内部状态，不再发起学校请求。
- 回写刷新或登录结果前重新验证会话版本/撤销状态；外部 I/O 期间可能发生解绑，旧结果不能复活会话。
- DO 单值大小守卫保留超限前的可用状态；避免异常触发 alarm 重试而反复铸票。
- 取票、登录与数据抓取使用各自的 deadline/budget；读当前实现和配置，不将历史固定超时套到全部操作。
- 休眠 WebSocket 的 ping/pong 由 `setWebSocketAutoResponse` 处理，保留无需唤醒 DO 的路径。

改动后分别验证纯函数策略与 Workers pool 的 DO 时序行为；真实学校登录、2FA、ST 未核销及无探活会话存活需单独记录现场证据。

## 外部共享目录

- `cquExternalDirectory` 是固定类型 RPC，只接受六类目录 catalog 或最多 10 个唯一数字 `classId` 的 instructors 批量。调用方不能传 URL、method、selector 或其它传输控制；教师批量没有部分成功，任一学校请求失败时整批失败，调用方稍后最多重试 10 个类。
- 目录动作经 `/external-directory` 进入既有 CquSession DO：复用 external search/search capture 的每用户浏览器互斥、限流与审计，浏览器阶段共享 90 秒预算；RPC 在浏览器等待后、返回结果前还会重新读取 `calendar.external` 权益和 active binding。
- 容器只在水合的 AllCourseSchedule 页面内调用固定业务 API。GET 使用页面组件的 `getRequest`，admin POST 使用 `postJsonRequest` 和绝对 timetable base；不得裸 `fetch`、读取或输出 header/cookie/token。所有学校请求串行，业务请求间隔随机 0.75–1.25 秒。
- 每次动作前后都读取当前学业 API session，并要求页面中恰好一个目录 Vue 组件、恰好一个数字 `sessionId`，且三者与调用方 `expectedSessionId` 一致；无法确认当前页面学期时返回 `CURRENT_SESSION_UNVERIFIED`，绝不替用户切换学期。instructors 的 `expectedSessionId` 必填；catalog 可选但一旦提供必须精确匹配。
- 输出只保留合同字段：目录行 ID 全局唯一且数量必须严格小于固定上限（不截断），名称/extra 不超过 200 字符，可选 `departmentId`/`grade`/`courseCode` 都是不超过 100 字符的字符串。admin 班级可把学校整数年级规范成字符串；学校缺 `departmentId` 时只用完整部门名在部门树中唯一匹配的 ID 回填，歧义或未匹配则省略。course catalog 的 canonical `courseCode` 只来自 `codeR`。
- 现场证据只支持“当前选定学期页面 + 当前学业 API 一致”的读取。学校接口没有独立 total，也未证明历史学期与当前 bulk 结果的完全隔离；不要把这些接口描述成全历史枚举，也不要移除页面学期 guard。
