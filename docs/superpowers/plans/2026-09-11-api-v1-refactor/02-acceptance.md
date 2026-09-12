# API v1 重构验收标准

本稿用于独立验收，与[执行计划](../2026-09-11-api-v1-refactor-plan.md)和[逐端点清单](01-migration-inventory.md)配套。设计已获用户确认；本稿中的“必须”“通过”是未来执行的判据，所有项当前均未执行。元数据探针通过不等于这里的业务验收通过。

## 2026-09-12 当前验收补充

本节只追加原 T00–T17 完成后的 QuickLogin 现实修正，不伪造原设计时间点。Q1–Q5 的详细执行状态见 [补充计划](../2026-09-12-api-v1-quicklogin-integration.md)、`execution-log.md` 与 `acceptance-results.md`。

- Q1–Q3 Auth 与 Q4 扩展已分别在 `codex/api-v1-refactor`、`codex/quicklogin-api-v1-client` 完成本地实现和审查修复；扩展全套14 files/46 tests通过，但未发布商店、未实际升级两台设备。
- Q5 必须证明 runtime/OpenAPI/Cloudflare/endpoints/coverage 集合相等、operationId唯一、无外部ref/通配业务路径，并分别核对 Cookie、Bearer、fixed-origin、admin permission。当前本地集合是138=132 canonical+1 websocket+0 legacy+5 discovery。
- QuickLogin JSON schema 样本必须覆盖 nullable 时间字段、严格对象、协议版本、preference mode union、quota kept/disabled metadata 与 migration preview；不得把 grant、DO account/stored browser/pending state 公布为组件。
- Cloudflare 3.0.3 只把 JSON body 和参数计入 schema validation；OAuth form、WS messages、所有 responses（含 QuickLogin native DTO/error）逐操作登记为例外，不借此声称全覆盖。
- 本子环境若因 `tsx` IPC 或 workerd loopback `EPERM` 不能执行，必须由根任务原样复跑 `npm run generate:api`（两次）、`npm run check:api`、`npm run check:boundaries` 和带 `WRANGLER_LOG_PATH` 的 `npm run test:do`。环境失败不记为功能失败，也不能据此宣布部署准备完成。
- 只有根任务完成 Workers 全套、任务级/整分支审查并实际部署后，才可记录 production health/静态/v1/legacy/discovery/未登录拒绝探针。真实流量与最终 QuickLogin bridge 移除留待今晚。

## 1. 完成判定

本轮完成必须同时满足：正式v1接口/前端迁移完成、旧地址兼容测试通过、必需行为矩阵通过、清理证据齐全、自动门禁通过。只更换前缀、只有单元测试通过、只有OpenAPI文件、或只有前端能打开，均不算完成。

结果分为：通过、失败、未执行、环境阻塞。未执行与环境阻塞不计通过。每项结果必须关联当前commit、测试文件/用例名、运行命令及退出码；截图不能代替API状态、数据库读回或token签名验证。旧地址退役、生产部署与Cloudflare规则启用另列，不在这次执行授权内。

### 必须留下的交付物

| 产物 | 验收要求 |
| --- | --- |
| 执行工作区/分支/基线SHA/HEAD | 能定位本次改动；不是过期主目录或其他功能分支 |
| execution-log.md | T00–T17逐项状态、red/green证据、变更/commit、未完成原因 |
| acceptance-results.md | 本稿每个ID一项结果，关联实际证据；默认未执行，不预填通过 |
| cleanup-ledger.md | 每项删除/合并的引用依据、原/新位置和验证；保留例外有理由 |
| docs/api/openapi.json | OAS3.1.1完整规范合同，含全部当前正式端点/协议响应 |
| docs/api/cloudflare.openapi.json | OAS3.0.3，可本地校验的CF投影，无外部ref/无相对server URL |
| docs/api/endpoints.json | host+method+path集合，标明canonical/legacy/discovery/websocket |
| docs/api/coverage.json | 哪些JSON body/路径参数受schema描述、哪些form/WS/response不受CF验证 |
| shared/api-types.generated.ts | 从完整合同生成，不手工编辑、不导入后端运行时 |
| 当前接入文档和CI | 与代码、脚本及兼容状态一致；未声称已发布防护 |

结果记录示例（不是预先通过证据）：

```text
ID: CQU-03
状态: 未执行
目标: credentials不存在而address=pending时HTTP bindStatus=pending
证据要求: 真实数据库seed、GET响应断言、相同用户RPC断言
执行后补充: 实际命令、测试名、退出码、commit、产物相对路径
```

