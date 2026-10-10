# CQU 会话约定

实现入口：`src/durable-objects/cqu-session.ts`；主机策略：`src/services/service-url.ts`；浏览器协议：`src/services/cqu-node-protocol.ts`。

## 取票与凭证

- 所有取票入口收敛到 DO 的取票策略：校验 serviceUrl、scope/客户端授权、广域 quicklogin opt-in、限流和审计。新增入口不得绕过 DO 直接调用 SSO client。
- serviceUrl 只允许 HTTPS 的 CQU 子域。浏览器节点保留同策略的第二层校验；中止导航不代替主机白名单。
- HTTP Bearer、RPC client secret、网站会话各自遵循对应入口的鉴权契约，不能把一种凭证当作另一种的通行证。
- TGT cookie 为 `SOURCEID_TGC`；会话还涉及 `SESSION` 与瑞数 cookie。完整浏览器 `storageState` 才能用于水化，不拿旧三-cookie 状态代替。
- D1 的学校密码使用 AES-256-GCM；完整 storageState 存在 DO storage，应用层未另行加密。排查时不得将两者的保护边界混称，也不得输出会话内容。
- CQU SSO 请求需要浏览器 User-Agent；Workers AES-ECB 的 IV 使用空字符串。

## 时序与保活

- keepalive 会真实铸造 ST：记入审计及限流窗口，使用独立 keepalive client 桶，记账但不因用户配额拒绝保活。
- 回写刷新或登录结果前重新验证会话版本/撤销状态；外部 I/O 期间可能发生解绑，旧结果不能复活会话。
- DO 单值大小守卫保留超限前的可用状态；避免异常触发 alarm 重试而反复铸票。
- 取票、保活、登录与数据抓取使用各自的 deadline/budget；读当前实现和配置，不将历史固定超时套到全部操作。
- 休眠 WebSocket 的 ping/pong 由 `setWebSocketAutoResponse` 处理，保留无需唤醒 DO 的路径。

改动后分别验证纯函数策略与 Workers pool 的 DO 时序行为；真实学校登录、2FA、ST 未核销及长期保活需单独记录现场证据。
