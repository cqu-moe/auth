# Auth 安全升级实施记录

总规格：[#41](https://github.com/cqu-moe/auth/issues/41)。集成分支：`codex/auth-security-integration`，基线 `4ea1cf0`。草稿 PR：[#52](https://github.com/cqu-moe/auth/pull/52)。

本记录区分代码、测试和部署。当前未部署生产，任务仅在对应验收完成后记为完成。

## 接入方基线核实

- Schedule：仓库 `cqu-moe/schedule-cloudflare`，当前源码 `e2114ae2abcd461ebab20fb72694d3f2ed8a46b2`。只读查询确认生产 Worker `schedule-beta-cqu-moe` 的流量版本 `27045a03-6584-428e-aaec-88498b0b908c`，其中 `GIT_COMMIT=e2114ae`。后台仍通过 `AuthService` RPC。
- UC：用户确认代码目录 `/Users/uu/Developer/cqu-moe/uc`。主分支只有文档，在用实现位于 `codex/uc-spec-plan`，源码 `faa7fa373b3c0bd1caedf6efc5b0a77723515e6c`。该分支运行手册记录的修复版本 `cdd2a5d0-7c37-4cd6-befa-c530595ba9fb` 与只读查询到的生产 100% 流量版本相同；使用 EmDash、`AUTH` 服务绑定、`MEDIA`、`SESSION`。`uc-old` 不作为迁移对象。UC 当前没有 Git remote，交付应保留本地独立分支，不擅自推入旧仓库。
- Auth 移除 KV 不意味着移除业务系统自身的缓存或会话存储。消费者迁移分别在自己的仓库隔离实现；Auth 变更统一合入本集成分支。

以上只证明部署对象及代码来源，不证明新的 OAuth 登录、退出或浏览器隔离已通过。

## 当前已合入

### #36：存量 JWT 的当前状态校验

Bearer 验签后读取用户与客户端当前状态，拒绝被封禁、禁用、删除及查询失败。沿用过期封禁语义和请求级缓存，不假定 JWT 必有 access-token 数据行。

回归先复现封禁后旧令牌仍可出票（201），修复后返回 401。实现分支报告后端 701 项、Workers 针对性 4 项、后端及 Workers 类型检查通过。学校出票外部效果使用替身，令牌签名、JWKS、HTTP 与 D1 为真实测试路径。尚未代表整份规格的集成测试结果。