只允许保存假测试数据的结构、掩码和计数。即使是本地生成的token/OTP/secret，也避免写到日志和截图；测试私钥固定为非生产fixture时必须明确仅供测试。禁止读取生产cookie或账号来凑验收证据。

## 2. 测试环境与证据层次

| 层次 | 如何运行 | 能证明 / 不能证明 |
| --- | --- | --- |
| Node合同/纯函数 | Vitest默认pool；真实Hono request，替换外部依赖 | HTTP形状、路由、输入、错误、前端事件；不能证明workerd WS101/DO时序 |
| Workers集成 | cloudflare:test，真实D1/KV/DO/BetterAuth，本地mock Resend/CQU容器 | 事务、签名/会话、邀请码并发、WS升级、DO行为；不证明生产WAF放行 |
| 前端交互 | jsdom真实组件点击/输入/提交，或本地浏览器 | 页面行为、请求映射、视觉/焦点/取消；若mock后端，必须注明 |
| 本地业务组合 | 真实HTTP/auth/session/DB逻辑，邮件与CQU出站替换为假服务 | 已授权的本地用户流程；不宣称真实学校登录或线上邮件投递 |
| 文档/结构校验 | runtime集合比较、Redocly、生成漂移、AST依赖检查 | 契约结构和覆盖；不证明CF已经接受上传或执行阻断 |

从 T00 建立 fixture，所有mock出站未匹配时失败，禁止意外落到生产域名。不得以每次handler返回固定200的mock替代待测的权限/数据库/路由逻辑。事务回滚至少有真实D1读回；安全协议至少有真实签名/验签与session流程。

## 3. 基线与范围

| ID | 输入 / 场景 | 必须观察到的结果 | 证据 / 任务 |
| --- | --- | --- | --- |
| BASE-01 | 新工作区启动 | 记录远端main SHA；包括OTP/onboarding；主目录/其他worktree未被改写 | git状态、日志 / T00 |
| BASE-02 | 新工作区安装与基线检查 | 记录实际版本、测试数和既有失败；无框架顺手升级；不把旧报告当新证据 | lock diff+命令 / T00 |
| BASE-03 | 本地auth元数据探针 | issuer旧身份、Cookie属性、81操作、6禁用项、SERVER_ONLY都被记录；不保存秘密 | getEndpoints/config断言 / T00 |
| BASE-04 | 外部出站与cleanup | Resend/CQU仅进假服务；未声明出站导致失败；测试结束关闭DB/WS/timer | fixture自测 / T00 |

## 4. HTTP和路由分界

| ID | 输入 / 场景 | 必须观察到的结果 | 证据 / 任务 |
| --- | --- | --- | --- |
| HTTP-01 | `/api`、`/api/`、`/api/v1/nope`、`/api/v99/health`、未知旧API | JSON404；ASSETS调用0；不得返回index.html | app.request+ASSETS spy / T04 |
| HTTP-02 | `/login`、`/settings`、`/oauth/authorize`及静态资源 | 仍走页面/静态资源；页面自身404策略不被API兜底吞掉 | ASSETS spy+浏览器 / T04 |
| HTTP-03 | POST health、GET/HEAD service-tickets、已知路径错误method | 405、正确Allow；无读取敏感body/无DB或DO写；票据GET不铸票 | 真实路由 / T04/T07 |
| HTTP-04 | GET对应HEAD、WS对应HEAD、CORS预检 | 普通HEAD无body；WS HEAD不升级；合法OPTIONS不执行业务 | header/status/spy / T04 |
| HTTP-05 | JSON字符串语法错误、null、数组、未知字段 | 自定义API正确400；业务无副作用；不变成500/成功默认值 | 每组写schema参数化 / T02 |
| HTTP-06 | JSON写body配text/plain/无Content-Type；可选空body | 非空不支持媒体415；C04/C15/C34空body按{}；其他空body400 | 路由测试 / T02 |
| HTTP-07 | 成功单资源、列表、204、101、BA token | D<T>一次包装；分页不丢；204空；101/BA不包装 | schema+HTTP / T02/T12 |
| HTTP-08 | 业务错误、APIError、意外异常 | problem媒体类型、status一致、稳定code；未知异常500 INTERNAL_ERROR，敏感原文不回显 | 错误注入 / T02 |
| HTTP-09 | page=abc/0/-1/1.5/1e3，limit=101/20abc，带百分号的name | 分页400；name只解码一次、中文可往返；不得NaN查询或双解码 | schema/DB断言 / T08/T10 |
| HTTP-10 | HTTP重写、重复Set-Cookie、Origin、原query/body、cf | 兼容转发不丢/合并Cookie，不丢身份/来源，不二次编码signed query | header/body字节对比 / T04/T05 |

