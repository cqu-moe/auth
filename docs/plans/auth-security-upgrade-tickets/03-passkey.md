## Parent

[Auth 安全与第一方接入升级 #41](https://github.com/cqu-moe/auth/issues/41)

## What to build

让现有账号添加多个 Passkey、用 Passkey 登录及完成敏感操作验证，同时保留密码和当前注册流程。Passkey 经服务端确认用户验证后可独立满足强认证，不再叠加密码或 TOTP。

## Acceptance criteria

- [ ] 完成官方 Passkey 插件、持久化与登录/安全设置交互；保留现有页面风格和简体中文，不新增完全无密码注册模型。
- [ ] 仪式仅在中央认证站进行，固定适用的 rpID/origin；注册和登录均核查 UV，不能把插件默认 preferred 或客户端显示成功当作强制验证。
- [ ] 添加、删除和管理多个 Passkey 经过 T02 的近期认证门禁；普通被盗 session 不能直接植入永久登录凭据。
- [ ] UV Passkey 登录可独立建立强认证会话；当前会话的再次验证检查凭据归属，绑定当前用户/会话/用途，不通过换成另一个账号登录来满足原账号操作。
- [ ] 管理员可用 UV Passkey 满足管理准入；密码路径和 TOTP/恢复码仍按原规则工作。
- [ ] 缺失 UV、错误 origin/RP、其他用户凭据、过期或重复 challenge 被拒；合法多凭据的添加、登录、再次验证和删除通过协议测试及浏览器验收。
- [ ] 不把 Passkey 密钥复用于 DPoP，不要求用户每次业务请求进行生物识别。
