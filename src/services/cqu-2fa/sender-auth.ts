const CQU_IP_PREFIX = "202.202.0."; // 202.202.0.0/24（smtp/pop3.cqu.edu.cn）

// 只解析 CF 盖的 ARC-Authentication-Results（调用方须先确认 authserv-id=mx.cloudflare.net）
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