## 5. 身份、OAuth、OTP与2FA

| ID | 输入 / 场景 | 必须观察到的结果 | 证据 / 任务 |
| --- | --- | --- | --- |
| AUTH-01 | 需要session/Bearer的匿名请求 | 401；不执行业务，不从body/query提取userId | route+写入spy / T03 |
| AUTH-02 | 坏Bearer同时带有效Cookie访问S/B绑定接口 | 401；不得降级session | 真验签/身份测试 / T03 |
| AUTH-03 | Bearer缺sub或azp/client_id、字段错误类型 | 拒绝；不绕过client白名单、不生成空主体DO | JWT负例 / T03 |
| AUTH-04 | 正常Bearer取票 | 单请求仅一次verifyAccessToken；scope消费已验claims；一次DO调用 | 请求计数+正例 / T03/T07 |
| AUTH-05 | session-only开关：Bearer单独、session+不同人的Bearer | 前者401；后者只用session主体；无越权flag写入 | 双用户fixture / T03/T07 |
| AUTH-06 | 连续/并发用户A与B请求 | auth/session/principal缓存不跨请求；结果不串号 | 并发测试 / T03 |
| AUTH-07 | 新旧discovery读取 | issuer均为原`https://auth.cqu.moe/api/auth`，endpoint地址指v1，JWKS key集合不变 | 本地元数据快照 / T05 |
| AUTH-08 | old issuer-path发现与RFC前缀发现 | D01–D05共享有效JSON；禁用legacy普通映射时永久discovery仍可用 | app请求 / T05 |
| AUTH-09 | 重构前签发session，重构后GET get-session及RPC | 原cookie名/Domain/Path/签名/TTL适用，用户与caps正确，无被迫重新登录 | 真实D1/KV auth / T05 |
| AUTH-10 | old access/refresh token与new token | 同一受信issuer/audience策略可验证；refresh可用；scope/caps不扩大 | 真OAuth签发/验签 / T05 |
| AUTH-11 | 错issuer/audience、过期、损坏签名；其他资源专用token | 一律拒绝，不能添加通配issuer/audience或只decode JWT | 真签名负例 / T05 |
| AUTH-12 | OAuth authorize→consent→token（PKCE），Basic/Post client auth，form body | 新旧入口都保持原302/state/PKCE/错误协议；token不套D<T> | local OAuth全流程 / T05 |
| AUTH-13 | 新旧signup抢同一码；策略开/关、有/无码、邀请码preset | 原子claim与原错误code；code剥离再给BA；preset优先级及默认行为不变 | 原DO邀请测试扩展 / T05/T09 |
| AUTH-14 | OTP发送/验证/重发/错误3次/过期/复用 | 6位、300秒、3次、hashed、rotate与一次性使用；新旧端点同一语义 | 实际auth+假邮件 / T05 |
| AUTH-15 | 在新旧OTP地址之间交替请求 | 共用现有限频窗口/次数，不能双倍配额；429原生响应 | 时间可控集成 / T05 |
| AUTH-16 | TOTP、邮件2FA、backup code、trusted device | 原6位/30秒TOTP、临时Cookie600秒、可信设备2592000秒、恢复码加密/一次消费保持 | 原2FA测试+新地址 / T05 |
| AUTH-17 | 迁移前reset-password链接、POST callback、登出/会话吊销 | 旧链接可完成安全回调；签名参数/body保持；禁用verify-email旧链接仍404 | 真实回调流程 / T05 |
| AUTH-18 | 新旧6个禁用path、SERVER_ONLY、/error、get-session | 禁用仍拒绝；SERVER_ONLY不暴露；error302至安全页面；仅GET session且有user/session/caps无caps.cqu | 方法集合+HTTP / T05 |

## 6. CQU资源与DO

