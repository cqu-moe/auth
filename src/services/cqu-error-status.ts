/**
 * 把 CquSsoError.code 映射为合适的 HTTP 状态码。
 *
 * 纯函数(无副作用、无依赖),供 DO fetch catch 用于决定返回给上游的状态码:
 * 策略/客户端错误(serviceUrl 非法、未知 service、未开 quicklogin、会话未激活、限频)
 * 应回各自语义对应的 4xx,而非一律 500(伪装成服务器崩溃)。
 * 会话失效类(TGT 过期、会话未激活、需重认证)是「可行动态」(交重登/会自愈),回 409,
 * 让调用方能与「服务器真崩溃(5xx)」区分(该重试/会自愈 vs 不可恢复)。
 * 真正的服务端/未知错误(无票、网络错误、INTERNAL_ERROR、未识别的 code)仍回 500。
 */

const CODE_TO_STATUS: Record<string, number> = {
  INVALID_SERVICE_URL: 400,
  // organic harvest 的 host 越界(navUrl/fetch.url 非精确 my.cqu.edu.cn): 同 INVALID_SERVICE_URL
  // 一类客户端输入错误 → 400, 而非 fallback 500(伪装成服务器崩溃)。
  INVALID_HARVEST_URL: 400,
  INVALID_SEARCH_RECIPE: 400,
  INVALID_CAPTURE_RECIPE: 400,
  UNKNOWN_SERVICE: 400,
  QUICKLOGIN_NOT_ENABLED: 403,
  PAGE_PERMISSION_DENIED: 403,
  SESSION_INACTIVE: 409,
  NEEDS_REAUTH: 409,
  // TGT 过期:会话失效但可经重登自愈,同 SESSION_INACTIVE/NEEDS_REAUTH 一类回 409,
  // 不再 fallback 成 500(伪装成服务器崩溃,调用方无法判断该重试/会自愈)。
  TGT_EXPIRED: 409,
  SCHEDULE_NOT_PUBLISHED: 409,
  WAF_BOOTSTRAP_TIMEOUT: 503,
  APP_READY_TIMEOUT: 503,
  TABLE_CAPTURE_TIMEOUT: 503,
  WAF_CHALLENGE: 503,
  HARVEST_TRANSIENT: 503,
  TABLE_REQUEST_HUNG: 504,
  TABLE_BODY_TIMEOUT: 504,
  TABLE_API_REJECTED: 502,
  SEARCH_CAPTURE_TIMEOUT: 503,
  SEARCH_REQUEST_HUNG: 504,
  SEARCH_BODY_TIMEOUT: 504,
  SEARCH_API_REJECTED: 502,
  SEARCH_TRANSIENT: 503,
  TARGET_NOT_FOUND: 404,
  AMBIGUOUS_TARGET: 409,
  CURRENT_SESSION_CHANGED: 409,
  CAPTURE_MISSING: 503,
  CAPTURE_API_REJECTED: 502,
  CAPTURE_BODY_TIMEOUT: 504,
  SCHEMA_INVALID: 502,
  CAPTURE_TRANSIENT: 503,
  // 浏览器容量/实例替换/截止时间:瞬态基础设施状态,保留旧会话 → 503。
  BROWSER_BUSY: 503,
  BROWSER_INSTANCE_REPLACED: 503,
  BROWSER_DEADLINE: 503,
  // deadline 入参非法是客户端输入错误 → 400。
  INVALID_BROWSER_DEADLINE: 400,
  RATE_LIMITED: 429,
};

export function cquErrorHttpStatus(code: string): number {
  return CODE_TO_STATUS[code] ?? 500;
}
