// 纯函数:把取票目标({service, serviceUrl})映射到所需 cqu scope。
// 单独成模块(不 import 任何 Workers 运行时虚拟模块如 cloudflare:workers),
// 以便在 Node-pool vitest 里单测 —— rpc.ts 的 RPC/DO 集成本身不可单测。
//   - serviceUrl(广路径快捷登录) → "cqu:ticket:any"(优先级高于 service);
//   - service(符号 key)         → "cqu:ticket:" + service;
//   - 两者皆缺                    → { error: "MISSING_TARGET" }。
// 与 route 的 pickServiceTicketMode 同样以 serviceUrl 优先,语义对齐:这里只决定
// scope,host 校验仍由 DO chokepoint 权威再做(本函数不校验 URL 合法性)。
export function requiredScopeForTarget(target: {
  service?: string | null;
  serviceUrl?: string | null;
}): { required: string } | { error: string } {
  if (target.serviceUrl) return { required: "cqu:ticket:any" };
  if (target.service) return { required: `cqu:ticket:${target.service}` };
  return { error: "MISSING_TARGET" };
}