| ID | 输入 / 场景 | 必须观察到的结果 | 证据 / 任务 |
| --- | --- | --- | --- |
| CQU-01 | 两请求为同用户创建绑定地址 | 首次201/随后200；只有一个地址；不修改已有kind/白名单 | 并发DB读回 / T06 |
| CQU-02 | kind=forward、旧forward记录读取/继续流程 | 创建403原code；旧数据/forwardAddress/邮件校验仍有效；不可达新建分支删除 | HTTP+邮件单测 / T06 |
| CQU-03 | credentials active/原地址pending/无地址等8种矩阵 | credentials优先；无两表才unbound；真实未确认不当active | 参数化实际DB / T06 |
| CQU-04 | A访问binding；body/query伪造B的userId | 只访问A，或未知字段400；不访问B的DO/地址/验证码 | 双用户隔离 / T06 |
| CQU-05 | 新凭据首登失败、更新旧凭据失败、并发插入 | 只删本次新插入ID；旧凭据按原语义保留；地址保留，失败不标active | DB读回+DO桩 / T06 |
| CQU-06 | DO init成功但激活写失败、DO错误/非JSON | BIND_ACTIVATE_FAILED503或原CQU_LOGIN_FAILED；不假成功；两表激活batch | 故障注入 / T06 |
| CQU-07 | WS无Upgrade、无Origin、恶意Origin | 426或FORBIDDEN_ORIGIN403；不创建或泄露WS | app路由 / T06 |
| CQU-08 | 同源新旧events真实连接 | 101+可用webSocket；消息/ping-pong保持；不重建丢WS对象 | workerd真实握手 / T06 |
| CQU-09 | WS用户A/B、迟到消息、主动关闭 | 互不串数据；关闭后无重新连接；客户端不显示B的码 | workerd+transport / T06/T15 |
| CQU-10 | 删除binding：成功、D1失败、DO destroy失败 | 成功两表清理204；D1失败503；DO按原best-effort语义，不返回秘密 | DB/DO测试 / T06 |
| CQU-11 | v1 POST合法service或serviceUrl | 201 D<{ticket}>、no-store；serverUrl规范化；唯一DO出票闸 | route+DO / T07 |
| CQU-12 | 双目标、无目标、未知service、恶意URL/反斜杠/账号/非HTTPS | 规范400/code；没有DO调用；legacy双目标仍URL优先 | 输入矩阵 / T07 |
| CQU-13 | cookie-only取票，token缺scope，client缺scope | cookie401、scope不足403；不能因已有登录就铸票 | 真JWT+DB / T07 |
| CQU-14 | any、symbolic与*组合 | any不授予symbolic，反之亦然；*语义与现有纯函数一致 | scope矩阵 / T07 |
| CQU-15 | 广域取票两个flag的四种组合 | 只有access与consent均真可通过；撤销任意一个立即生效 | 真实DO授权 / T07 |
| CQU-16 | 同client/user超限、DO失败含敏感message | 原429/稳定业务code；通用安全detail；不漏token/ticket/密码 | DO窗口/脱敏 / T07 |
| CQU-17 | GET开关未开放、PUT true/false、Bearer单独 | eligible=false；未开放403；只写本人consent；Bearer不能替代session | HTTP+DB / T07 |
| CQU-18 | rpc/HTTP出票、retired node route、keepalive | 均保留DO检查/限频/审计；NODE_RETIRED仍410，绝不恢复fallback | 既有DO回归 / T07/T17 |

## 7. 管理资源

