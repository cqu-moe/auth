# CQU Auth 二次验证与邮箱 OTP 更换设计

日期：2026-09-05
状态：已确认

## 目标

在现有 Better Auth 登录体系上增加完整、用户可选开启的二次验证，并把修改邮箱迁移到 Better Auth 原生 Email OTP 流程。

本阶段交付：

- TOTP 验证器应用；
- Email OTP 作为登录二次验证备用方式；
- 一次性备份码；
- 可选的 30 天可信设备；
- 二次验证启用、确认、恢复码管理和停用界面；
- 登录时的二次验证挑战页；
- 当前邮箱 OTP、新邮箱 OTP 的邮箱更换流程；
- Passkey 验证方式的代码级能力位预留。

Passkey 插件、Passkey 数据表、WebAuthn 注册/认证页面不在本阶段实现，也不显示不可用入口。

## 方案选择

采用 Better Auth 原生 `twoFactor` 和 `emailOTP` 插件，不自建 OTP、TOTP、备份码或敏感操作票据系统。

原因：

- `twoFactor` 已提供 TOTP、Email OTP、备份码、登录挑战和可信设备；
- `emailOTP` 的 `changeEmail.verifyCurrentEmail` 能原生实现当前邮箱 OTP 后再向新邮箱发送 OTP；
- 两个邮箱 OTP 都由 Better Auth 的 verification 存储、有效期、尝试次数和原子消费逻辑管理；
- 避免自定义认证状态与 Better Auth 会话状态分叉。

不再使用已提交基线中的默认 `user.changeEmail` 双链接流程，也不保留“当前邮箱确认链接 → 新邮箱确认链接”的兼容分支。

## 服务端配置

在 `createAuth` 中加入：

1. `twoFactor` 插件：
   - issuer：`auth.cqu.moe`；
   - TOTP：6 位、30 秒周期；
   - Email OTP：6 位、5 分钟有效、最多 3 次失败、哈希存储；
   - 备份码使用 Better Auth 默认加密存储和一次性消费；
   - 登录挑战有效期 10 分钟；
   - 可信设备有效期 30 天；
   - 不跳过启用后的第一次 TOTP 验证。
2. `emailOTP` 插件：
   - `disableSignUp: true`，不能通过 OTP 创建账户；
   - 6 位、5 分钟有效、最多 3 次失败；
   - `storeOTP: "hashed"`、`resendStrategy: "rotate"`；
   - `changeEmail.enabled: true`；
   - `changeEmail.verifyCurrentEmail: true`；
   - 不设置 `overrideDefaultEmailVerification`，注册时仍沿用现有邮箱验证链接。
3. 两类邮件均复用 Resend：
   - 登录二次验证 OTP；
   - 当前邮箱身份确认 OTP；
   - 新邮箱更换确认 OTP。
4. 为发送 OTP、验证 OTP、验证 TOTP 和验证备份码配置更严格的路径级限流；限流状态使用现有 KV secondary storage，不依赖单个 Worker 实例的内存。

邮件正文只包含用途、验证码和有效期，不记录或回显 TOTP secret、备份码、会话 Cookie。

## 数据模型和迁移

新增迁移 `0006_two_factor.sql`，并同步 `src/db/schema.ts`：

- `user.twoFactorEnabled`：boolean/integer，默认 `false`；
- `twoFactor` 表：
  - `id` 主键；
  - `userId` 外键，删除用户时级联删除；
  - `secret`；
  - `backupCodes`；
  - `verified`，默认 `false`，首次 TOTP 校验通过后再由 Better Auth 标记为已验证；
  - `secret` 和 `userId` 索引。

OTP 继续使用现有 `verification` 表，不新增 OTP 表。迁移必须能在已有用户和已有 verification 数据的数据库上直接应用。

## 客户端能力

`authClient` 增加 `twoFactorClient` 和 `emailOTPClient`。

定义统一的客户端验证方式类型：

```ts
type SecondFactorMethod = "totp" | "email-otp" | "backup-code" | "passkey";
```

本阶段的可用方式只包含前三项；`passkey` 只用于保证后续页面状态和方法选择器可以扩展，不触发任何 API。

## 二次验证设置流程

设置页保留现有布局，新增“二次验证”卡片：

- 未启用：显示状态和“启用二次验证”；
- 已启用：显示 TOTP 已启用、Email OTP 可备用、备份码可恢复，并提供管理入口。

复杂操作放在独立的 `/settings/two-factor` 页面：

### 启用

1. 用户输入当前密码；
2. 调用 `twoFactor.enable`，取得 `totpURI` 和备份码；
3. 本地生成二维码，同时提供可复制的手动密钥；
4. 用户输入验证器中的 6 位 TOTP；
5. 调用 `twoFactor.verifyTotp`；只有成功后才显示“已启用”；
6. 备份码只在本次启用流程中完整展示一次，提醒用户离线保存。

