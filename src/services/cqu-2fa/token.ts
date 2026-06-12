export function genAddressToken(): string {
  // 16 chars of base36 ≈ 82 bits 熵——不可猜测；之所以保持短，是因为部分邮件服务商
  // （如 CQU 自助服务中心）会限制本地部分长度。地址不可猜测性只是 SPF + 信封 + IP
  // 发件方校验之上的纵深防御，并非唯一的安全闸门。
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (const b of bytes) out += alphabet[b % 36];
  return out;
}