| ID | 输入 / 场景 | 必须观察到的结果 | 证据 / 任务 |
| --- | --- | --- | --- |
| ADMIN-01 | 匿名/user/admin/superAdmin请求管理接口 | 401/403/按ACL许可；Bearer不变成管理员session | 参数化权限 / T08 |
| ADMIN-02 | 用户列表页、末页、详情不存在 | data/pagination稳定，page/limit可预测；不存在404，不返回500 | HTTP+DB / T08 |
| ADMIN-03 | {banned}、{role}、两者同时、空对象、action字段 | v1只允许前两种单独变更；其余400；没有部分写入 | schema/handler / T08 |
| ADMIN-04 | 普通admin ban/unban、set-role；superAdmin set-role | 普通admin可ban但不能升权；superAdmin照配置工作 | 真插件权限 / T08 |
| ADMIN-05 | CQU revoked/active、DO500 | 保留凭据；DO失败原失败code；不假成功、不等同解绑 | D1/DO故障 / T08 |
| ADMIN-06 | 公开registration-settings | 只返回布尔策略，不含预设、邀请码或用户信息 | 严格key断言 / T09 |
| ADMIN-07 | 邀请列表、创建、重复撤销 | 最新100条/原状态，8位code/7天，201/204；无额外授权副作用 | 假时钟+DB / T09 |
| ADMIN-08 | 创建邀请空body、坏JSON、未知preset | 空body可创建；坏JSON/未知preset拒绝且无新行 | row count读回 / T09 |
| ADMIN-09 | 普通admin改注册策略、superAdmin合法/非法值 | 前者403；合法写入/读回；字符串true不是boolean | ACL+HTTP / T09 |
| ADMIN-10 | invitationRequired切换与带码/无码注册 | 运行时策略与schema说明一致，无码开放不被边缘静态required误挡 | signup集成+OAS / T09 |
| ADMIN-11 | 权益GET、普通admin写、匿名写 | GET可按A读取；写需EA/ER；拒绝不修改任何行 | 每写方法矩阵 / T10 |
| ADMIN-12 | PUT权益包含items数组或[] | 原子整体替换；[]清空；响应无额外success | D1读回 / T10 |
| ADMIN-13 | PATCH preset，用户已有无关权益 | 仅预设覆盖键更新；无关行/跨子系统同名键保留 | 对比完整行集合 / T10 |
| ADMIN-14 | PUT/PATCH插入失败 | 整个相关batch回滚，旧值不被清空；返回失败 | 真实D1触发失败 / T10 |
| ADMIN-15 | 重复键、未知能力、非法flag/quota、空preset | 合适400/409业务code，DB无部分写；沿用原数值语义 | validator+DB / T10 |
| ADMIN-16 | 中文/含%预设名GET/PUT/DELETE | 只编码/解码一次；操作同一名字；非法名字拒绝 | round trip / T10 |
| ADMIN-17 | 删除正在使用的默认预设 | 预设删除；default指针清为null；重复删除204 | DB读回 / T10 |
| ADMIN-18 | v1默认配置缺preset、null、未知名 | 缺字段400，null清空，未知名400；legacy省略保持旧null语义 | 新旧HTTP / T10 |
| ADMIN-19 | OAuth客户端列表 | 只有正式snake_case字段；无id/clientId/name重复，无secret/hash | 结构/敏感字段断言 / T11 |
| ADMIN-20 | create带原支持字段、非法URI/type/grants/scopes | 合法201并保留字段；非法按原语义拒绝；不能只支持UI可见字段 | 插件schema+route / T11 |
| ADMIN-21 | patch基于已有配置、无可写字段、直接写secret | 验证合并结果；空/未知字段拒绝；不能任意覆盖secret/userId | adapter读回 / T11 |
| ADMIN-22 | public→confidential、反向切换 | 前者生成一次secret且token可用；后者清secret并public=true | 真OAuth请求+DB / T11 |
| ADMIN-23 | secret轮换、public轮换、无client | 新201/旧200；新secret可用旧不可用；public400、缺client404 | 真token验证 / T11 |
| ADMIN-24 | admin调用OAuth写与scope PUT | 按已声明ACL403；新旧scope入口都要求CS；拒绝无写入 | 角色矩阵 / T11 |
| ADMIN-25 | scopes重复、空数组、非法字符串、保留合法宽集合 | 重复/非法400；[]清空；不把四个UI值当完整集合 | schema+DB / T11 |
| ADMIN-26 | scope delete后insert失败 | 同batch回滚；读回原scope，不出现授权被静默清空 | 真实D1回滚 / T11 |
| ADMIN-27 | 删除已被使用的OAuth client与重复删除 | 正确顺序清access/refresh/consent/client/scope；204；无孤儿 | 多表读回 / T11 |
| ADMIN-28 | 列表/错误/日志/缓存读取secret | 仅创建/必要切换/轮换本次响应可有secret；no-store；无hash/secret旁路 | 响应/日志捕获 / T11 |

## 8. 旧地址兼容

