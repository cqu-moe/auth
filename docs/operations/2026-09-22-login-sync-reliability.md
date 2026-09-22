# 登录与同步可靠性修复

日期：2026-09-22（Asia/Shanghai）

## 用户目标

统一登录、取票、保活和采集的浏览器控制方法，修复同步长尾及生命周期错误。用户已授权使用本人的现有 CQU 绑定进行端到端测试；报告和测试产物不得包含密码、OTP、Cookie、票据或学生数据。

## 已确认的生产基线

- Auth 源码基线 `a1f817d`；生产 Worker `95071611-be53-451f-bc3d-3f59476948b9`。
- Schedule 源码基线 `564ecb7`；生产 Worker `7689c088-2528-42f8-8fad-1acd42fe2388`。
- PostHog 项目 608620，原图表 [同步耗时 p95](https://us.posthog.com/project/608620/insights/BjptXzwO)，统计最近30天 production `schedule_sync_completed.duration_ms`，按天展示；该值从首次排队计至终态，并非浏览器执行时间。治理指标目录为空，因此本次诊断口径不是已治理指标。
- 2026-09-16 至 22 的日 P95（毫秒）：2283678.35、1895586、2053497.4、1898985.3、1862285.6、2098795.2、1883396.5；22日尚未结束。无数据日期的图表0不代表耗时0。
- 自动同步固定铺满3600秒：两条任务延迟0/1800秒；三条延迟0/1200/2400秒。事件时间线与此一致。
- D1 实例：请求 `2026-09-21T21:00:36.278Z`，开始 `21:30:52.267Z`，完成 `21:31:57.000Z`；等待1815.989秒、最后一次执行64.733秒，session_recovery_attempts=0。其余5条最新个人订阅也全部成功，无会话恢复尝试。
- PostHog 有一条历史 production schema smoke（release=posthog-fresh），不可当真实业务样本。
- Auth 当前浏览器登录使用手写CDP；取票/保活/采集使用Patchright并重新启动浏览器。运行态因此存在不同启动参数、身份、状态恢复和清理逻辑。

## 修复设计

1. 保留用户原有一小时分散调度及30秒批次等待，不调整调度节奏。修正P95只统计正式执行时间；排队和端到端时间另列；新旧埋点口径通过版本/新字段隔离。调度工具和配置相对原版本无改动。
2. 修复Queue消费异常被allSettled吞掉而隐式确认的风险，统一平台投递次数与会话恢复预算。保留run CAS及旧日历数据。
3. 已确认过期的TGT按原会话身份失效；登录失败不得把已失效会话恢复active；迟到的探活结果不得覆盖新会话。
4. 统一为共享Chromium/CDP运行层：启动和退出、连接、存储恢复、页面交互、网络事件与响应、票据拦截均只有一个实现。业务配方与状态机保留清晰边界。
5. 先用无网络/本地页面回归测试覆盖竞态及资源回收，再在实际Cloudflare容器验证登录、邮件2FA、取票、保活、课表采集和Schedule写入。

## 方法选择依据

- [Patchright官方](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-python)基于Playwright，现有API迁移成本低；但历史生产记录显示旧登录实现发码400，而CDP实现曾恢复7个账号。该记录是实现差异证据，不能归纳为库绝对不兼容。
- [nodriver](https://github.com/ultrafunkamsterdam/nodriver)和[Zendriver](https://github.com/cdpdriver/zendriver)都封装CDP。新增库并不能替代本业务的票据拦截、邮箱租约、等待预算和状态恢复。当前采用现有CDP基础统一，避免再加入第三套驱动。
- 一致的浏览器状态和基于实际页面的交互优先；不把任何库宣传的不可检测当验收条件，不引入随机指纹轮换。

## Schedule 生产验证

- 已签名提交 `13ef37c`，Git Connector build `b7f5b0b7-c1fc-42b1-9934-3e0bbdd32ff3` 成功；生产版本 `c3b28ee5-6b2e-49bd-bb28-f3bb8ec81702`。线上 health 返回 commit=13ef37c。
- `wrangler.jsonc` 和 `src/utils/queue.ts` 与原基线无差异，producer 保留 `spreadEnqueue(...,3600,10,3600)`。
- 本人授权手动同步成功：`07:18:14.236Z` 请求、`07:18:46.696Z` 正式开始、`07:19:58.016Z` D1成功终态。PostHog终态上报执行71845ms、总历时104305ms，两者差32460ms对应排队；delivery_attempt=1，session_recovery_attempts=0。
- 原P95图表已更新为 `duration_basis=execution_v2` 的 `duration_ms`，标题“同步执行耗时 p95（不含排队）”；执行查询读回9月22日71845ms，当前仅一个新口径样本，不代表稳定总体P95，也不是浏览器加速效果。
- 新字段`duration_ms`只表示终态所在此次正式执行；`end_to_end_duration_ms`含排队与此前尝试；没有取得running的失败不填写执行耗时。
- PostHog属性目录刷新滞后，新字段尚未列入taxonomy，但真实事件JSON与更新后的图表查询已确认它们存在。
- 完整后端419通过/21原有跳过；前端295通过/13原有跳过；最终计时修改后的独立聚焦87通过，typecheck与diff检查通过。

## Auth 实现与本地验证

- 登录、取票、保活、采集共用`ChromiumSession`；删除Patchright依赖、旧Patchright登录和旧HTTP取票/探活代码。Chrome for Testing固定148.0.7778.96并校验SHA256，容器用Xvfb普通窗口；没有UA/平台伪装或浏览器指纹轮换。
- 操作前验证可见、可点击及禁用祖先；原生鼠标移动/按下/释放，在安全内区作小幅位置随机，保留有界操作抖动。页面、网络响应和验证码回执由状态与事件驱动，遇需人工验证明确失败，避免盲目重复发码。
- 登录态首导航直接拿票时正常完成；常规CAS续期保留WAF及本地存储但不复用认证Cookie；相同TGT不能冒充续期并重置7小时时钟。QuickLogin显式状态复用保留。
- 完整响应在loadingFinished后读取；断线立即结束等待；已自然恢复的412不污染成功结果；较早响应的迟到body不得覆盖后发结果。
- 跨origin存储使用与Playwright相同的成熟模式：同一profile的辅助页面，在导航前拦截为空HTML读写本地存储，不发出额外学校请求。该辅助过程独立限时10秒，所有出口清理Target/CDP。
- DO确认失效按会话身份与state快照提交；旧alive/expired不覆盖新会话。并发重登成功仍转active，失败不复活已失效登录；丢弃旧探针后保留有效会话的后续维护及更早alarm。
- Python浏览器操作新增安全`browser_operation_completed`事件，只有operation、http_outcome、http_status、duration_ms；不读取请求/响应内容。http_outcome只表示HTTP结果，不作为业务成功率。取消和遥测失败不改变业务语义。
- Linux amd64、1GiB、Xvfb普通窗口最终完整测试：351通过、13子测试通过；包含单核和较快CPU环境验证，另有本机Python3.12浏览器及生命周期验证。实际镜像无Patchright，native UA/平台一致、webdriver=false；退出后临时profile为0，镜像runtime SHA256与工作区一致。
- Auth完整DO测试312通过，Node/前端858通过；typecheck、DO typecheck、API产物、API契约lint、模块边界、前端lint/build通过。前端仅有原有大chunk构建警告。
- CI新增以生产同架构Chrome镜像运行全部Python/浏览器测试的门禁。
- 独立复审覆盖Schedule、DO并发/续期、CDP生命周期/存储/票据以及Python遥测。修复均有先红后绿的回归证据。

## Auth 生产验收

已签名提交`af32e26`并推送main；[首次CI 35702052192](https://github.com/cqu-moe/auth/actions/runs/35702052192)被真实浏览器profile清理断言阻止，尚未部署。已补独立进程组回收及限时严格目录删除，保留原失败断言；修复后的较快CPU Linux全套351通过、13子测试通过；原清理断言未放宽，等待修复后的CI。生产账号验收仍待部署稳定后进行。

发布前实时日志补充：旧版本在15:19–15:32期间出现7小时主动重登后连续瞬态失败和BROWSER_DEADLINE。这与代码及回归测试揭示的有效seed等待登录表单缺陷一致；日志本身未记录每次完整页面状态，故不把所有历史超时归为同一根因。
