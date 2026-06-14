// 仅允许 https 的 *.cqu.edu.cn,杜绝 CVE-2022-39369 式 ST-relay。
// 红线:① 解析前拒反斜杠/非ASCII;② 绝不裸 endsWith;③ 强制 ToASCII;④ 只返回 canonical href。
export function validateCquServiceUrl(input: string): string {
  if (input.includes("\\")) throw new Error("INVALID_SERVICE_URL: backslash");        // \→/ 跨解析器陷阱
  if (/[^\x20-\x7e]/.test(input)) throw new Error("INVALID_SERVICE_URL: non-ascii");  // 杀 IDN同形/全角点/CRLF
  let u: URL;
  try { u = new URL(input); } catch { throw new Error("INVALID_SERVICE_URL: unparsable"); }
  if (u.protocol !== "https:") throw new Error("INVALID_SERVICE_URL: not https");
  if (u.username || u.password) throw new Error("INVALID_SERVICE_URL: userinfo");
  if (u.port && u.port !== "443") throw new Error("INVALID_SERVICE_URL: port");
  const host = u.hostname.toLowerCase();
  if (/[^a-z0-9.-]/.test(host)) throw new Error("INVALID_SERVICE_URL: bad host char");  // %编码等残留
  if (host.endsWith(".")) throw new Error("INVALID_SERVICE_URL: trailing dot");         // cn. == cn 风险
  if (!(host === "cqu.edu.cn" || host.endsWith(".cqu.edu.cn")))                          // 判 PARSED hostname
    throw new Error("INVALID_SERVICE_URL: host not allowed");
  return u.href; // canonical;下游(cqu.ts/DO/RPC)只用此返回值,绝不回传原始 input
}