| ID | 输入 / 场景 | 必须观察到的结果 | 证据 / 任务 |
| --- | --- | --- | --- |
| LEG-01 | C01–C35及B清单逐一旧地址调用 | 每个已登记方法有映射；没有重复业务handler；新旧共享权限逻辑 | map集合+配对测试 / T04–T11 |
| LEG-02 | 原有data/裸JSON/分页/204/APIError | 按迁移清单第5节精确返回，既不data.data也不丢旧success | JSON黄金fixture / T04–T11 |
| LEG-03 | WS101、重复Set-Cookie、OAuth302 | 对象与所有header不损坏，Location保持协议；除受控error外不随意改redirect | workerd/header测试 / T04/T05 |
| LEG-04 | 旧GET ticket双目标；新GET ticket | 旧请求URL优先且200裸ticket；新GET405无铸票 | 请求配对 / T07 |
| LEG-05 | OAuth token/introspect/revoke form，POST callback | 不丢body、认证header、query/签名；不通过301/302替换POST | 真协议请求 / T05 |
| LEG-06 | 在新旧地址交替登录/OTP请求 | 单一session/rate-limit namespace；额度不可翻倍 | 真实KV与假时钟 / T05 |
| LEG-07 | 旧密码重置/注销/受控error回调 | 仍可完成原流程；error跳安全本地页，不开放重定向 | callback流程 / T05 |
| LEG-08 | 未知旧API、错误method、六禁用项、devices等未上线路径 | JSON404/405或原受控禁用错误；ASSETS不接管；不恢复独立分支能力 | 清单外负例 / T04/T05 |
| LEG-09 | user action ban/unban/role及旧优先级 | 精确转换为新属性；旧成功返回action/role保持 | legacy user配对 / T08 |
| LEG-10 | 旧preset POST、默认preset省略、删除旧200 | merge不变replace；省略保持null；删除适配回200 success | entitlement配对 / T10 |
| LEG-11 | 旧OAuth列表、创建、patch、rotate/delete | 补原别名，201↔旧200、204↔旧200、secret分支形状正确 | OAuth配对 / T11 |
| LEG-12 | 源码与CF清单 | legacy仅有限映射；CF端点清单包含仍开放旧地址，D03/D04不归退役开关 | 集合比较+检查 / T11/T12 |

## 9. OpenAPI与Cloudflare准备度

| ID | 输入 / 场景 | 必须观察到的结果 | 证据 / 任务 |
| --- | --- | --- | --- |
| OAS-01 | runtime vs完整文档 vs endpoint清单 | canonical方法/path全覆盖，无无端点schema；参数模板一致 | 集合相等 / T12 |
| OAS-02 | BA原始schema多出的POST/get-session | 产物中删除误报；只保留实际GET；不能把误报补挂成新端点 | 负向集合fixture / T12 |
| OAS-03 | SERVER_ONLY、disabled、HTML/error、默认reference | helper/禁用不公开；error302有Location；无HTML reference路由 | schema+HTTP / T12 |
| OAS-04 | signup.code、customSession.caps、公共/权限端点 | 应用层变化补齐；code动态必填不硬编码；真实security，不照抄bearerAuth | fixture+schema断言 / T12 |
| OAS-05 | OAS3.1 nullable/type与3.0转换 | 实际语义保留；合法/非法JSON样本转换前后判定一致 | 独立样本验证 / T12 |
| OAS-06 | const、exclusive边界、类型union、复杂不支持关键字 | 支持项正确转换；无法保真项非零并给JSON pointer，不静默删除 | 转换测试 / T12 |
| OAS-07 | ref冲突/悬空ref/外部ref | 完整文档namespace无碰撞；CF无外部ref；悬空ref失败 | Redocly+转换测试 / T12 |
| OAS-08 | server/path/method/operationId | 绝对server URL、唯一id、正确参数模板；无通配业务端点 | lint+集合 / T12 |
| OAS-09 | session-only、Bearer-only、公开与管理员 | security描述与实际鉴权一致；scheme的cookie名真实；fine ACL有扩展说明 | auth-policy对照 / T12 |
| OAS-10 | OAuth form、WS消息、HTTP响应校验范围 | 完整文档保留协议；coverage明确CF不校验这些body/消息/response；不声称全覆盖 | coverage逐项检查 / T12 |
| OAS-11 | 旧GET query/旧PATCH action等compat schema | CF投影使用旧请求形状；不能复用新POST JSON来误拦旧请求 | 新旧输入样本 / T12 |
| OAS-12 | 连续生成两次、污染生成文件、缺端点 | 正常无diff；污染/删端点check:api非零；check不覆盖污染掩盖错误 | 临时目录实验 / T12 |
| OAS-13 | M01获取完整文档 | JSON文档对象，非data包装；不查询生产DB/秘密；无内部私钥值 | endpoint+出站检查 / T12 |
| OAS-14 | 类型生成与标准结构校验 | frontend编译通过；类型来自文档；Redocly结构错误0；CF产物3.0.3 | generate/check/lint / T12 |

## 10. 前端与用户流程

