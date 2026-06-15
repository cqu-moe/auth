import { CquSsoError } from "./cqu-sso";

/**
 * keepalive 探针失败是否「transient」(保留会话、快重试)而非「真过期」(触发容器重登)。
 *
 * 网络错误(超时/重置)、不可解析页面(CQU 维护)、瑞数误判挑战页(WAF_CHALLENGE)
 * 都不证明凭证坏 —— 只有服务端 auth 拒绝(TGT_EXPIRED 等)才算真过期。
 * 未知失败(非 CquSsoError)保守判 transient: 重试胜于误判重登。
 *
 * 抽成独立纯函数(非内联于 cqu-session DO)以便 Node 测试池单测(DO 依赖 cloudflare:workers)。
 */
export function isTransientSsoError(e: unknown): boolean {
  if (e instanceof CquSsoError) {
    return (
      e.code === "NETWORK_ERROR" ||
      e.code === "PARSE_ERROR" ||
      e.code === "WAF_CHALLENGE"
    );
  }
  return true;
}
