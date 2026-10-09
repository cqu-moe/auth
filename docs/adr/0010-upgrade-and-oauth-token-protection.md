---
status: accepted
date: 2026-10-09
---

# 升级 Better Auth 并加入 PKCE 与 DPoP 防护

本轮明确升级 Better Auth，采用用户授权码流程的 S256 PKCE，并加入 DPoP 支持以降低 OAuth 令牌泄露后的可用性。当前核实的评估版本为 1.7.7，实际实施前复核最新稳定版、相关包和 Cloudflare 适配器兼容性。

PKCE 约束授权码兑换；DPoP 将令牌绑定到客户端持有的密钥，签发、刷新、客户端请求签名和资源端验证必须一起成立。不能只开启签发开关或只检查 JWT 签名；已绑定令牌不得降级为普通 Bearer 使用。DPoP 不替代 scope、audience、用户状态检查或敏感操作的强认证，也不保护已经能使用签名密钥的受控客户端。

DPoP 用于 OAuth HTTP 通道，不套到私有 Worker RPC 的服务身份上。**本轮提供 DPoP 支持，暂不强制任何现有客户端启用。** 未绑定的 Bearer 凭据保持正常验证；客户端一旦选择 DPoP，绑定必须持续到刷新与资源请求，不能按请求选择跳过 proof 或降级成 Bearer。

复用框架与 D1 verification 的原子重放存储，不为 DPoP 引入独立缓存或授权系统。不将现有第一方客户端的全面 DPoP 迁移作为此次升级前提；为选择启用的客户端提供标准接入契约并完成互操作验证。