| ID | 输入 / 场景 | 必须观察到的结果 | 证据 / 任务 |
| --- | --- | --- | --- |
| WEB-01 | GET/写请求/204/分页 | 统一v1基址、credentials正确；204不json()；列表pagination保留 | api client测试 / T13 |
| WEB-02 | Problem错误、上游HTML、AbortError | 安全ApiError；不渲染HTML；取消原样传递；不默认未绑定 | mock transport / T13 |
| WEB-03 | 非幂等写失败、401、超时 | 无自动重复POST/secret轮换，不静默吞错；页面能显示真实失败 | 请求计数/UI / T13 |
| WEB-04 | 绝对URL/`//host`作为API路径，页面调用旧路径 | 客户端拒绝危险基址；业务页面无直接旧路径/fetch拼接 | client+静态检查 / T13 |
| WEB-05 | 官方authClient发起登录/OTP/2FA/OAuth | 请求均到v1/auth；插件响应原生；redirect query不丢 | 请求捕获 / T13 |
| WEB-06 | 注册设置获取与邮箱验证成功 | 新data正确读取；验证码成功先refresh session再导航；失败留页 | 组件真实交互 / T13 |
| WEB-07 | Schedule→login/register→OTP→2FA→binding→return | 嵌套redirect/编码保留；外域恶意目标拒绝；已有正常flow测试继续有效 | 现有continuation+本地组合 / T13 |
| WEB-08 | `/auth/error?error=...`含恶意字符串/外部目标 | 显示固定安全说明，不插HTML/执行脚本；链接只到允许本地页 | DOM/浏览器 / T13 |
| WEB-09 | 管理台用户ban/role、分页与API失败 | 新banned协议；错误不假成功；页面/tab/权限可见性保持 | 点击/请求/组件 / T14 |
| WEB-10 | 邀请生成/撤销、注册策略/预设编辑 | 请求方法/路径/body正确；错误保留输入，取消不写；204处理正确 | 组件交互 / T14 |
| WEB-11 | 预设merge和整组replace | 点击分别调用PATCH/PUT；不混语义；无关权益保持 | UI→真实API组合 / T14 |
| WEB-12 | OAuth创建/编辑/轮换/删除及所有原字段 | client_id正式字段、snake_case、数组省略规则；secret只显示当次；删除204 | 表单完整用例 / T14 |
| WEB-13 | desktop/mobile与主要modal的前后对比 | 原布局/文案/按钮层级/键盘交互保持，无溢出/丢字段；有前后同数据截图 | 本地浏览器，注明mock范围 / T14 |
| WEB-14 | Settings WS展开/折叠/网络断开 | 展开连接、折叠关闭；30秒ping、3秒重试至5次；成功清计数 | fake timer+真实WS / T15 |
| WEB-15 | Wizard WS收code/断开/卸载 | 收code后不再重连；原3秒策略保持；卸载无timer或晚到更新 | transport+组件 / T15 |
| WEB-16 | StrictMode重挂、迟到onopen/onclose、多次close | 最多一条当前连接；close幂等；无定时器/订阅泄漏 | 生命周期计数 / T15 |
| WEB-17 | pong/非JSON/畸形事件/重复码；旧forward恢复 | 不崩溃、不记码日志；过滤/去重/倒计时保持；旧forward可继续 | parser+既有页面测试 / T15 |
| WEB-18 | CopyButton成功/失败/卸载和本地Vite WS | 原显示/aria保持，卸载清timer；代理ws配置下同源握手可用 | 控件测试+本地开发检查 / T15 |

## 11. 精简、边界与内部入口

| ID | 输入 / 场景 | 必须观察到的结果 | 证据 / 任务 |
| --- | --- | --- | --- |
| CLEAN-01 | frontend全部TS/TSX依赖图 | 解析后无后端src import/re-export/dynamic import，包括alias | AST检查 / T01/T16 |
| CLEAN-02 | shared依赖与API类型 | 无Worker/DB/Hono/React运行时；生成类型只被消费；移动测试仍被跑到 | AST+test清单 / T01/T12 |
| CLEAN-03 | Admin源码和请求位置 | 页面仅组合功能；请求集中api client；无原2289行混合职责副本 | diff/引用扫描 / T14 |
| CLEAN-04 | 认证/WS/错误/CopyButton重复 | 各有一个实际公共实现；页面策略保留；旧helper无调用后删除 | cleanup-ledger+测试 / T03/T15 |
| CLEAN-05 | forward return后代码、旧route文件 | 确认可达性后删除；无被移走又留副本的业务handler | 源码/引用/diff / T16 |
| CLEAN-06 | package/脚本/依赖与注释 | build不隐式安装；db:generate删除；无无关升级；过期说明修正 | package/lock diff / T16 |
| CLEAN-07 | DO兼容导出、SQL/DO迁移、NODE_RETIRED、冻结参考 | 全保留，旧迁移内容不改、未恢复退役后端；保留理由登记 | 与基线diff+DO测试 / T16 |
| CLEAN-08 | 删除账本与源码规模 | 每项有引用/替代证据；记录去重成果，不为净行数删schema/测试/安全逻辑 | ledger核对 / T16 |
| RPC-01 | verifySession/getCaps等现有Service Binding调用 | 方法名/输入/返回/caps/绑定真值保持；不变成HTTP envelope | RPC回归 / T01/T03/T17 |
| RPC-02 | getCquTicket/cquHarvest权限与DO调用 | 原clientSecret/scope/DO校验、内部dataHarvest/deadline等保持；不绕过DO | RPC+DO回归 / T17 |
| RPC-03 | Worker index email/queue/命名导出 | 邮件/通知queue处理保持；所有既有Worker/DO类仍可加载 | workerd+现有测试 / T17 |

