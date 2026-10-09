# Auth 安全升级实施记录

总规格 [#41](https://github.com/cqu-moe/auth/issues/41)，Auth 集成分支 `codex/auth-security-integration`，PR [#52](https://github.com/cqu-moe/auth/pull/52)。本记录更新至最终切换实现；没有生产部署或远端迁移写入。最终发布与待人工验收见 [切换手册](../auth-cutover.md)。

## 已交付实现

- #36 / #37：存量 JWT 验签后校验当前用户、客户端和会话；学校解绑以权威删除状态拒绝新访问，D1/DO 清理失败可重试且不误报成功。
- #42：Better Auth 1.7.7 与原生 OAuth/D1 存储，移除 Auth 的 KV 依赖，不移除业务系统自己的缓存或会话存储。
- #43 / #44：当前用户、当前会话、用途绑定的五分钟近期认证；管理员强认证准入；取消邮箱第二因子；可选多个 Passkey，服务端 UV 校验后可独立登录与改密、MFA 管理，无需额外密码/TOTP。
- #45 / #46：设备与中央会话撤销、单站退出分离；正常改密保留当前已验证会话；人工恢复原子作废全部旧认证、一次返回随机密码，保留学校绑定/权益/RPC 同步；阻止已开始的旧认证在恢复后回写。
- #47 / #48：可选 DPoP 与共享重放保护，普通 Bearer 兼容；私有 Worker RPC 的服务身份、方法范围、当前用户/业务权益/绑定状态检查。API/MCP 平台仍未实施，仅保留现有身份与权限概念。
- #49：Schedule 独立会话源码 `9d6cd7f`，独立 PR [#123](https://github.com/cqu-moe/schedule-cloudflare/pull/123)，不是已部署版本。
- #50：UC 以用户确认的现用源码 `faa7fa3` 为基线，交付 `23b1c1f`；保留原生 EmDash 身份/成员/文件权限和 SESSION KV。仓库没有 remote，未推到旧仓库。
- #51：中央 `__Host-auth-v2.*`、旧 Cookie 有界清理、收紧可信写入来源；第一方已批准权限免同意且不可通过 consent API 停用；兼容 QuickLogin 0.4.1 的 `prompt=consent`；保留下载站精确只读 CORS 例外。0013 在最终维护窗口作废共享凭据时代的会话、设备令牌和待完成认证，不删除账号/因子/业务资料。

## 证据范围

Auth 本轮完整自动验证为 97 个单元/界面测试文件、877 项，以及 41 个 Workers 文件、384 项；类型、生成契约、导入边界及前端构建通过。针对最终 Cookie/来源、GET 与 form POST 免同意、真实设备授权与 consent 所有权，以及下载站精确只读例外另有真实 HTTP/D1 回归。以最终提交的 CI 为最终自动门禁，数量不代替浏览器或生产验收。

父任务实际本地浏览器在 Auth localhost、Schedule 127.0.0.1、UC [::1] 三个不同主机完成登录、单站退出、显式重新登录和中央全设备退出；Schedule 随后返回 401，UC 受保护成员入口跳回登录。密码管理员强认证准入、TOTP 设置、人工随机密码恢复与关闭结果、正常改密保留当前会话也已实测。正式检查路径为 `/api/v1/auth/get-session`；旧 `/api/auth/get-session` 在本应用为 404，不能拿它判断会话是否丢失。

最终 Auth `d0e6b1d` 已在本地 fixture D1 应用 0013 后完成三主机浏览器复验：Auth 密码加 TOTP 登录、Schedule/UC 无需重复输入凭据的 OAuth 登录、新 `auth-v2.session_token` 与旧 Cookie 清除、两个站点分别退出并主动接回、中央全设备退出后 Schedule 401 和 UC 回登录均通过。Auth/UC 的本地 HTTP Cookie 不带 Secure；Schedule 的本地 `__Host-schedule_session` 带 Secure。生产 HTTPS `__Host-auth-v2` 属性有真实 HTTP/D1 测试依据，不把本地 HTTP 浏览器结果写成生产 HTTPS 验收。

四份独立只读静态审查（Auth Standards/Spec、消费者 Standards/Spec）均为 0 项可行动发现。固定范围为 Auth `4ea1cf055fd25ee877160f7683d3b24eb69e718a...d0e6b1d9d600a5fdeb44b1d6aacaacee44a163e2`、Schedule `e2114ae2abcd461ebab20fb72694d3f2ed8a46b2...9d6cd7f3ba4f47af2a523e2f315eb767692f1476`、UC `faa7fa373b3c0bd1caedf6efc5b0a77723515e6c...23b1c1f93421c5cd215adef0df29a151a7186664`。审查涵盖仓库规范/Fowler 基线与规格、认证/会话/权限、迁移、界面及运行文档；没有重跑测试或执行生产操作，不能代替部署验收。

Passkey 的密码学 HTTP/D1 测试通过，但实际浏览器虚拟认证器持续返回 NotAllowedError，未完成浏览器绑定。未安装或操作用户真实扩展，也未用真实密码管理器保存凭据。QuickLogin 0.4.1 干净隔离构建通过 96 项测试、类型/构建/包契约与 8 项发布脚本测试，只生成本地 canary，不代表原生 Chrome identity 或学校 Cookie 操作验收。下载站另有类型、构建、检查及六页导航资源验证。

## 生产仍需执行

2026-10-09 只读核实：Auth 最新流量版本仍为 `38dd4e9d-f2d6-4157-8b39-8b80ff5738c4`；远端 0010–0013 尚未应用。OAuth 客户端只有 Schedule 和 QuickLogin，查询 rows_written=0；Schedule 尚缺 refresh/RPC 元数据，QuickLogin 尚 skipConsent=false，UC 尚无 OAuth 注册。Schedule 与 UC 已识别当前生产 Worker/源版本，但本次未迁移上线。下载站 `quick-login-website` 的实际版本另已核实；没有 commit 元数据，不声称与本地源码逐字节一致。

发布必须先完成兼容 Auth、消费者配置/迁移和人工接入清单，再进入维护窗口应用最终凭据退休并发布隔离 Auth。禁止直接把包含 0013 的最终分支作为第一阶段部署，也不允许回滚成根域 Cookie、通配可信来源或旧凭据。完整命令、顺序、失败处理与待人工门禁均在切换手册。