### 管理

- 重新生成备份码前要求当前密码；旧备份码立即失效；
- 停用二次验证前要求当前密码；
- 不提供查看 TOTP secret 或找回旧备份码的功能。

二维码由前端本地生成，不把 `totpURI` 发送给第三方二维码服务。

## 登录挑战流程

密码登录返回 `twoFactorRedirect` 时进入 `/two-factor`，不能提前创建已认证会话。

挑战页提供：

1. TOTP，默认方式；
2. Email OTP，用户主动点击发送后输入验证码；
3. 备份码；
4. “信任此设备 30 天”复选框，默认不勾选。

任一方式成功后恢复原登录目标；失败时留在当前方式并显示明确错误。挑战过期或无效 Cookie 时返回登录页重新开始；请求受到限流时保留当前页面并提示稍后重试。

## 修改邮箱流程

`/settings/email` 改为三阶段向导，全部使用 Better Auth Email OTP：

### 阶段一：验证当前邮箱

1. 页面显示当前邮箱；
2. 用户点击发送 OTP；
3. 调用 `emailOtp.sendVerificationOtp`，类型为 `email-verification`；
4. 用户输入 OTP；
5. 调用 `emailOtp.checkVerificationOtp`，验证成功后进入阶段二。

阶段一的 OTP 不在客户端验证。页面暂存该 OTP，是因为阶段二的原生 `requestEmailChange` 会再次验证并原子消费它。

### 阶段二：验证新邮箱

1. 用户输入新邮箱；
2. 调用 `emailOtp.requestEmailChange({ newEmail, otp: currentEmailOtp })`；
3. Better Auth 再次验证并消费当前邮箱 OTP，然后向新邮箱发送 `change-email` OTP；
4. 页面锁定本次新邮箱并进入阶段三。

### 阶段三：完成更换

1. 用户输入新邮箱收到的 OTP；
2. 调用 `emailOtp.changeEmail({ newEmail, otp })`；
3. Better Auth 原子消费新邮箱 OTP，将 `email` 更新为新地址并保持原 `user.id`；
4. 刷新会话，显示完成状态和新邮箱。

刷新页面会回到阶段一，不把当前邮箱 OTP 或新邮箱 OTP写入 URL、localStorage 或 sessionStorage。

## 安全约束

- OTP 仅在发送邮件的瞬间以明文存在；持久化值必须为哈希；
- 每次重发生成新 OTP，使旧 OTP 立即失效；
- OTP 5 分钟过期，最多 3 次错误后作废；
- 邮箱更换接口继续使用 Better Auth 的 authenticated sensitive-session middleware；
- Email OTP 的发送与检查请求必须绑定当前已登录用户的当前邮箱，不能成为任意邮箱探测或骚扰接口；
- 不在日志、错误响应、测试快照中写入真实验证码、TOTP secret 或备份码；
- 备份码成功使用后立即删除该码；
- Email OTP 由插件记录失败次数；TOTP 和备份码验证由路径级限流限制暴力尝试；
- 用户 ID、OAuth subject 和既有业务绑定在邮箱修改后保持不变。

## 错误处理

前端统一映射以下错误：

- OTP 无效或过期；
- 尝试次数过多；
- 2FA 挑战已失效；
- 请求过于频繁；
- 当前密码错误；
- 新邮箱已被占用；
- 网络或邮件发送失败。

按钮在请求中禁用；重发按钮带倒计时；错误不会推进步骤，成功响应才改变页面状态。

## 测试与验收

所有实现按 TDD 完成。

服务端集成测试至少覆盖：

- 迁移后已有用户默认未启用 2FA；
- 启用必须提供正确密码并完成首次 TOTP；
- 启用后密码登录不会在第二因子前建立最终会话；
- TOTP、Email OTP、备份码均可完成登录；
- 备份码只能使用一次；
- OTP 错误次数、过期与所有验证端点的限流生效；
- 当前邮箱 OTP 错误时不会向新邮箱发送邮件；
- 当前邮箱 OTP 正确后才发送新邮箱 OTP；
- 新邮箱 OTP 错误时邮箱不变；
- 两次 OTP 都正确后邮箱更新且 `user.id` 不变；
- OTP 不能跨用户、跨邮箱或跨用途使用。

前端测试至少覆盖：

- 设置页 2FA 状态卡；
- 启用、确认、备份码和停用状态；
- 登录挑战的方法切换；
- 邮箱修改三个阶段；
- 错误、加载、倒计时和成功状态。

最终验收运行完整 Vitest、Worker Vitest、TypeScript、ESLint、前端生产构建，并在浏览器检查桌面和窄屏布局。
