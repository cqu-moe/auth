export type CodeHit = { code: string; kind: "login_2fa" | "bind_confirm" };

export function extractCode(subject: string, text: string): CodeHit | null {
  const s = (subject || "").trim();
  const t = text || "";
  if (s.includes("邮件验证码登录")) {
    const m = t.match(/(?<!\d)(\d{6})(?!\d)/); // 600 是 3 位不命中
    return m ? { code: m[1], kind: "login_2fa" } : null;
  }
  if (s.includes("密保邮箱绑定验证码")) {
    const m = t.match(/验证码为[:：]\s*(\d{6})/); // 必须锚定，避开学号前 6 位
    return m ? { code: m[1], kind: "bind_confirm" } : null;
  }
  return null;
}