## 12. 统一命令与最终门禁

在新工作区执行，按下表逐个记录退出码。需要本地监听权限时按沙箱工具申请；Wrangler日志定向到临时目录，不读取或上传生产状态。

| 工作目录 | 命令 | 成功要求 |
| --- | --- | --- |
| 工作区根 | `npm ci` | 依照root锁文件安装，零安装错误 |
| 工作区根 | `npm --prefix frontend ci` | 前端锁文件安装成功 |
| 工作区根 | `npm run typecheck` | 后端含新增shared/API类型检查通过 |
| 工作区根 | `npm run typecheck:do` | Workers测试与fixture类型检查通过 |
| 工作区根 | `npm test` | 全部常规测试通过，shared测试未遗漏，无无故skip |
| 工作区根 | `WRANGLER_LOG_PATH=/private/tmp/auth-api-v1-wrangler.log npm run test:do` | 真实Workers/DO测试通过，不触远程bindings |
| `frontend` | `npx tsc -b` | 真正构建TS project references，非空跑根配置 |
| 工作区根 | `npm --prefix frontend run lint` | ESLint无error；新增warning逐项处理/说明 |
| 工作区根 | `npm --prefix frontend run build` | 前端生产构建成功 |
| 工作区根 | `npm run generate:api` | 确定性产出全部API文件 |
| 工作区根 | `npm run check:api` | runtime/文档/legacy/CF覆盖与漂移全部通过 |
| 工作区根 | `npm run lint:api` | 两份OpenAPI结构校验通过 |
| 工作区根 | `npm run check:boundaries` | 解析实际导入后无跨端违规 |
| 工作区根 | `git diff --check` | 无补丁空白/冲突标记错误 |

容器源码/Dockerfile若没有修改，不强迫新增Python测试；如修改，必须运行对应现有Python用例并记录原因。截图工具和浏览器方式按执行环境技能选择，必须注明页面所连的是真实本地后端还是fixture。

| ID | 输入 / 场景 | 必须观察到的结果 | 证据 / 任务 |
| --- | --- | --- | --- |
| GATE-01 | 本表全部命令、CI配置及docs/api-only变化 | 全部必需门禁通过；CI会验证生成产物；没有因paths-ignore漏过schema | 命令记录+workflow审阅 / T16/T17 |
| GATE-02 | 任务与验收对照 | T00–T17有状态；本稿每个ID有结果/证据；必需未过时不写完成 | 对照表 / T17 |
| GATE-03 | 最终diff/工作区/commit | 仅本次范围；未改其他worktree/外部仓库；分任务提交或如实未提交原因 | git diff/status/log / T17 |
| GATE-04 | 文档和实际产物 | 路径、schema版本、例外、旧地址状态一致；无虚构覆盖/上线说法 | 文档交叉核验 / T17 |
| GATE-05 | 外部动作与最终报告 | 未push/部署/上传/改WAF/读生产秘密；报告区分本地通过和线上未验收 | 执行日志/报告 / T17 |

## 13. 本轮之外的退役与上线条件

这部分不勾选成“本轮已完成”。执行模型只列交接条件，不实施：

1. 旧地址退役前，逐一核对QuickLogin和其他OAuth客户端；完成发布/缓存/未过期回调检查，审查按route聚合的访问证据；取得退役日期与发布授权。
2. Cloudflare启用前，核对实际zone/Endpoint Management中的host+method+path；导入schema并确认接受，先按用户批准策略观察，处理真实误报后再启用阻断。
3. 永久issuer discovery地址保留，不以legacy零流量为理由删除；发行者身份迁移需要另一个明确方案。
4. 部署后分别验证health、静态资源、实际OTP/2FA/OAuth/绑定用户路径与CF防护。CF403 HTML只能证明边缘拦截，不是应用API401/403，更不能充当登录验收通过。
