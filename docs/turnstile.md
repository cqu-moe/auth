# Auth 安全验证

使用已有 Managed widget，site key 为 `0x4AAAAAAEzqhmaJIXcAno2H`。不创建或轮换 widget。

## 保护范围

所有下列操作在进入 Better Auth 和邀请码处理前，都必须通过服务端 Siteverify。

| `/api/v1/auth` 下的 POST 路径 | action | 页面 |
| --- | --- | --- |
| `/sign-up/email` | `signup` | 注册 |
| `/sign-in/email` | `password-login` | 密码登录 |
| `/request-password-reset` | `password-reset` | 找回密码 |
| `/email-otp/send-verification-otp` | `email-verification` | 邮箱验证重发、改绑时向当前邮箱发码 |
| `/send-verification-email` | `email-verification` | Better Auth 邮件验证入口 |
| `/email-otp/request-email-change` | `email-change` | 改绑时向新邮箱发码 |

浏览器通过 `x-turnstile-token` 请求头发送 token。服务端要求 Siteverify 的 `success` 严格为 `true`，action 与操作匹配，hostname 与 `BETTER_AUTH_URL` 的 hostname 匹配；不信任请求的 Host、Origin 或转发头来扩大允许域名。缺失配置和上游异常都拒绝操作，现有登录、邮件、邀请码、限流与二次验证规则继续生效。

Passkey、输入邮件验证码、TOTP/恢复码、持有重置链接后的改密，以及 OAuth/QuickLogin 后台接口不增加人机验证。安全验证不替代身份验证或限流。

## 等待与恢复

- Managed widget 设置 `appearance: "interaction-only"`，自动在后台获取 token；正常情况下不显示验证框或成功状态，仅在提供方要求人工交互时显示控件。显示方式与执行时机独立，保留默认的渲染后立即验证。
- 注册、登录、密码找回在填写时提前准备验证。用户可以直接提交；尚未完成时显示“正在完成安全验证…”，通过后只继续这一次提交。
- 等待期间保留并锁定当前输入，避免自动提交用户已经改动的旧值。离开页面会取消待提交操作。
- 普通等待只更新提交按钮的 loading，不插入提示文字或取消操作，避免按钮跳动。需要人工交互时验证区域以 280ms 平滑展开并淡入，提供明确提示；减少动态效果或键盘操作时直接显示。
- 脚本加载最多等待 15 秒，一次提交等待验证最多 60 秒。失败保留输入，显示“安全验证加载失败，请重试后再次提交”；只使用原提交按钮重试（如“重试登录”），重新验证成功后自动继续这次提交。
- token 为一次性凭证，服务器调用后刷新；过期或临近过期时重新验证。一个页面的凭证不会复用到其他操作。
- 邮箱验证码页面只在请求重发时显示安全验证，输入已收到的邮件验证码不等待 Turnstile。
- 重发还在等待安全验证时，用户可以提交已经收到的邮箱验证码；此时自动取消未发出的重发操作，迟到的验证结果不会触发邮件。重发 HTTP 已经开始后，保留原有串行限制。

### 交互决策（2026-10-27）

- 采用提交按钮内的 loading：未完成验证时按钮转圈并说明正在安全验证；用户明确要求不显示额外等待文案或取消操作，失败后才显示重试。
- 失败时只保留原提交按钮的重试入口，不另设“重试验证”按钮。
- 不采用常驻验证框或状态条，避免正常登录多占一块区域；不采用单独的“账号安全验证”卡片，避免把后台检查变成额外步骤。
- 手动挑战保留真实控件及明确提示，通过后自动继续已发起的提交；不把所有等待状态都简化成无说明的转圈。
- 配置依据：[Cloudflare Appearance modes](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/widget-configurations/#appearance-modes)。

## 配置与发布

Worker secret 名称是 `TURNSTILE_SECRET`，只能写入 Cloudflare Worker secret 或本地忽略的 `.dev.vars`；不得写入仓库、前端、日志或聊天。

生产目标为账号 `a666c560407022706a52a703923548d5` 下的 `cqu-moe-auth`，配置文件为根目录 `wrangler.jsonc`（默认环境）。上线前必须核对 widget 允许 `auth.cqu.moe`，并绑定对应 secret。生产 hostname 不能是本地域名，生产不能使用 Cloudflare 测试 secret。

按照 [Cloudflare existing-widget 流程](https://developers.cloudflare.com/turnstile/spin/#recover-an-existing-widget)，自动读取 secret 前要确认账号、site key、域名、工具版本与准确写入目标；只通过进程内存和标准输入传递。自动读取需要项目外、固定版本的 Wrangler 4.109 或以上和 Turnstile 读取权限。

若由维护者手动配置，可在核对上述目标后运行 `wrangler secret put TURNSTILE_SECRET --config wrangler.jsonc --name cqu-moe-auth` 并在终端输入密钥。配置本身不代表新代码已部署。

本地前端可通过 `VITE_TURNSTILE_SITE_KEY` 指定专用于本地环境的 widget。实际域名必须在该 widget 的允许范围内；对应后端 URL、secret 和 action 校验仍然启用。隔离 E2E 在浏览器脚本与 Siteverify 网络边界模拟提供方，不在生产逻辑添加跳过开关。

## 验证边界

本地行为测试覆盖等待、离开页面、失败重试、过期、一次性提交和 Passkey 独立入口；后端测试覆盖无效 token、hostname/action 错配、上游失败及防护入口。真实 widget 还需在目标域名取得新 token，完成一次后端验证，并确认相同 token 重放被拒绝。模拟预览和测试不证明中国用户实际网络加载速度。
