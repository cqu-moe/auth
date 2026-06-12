const CQU_IP_PREFIX = "202.202.0."; // 202.202.0.0/24（smtp/pop3.cqu.edu.cn）

// 从 raw header（多条同名 ARC-Authentication-Results 被 CF 逗号拼接）中切出 *仅* CF 自己盖的那一条，
// 把信任锚定在 authserv-id 上，而不是裸 substring 匹配。
//
// 攻击模型：入站邮件可能自带伪造的 ARC-Authentication-Results 行。CF 作为边界 MX 会把它自己
// 盖的那条（authserv-id=mx.cloudflare.net）*前插*。`headers.get()` 把所有同名 header 逗号拼接，
// 于是 raw 形如 `i=1; mx.cloudflare.net; ...spf=fail..., i=1; evil.example; ...spf=pass...`。
//
// 策略：只取 raw 的第一条 ARC 实例（按"新实例起始边界 `, i=N;`"切分），再要求它确实以 CF 的
// authserv-id 开头。这样：
//   - 攻击者在尾部追加的伪造段被丢弃（只取第一条）；
//   - 攻击者把伪造段放第一位（CF 真 authserv-id 不在最前）会被 authserv-id 校验拒绝（返回 null）。
export function trustedCfArc(rawHeader: string): string | null {
  // 按"新 ARC 实例的起始边界"（逗号后跟 `i=<digits>;`）切分，只保留第一段。
  const first = rawHeader.split(/,\s*(?=i=\d+\s*;)/)[0].trim();
  // 要求第一段以 CF 的 authserv-id 打头，否则视为不可信。
  if (!/^i=\d+\s*;\s*mx\.cloudflare\.net\b/i.test(first)) return null;
  return first;
}

// 只解析 CF 盖的 ARC-Authentication-Results（调用方须先用 trustedCfArc 确认 authserv-id=mx.cloudflare.net）
export function parseInboundAuth(arc: string) {
  // clause-bounded [^;]：锁定绑 smtp.mailfrom 的那条 spf（跳过 smtp.helo 的 spf=none），勿用 /s dot-all
  const spf = arc.match(/spf=(\w+)\b[^;]*smtp\.mailfrom=/i)?.[1] ?? "none";
  const envelopeFrom = arc.match(/smtp\.mailfrom=([^;\s]+)/i)?.[1] ?? "";
  const sourceIp = arc.match(/smtp\.remote-ip=([^;\s]+)/i)?.[1] ?? "";
  return { spf, envelopeFrom, sourceIp };
}

export function senderVerified(
  auth: { spf: string; envelopeFrom: string; sourceIp: string },
  bind: { kind: string; senderWhitelist: string[] }
): boolean {
  const officialOk =
    auth.spf === "pass" &&
    bind.senderWhitelist.includes(auth.envelopeFrom) &&
    auth.sourceIp.startsWith(CQU_IP_PREFIX);
  if (officialOk) return true;
  // forward 模式：额外接受用户登记的转发地址（信任较弱）
  if (bind.kind === "forward" && auth.spf === "pass" && bind.senderWhitelist.includes(auth.envelopeFrom)) return true;
  return false;
}
