// 纯函数:从 {service, serviceUrl} 查询参数决定取票模式。
// serviceUrl 在场 → 宽松 quick-login(url 模式);否则 service 在场 → 符号 key(symbolic 模式);
// 两者皆缺 → none(调用方应回 400)。serviceUrl 优先级高于 service(广路径显式),
// 但调用方一次只该带其一;此处不报错,只做确定性归类(校验留给各模式自身)。
export type ServiceTicketMode =
  | { mode: "url"; serviceUrl: string }
  | { mode: "symbolic"; service: string }
  | { mode: "none" };

export function pickServiceTicketMode(params: {
  service?: string | null;
  serviceUrl?: string | null;
}): ServiceTicketMode {
  if (params.serviceUrl) return { mode: "url", serviceUrl: params.serviceUrl };
  if (params.service) return { mode: "symbolic", service: params.service };
  return { mode: "none" };
}
