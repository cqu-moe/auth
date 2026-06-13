// 入站发件人校验（inbound-to-Worker 路径）。
//
// 安全模型（修正后）：Cloudflare 在 Worker 的 email() handler 运行 *之前*，已在平台层（MX/邮局
// 阶段 2「Mail authentication requirement」）强制要求入站邮件 *通过 SPF 或 带正确 DKIM 签名*，
// 否则在进入 Worker 前就被 CF 拒收。
//   - cqu.edu.cn 没有 DKIM，且 SPF 只授权 CQU 自己的发信 IP（如 202.202.0.0/24）。
//   - 因此：任何 *到达本 Worker* 且信封 MAIL FROM 为 sso@cqu.edu.cn 的邮件，必然已在 CF MX 通过
//     SPF（来自 CQU 授权 IP）。攻击者从非 CQU IP 伪造信封 sso@cqu.edu.cn 会 SPF=fail 且无 DKIM，
//     在 Worker 之前就被 CF 挡掉。
//   - 故 Worker 内只需校验「信封发件人在白名单内」即可，无需自己复核 SPF/IP。
//
// 我们校验 *信封* 发件人（CF 文档：`message.from` 即 SMTP envelope MAIL FROM，是「应用于安全判断」
// 的字段），而非可伪造的邮件头 From。
//
// ⚠️ 历史教训（勿重新引入）：旧实现读 `ARC-Authentication-Results` 头并要求由 CF 盖章
// （trustedCfArc/parseInboundAuth）。但据 CF 文档（/email-service/reference/headers/），`ARC-*`
// 是「转发链」的认证头——只在 *转发* 路径（Send-to-an-email / SRS+ARC-sign）上添加，
// *不会* 出现在投递给 Worker email() handler 的入站邮件上。于是该头恒缺失、校验恒返回 null、
// 真实 CQU 邮件被全部误拒。该方案对 inbound-to-Worker 路径是错的，已删除。
//
// ── 转发模式（kind=forward）的发件人校验 ──
// 转发模式下用户保留自己的邮箱作 CQU 密保邮箱，设转发规则把 CQU 邮件转发到我们地址。邮件经用户邮箱
// 转发后，信封 MAIL FROM 被 SRS 改写成 *转发方* 地址（不再是 sso@cqu.edu.cn），CF 的 SPF 闸此时只
// 证明「来自该转发服务」，不证明「内容来自 CQU」。原始 CQU 来源只剩在 *邮件头 From* 里（可伪造）。
// 故 forward 的信任模型 =
//   (1) envelope ∈ 用户登记的转发地址：证明邮件穿过了该用户的转发器（SPF 对转发方域成立），不靠它
//       证明 CQU 来源——它只把可行攻击从「仅知 token 者直投」收窄为「先把伪造邮件塞进用户邮箱再被转发」。
//   (2) header From 地址 === sso@cqu.edu.cn：补回 CQU 来源信号。**这是弱保证、可伪造**（header From
//       非签名、cqu.edu.cn 无 DKIM），本质弱于直设；最坏后果是注入假码致单次重登失败（DoS 级），
//       非账号接管。
// ⚠️ 同样勿在此重新引入 ARC：转发模式校验的也只是 envelope（CF SPF 闸的对象）+ header From（MIME 内），
// 不读 ARC-* 头。
export const CQU_SENDER = "sso@cqu.edu.cn";

export function envelopeSenderAllowed(envelopeFrom: string, senderWhitelist: string[]): boolean {
  const from = (envelopeFrom || "").trim().toLowerCase();
  if (!from) return false;
  return senderWhitelist.some((s) => s.trim().toLowerCase() === from);
}

// forward 模式发件人校验（纯函数，可单测）：
//   envelope ∈ 用户登记的转发地址（穿过该用户转发器）  &&  header From 地址 === CQU。
// 顺序固定：envelope 不过直接 false（不看 header From）；envelope 过后再校验 header From。
export function forwardSenderAllowed(
  envelopeFrom: string,
  headerFromAddress: string,
  senderWhitelist: string[]
): boolean {
  if (!envelopeSenderAllowed(envelopeFrom, senderWhitelist)) return false;
  return (headerFromAddress || "").trim().toLowerCase() === CQU_SENDER;
}
