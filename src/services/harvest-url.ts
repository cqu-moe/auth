// harvest 取数仅允许直连应用的精确 host。红线与
// service-url.ts 一致(反斜杠/非ASCII/scheme/userinfo/端口/host字符)。
const HARVEST_HOSTS = {
  "my.cqu.edu.cn": "direct",
} as const;

export type CquHarvestHost = (typeof HARVEST_HOSTS)[keyof typeof HARVEST_HOSTS];

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
  if (!(host in HARVEST_HOSTS)) throw new Error("INVALID_HARVEST_URL: host not allowed");
  return u.href; // canonical; 下游只用此返回值
}

/**
 * 校验一份 recipe 的 nav/fetch URL 使用同一个允许 host，并返回应选择的浏览器状态类型。
 * canonical URL 仍由调用方使用 validateCquHarvestUrl 的返回值构造，避免转发未校验原文。
 */
export function validateCquHarvestRecipeHosts(
  navUrl: string,
  fetchUrls: string[]
): CquHarvestHost {
  const navHost = new URL(validateCquHarvestUrl(navUrl)).hostname;
  for (const raw of fetchUrls) {
    const fetchHost = new URL(validateCquHarvestUrl(raw)).hostname;
    if (fetchHost !== navHost) {
      throw new Error("INVALID_HARVEST_URL: recipe URLs must use the same host");
    }
  }
  return HARVEST_HOSTS[navHost as keyof typeof HARVEST_HOSTS];
}

/** 非抛版谓词(用于 capture/fetch 批量校验,任一不过即整体拒)。 */
export function isCquHarvestUrl(input: string): boolean {
  try { validateCquHarvestUrl(input); return true; } catch { return false; }
}
