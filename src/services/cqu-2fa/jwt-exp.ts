/**
 * 尽力从一个 JWT 的 payload(第二段)里解出 `exp`(过期时刻, 秒)。
 *
 * 仅用于诊断: 用来观测 SOURCEID_TGC(TGT) 的服务端寿命, 排查 CQU 会话疑似「定点过期」
 * (按固定时刻而非固定时长过期)。纯函数, 不抛错: 任何步骤失败(非 JWT/段缺失/base64
 * 坏/JSON 解不开/无数字 exp)一律返回 null, 由调用方记 undecodable。
 *
 * 注意: SOURCEID_TGC 内层可能是 JWE(加密), 这种情况第二段不是明文 JSON, 会自然落到
 * null 分支 —— 这正是我们要观测的「解不开」信号, 不视为异常。
 *
 * @param token JWT 字符串(形如 header.payload.signature)。**绝不在日志里记 token 本身。**
 * @returns exp(秒, number) 或 null(无法解出)。
 */
export function decodeJwtExp(token: string): number | null {
  try {
    if (typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length < 2) return null; // 非 JWT 三段结构
    const payload = base64UrlDecode(parts[1]);
    if (payload === null) return null;
    const obj = JSON.parse(payload) as unknown;
    if (obj === null || typeof obj !== "object") return null;
    const exp = (obj as Record<string, unknown>).exp;
    // exp 必须是有限数字(JWT 规范是 NumericDate, 秒); 字符串/缺失/NaN 一律视为解不出。
    return typeof exp === "number" && Number.isFinite(exp) ? exp : null;
  } catch {
    return null;
  }
}

/**
 * base64url 解码为字符串。兼容 URL-safe 字符(`-_` → `+/`)与缺省 padding。
 * Workers 运行时有全局 atob。失败(非法 base64)返回 null。
 */
function base64UrlDecode(input: string): string | null {
  try {
    let b64 = input.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4;
    if (pad === 1) return null; // 长度非法, 不可能是有效 base64
    if (pad) b64 += "=".repeat(4 - pad);
    return atob(b64);
  } catch {
    return null;
  }
}
