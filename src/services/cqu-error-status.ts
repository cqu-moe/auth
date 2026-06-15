/**
 * 把 CquSsoError.code 映射为合适的 HTTP 状态码。
 *
 * 纯函数(无副作用、无依赖),供 DO fetch catch 用于决定返回给上游的状态码:
 * 策略/客户端错误(serviceUrl 非法、未知 service、未开 quicklogin、会话未激活、限频)
 * 应回各自语义对应的 4xx,而非一律 500(伪装成服务器崩溃)。
 * 服务端/未知错误(TGT 过期、无票、网络错误、INTERNAL_ERROR、未识别的 code)仍回 500。
 */

const CODE_TO_STATUS: Record<string, number> = {
  INVALID_SERVICE_URL: 400,
  UNKNOWN_SERVICE: 400,
  QUICKLOGIN_NOT_ENABLED: 403,
  SESSION_INACTIVE: 409,
  NEEDS_REAUTH: 409,
  RATE_LIMITED: 429,
};

export function cquErrorHttpStatus(code: string): number {
  return CODE_TO_STATUS[code] ?? 500;
}
