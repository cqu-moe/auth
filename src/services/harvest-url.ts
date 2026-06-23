// harvest 取数仅允许 https 的 my.cqu.edu.cn(精确,非 *.cqu.edu.cn)—— organic harvest 只打这一个
// host。红线与 service-url.ts 一致(反斜杠/非ASCII/scheme/userinfo/端口/host字符),host 判定收紧。
const HARVEST_HOST = "my.cqu.edu.cn";

export function validateCquHarvestUrl(input: string): string {
  if (input.includes("\\")) throw new Error("INVALID_HARVEST_URL: backslash");
  if (/[^\x20-\x7e]/.test(input)) throw new Error("INVALID_HARVEST_URL: non-ascii");
  let u: URL;
  try { u = new URL(input); } catch { throw new Error("INVALID_HARVEST_URL: unparsable"); }
  if (u.protocol !== "https:") throw new Error("INVALID_HARVEST_URL: not https");
  if (u.username || u.password) throw new Error("INVALID_HARVEST_URL: userinfo");
  if (u.port && u.port !== "443") throw new Error("INVALID_HARVEST_URL: port");
  const host = u.hostname.toLowerCase();
  if (/[^a-z0-9.-]/.test(host)) throw new Error("INVALID_HARVEST_URL: bad host char");
  if (host !== HARVEST_HOST) throw new Error("INVALID_HARVEST_URL: host not allowed");
  return u.href; // canonical; 下游只用此返回值
}

/** 非抛版谓词(用于 capture/fetch 批量校验,任一不过即整体拒)。 */
export function isCquHarvestUrl(input: string): boolean {
  try { validateCquHarvestUrl(input); return true; } catch { return false; }
}
