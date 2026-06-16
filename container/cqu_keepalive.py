#!/usr/bin/env python3
"""国内节点探测 CQU 会话存活 —— httpx 经青果代理探活, 返回三态(alive/expired/unreachable)。
=============================================================================
铁律: 所有连 CQU 的出站一律经青果(让 CQU 只看到动态重庆移动 IP)。探测「会话是否还活」
也是「连 CQU」, 故这一跳也从国内节点发起、经青果出站。

职责边界(只返回「探测事实」, 不做「决策」):
  · 本模块只负责: 拿 DO 给的 3 个 cookie, 经青果去 CQU CAS 做一次探测换票, 把结果归成
    三态(alive / expired / unreachable)如实返回 DO。
  · 熔断 / 退避 / 状态机(该重登还是该退避)全留在 Cloudflare DO 侧
    (src/durable-objects/cqu-session.ts 的 alarm/runKeepAlive), 不迁到这里。

复刻来源: src/durable-objects/cqu-session.ts 的 `runKeepAlive` —— 它并不打专门的探活端点,
而是凭已有 cookie 去 CAS `/login?service=<DUMMY_SERVICE>` 试换一张 ST, 据结果分三态:
  · 换到 ST                         → "active"   (本模块 "alive")
  · 非 transient 的 CquSsoError      → "expired"  (TGT_EXPIRED, 落回 cas-login)
  · isTransientSsoError 为真 / 未知   → "transient"(本模块 "unreachable")
其中 DO 的 isTransientSsoError 把 NETWORK_ERROR / WAF_CHALLENGE / PARSE_ERROR 及任何未知
失败都判 transient —— 即「瑞数误判 / 未知页(NO_TICKET)」属退避语义, **绝不**判过期。
本模块的三态判定与之逐项对齐。

DRY: 探测换票直接复用 cqu_ticket.fetch_service_ticket(同一条经青果 ST-mint 路径, 复用
UA / 3-cookie / _proxy_url / looks_like_cas_login), 只是把它的 TicketError 语义重新归成
探活三态(关键差异: NO_TICKET 在取票端是 502 瞬态, 在探活端归 unreachable 让 DO 退避)。
"""
import cqu_ticket
from cqu_ticket import TicketError

# 探测用的 service: 对齐 DO 的 DUMMY_SERVICE(runKeepAlive 凭它试换 ST 做探活)。
PROBE_SERVICE = "https://my.cqu.edu.cn/authserver/authentication/cas"


def classify_probe(ticket: str | None = None, error: Exception | None = None) -> str:
    """把一次探测的结果(换到 ticket / 抛出的异常)归成三态字符串。纯函数, 便于单测。

    返回:
      · "alive":       探测换到了 ST(会话服务端有效)。
      · "expired":     TicketError(SESSION_EXPIRED) —— 落回 CAS 登录页, TGT 真失效。
                       仅此一种判过期(对齐 DO: 只有正向认出 cas-login 才算真过期)。
      · "unreachable": 其余一切 —— NO_TICKET(瑞数误判/未知页)、缺 cookie、网络层/超时、
                       未知异常。对齐 DO isTransientSsoError 的 transient 语义: 不证明
                       凭证坏, 让 DO 退避快重试而非误触重登。

    判定只依赖「已正向验证的 cas-login 信号(SESSION_EXPIRED)」—— 其余保守归 unreachable,
    因为「误判重登」的代价(触瑞数风控 + 烧容器)远高于「多退避一轮」。
    """
    if error is None and ticket:
        return "alive"
    # 只有正向认出 CAS 登录页(SESSION_EXPIRED)才判真过期; 其余 TicketError code 与
    # 任何非 TicketError 异常(网络层/超时/未知)一律保守归 unreachable。
    if isinstance(error, TicketError) and error.code == "SESSION_EXPIRED":
        return "expired"
    return "unreachable"


async def probe_session(cookies: dict, proxy: dict) -> dict:
    """凭 3 个 cookie, 经青果 proxy 去 CQU CAS 做一次探测换票, 返回结构化三态结果。

    复刻 DO runKeepAlive: 试换一张 ST(对齐 DUMMY_SERVICE), 据结果分 alive/expired/unreachable。
    网络层失败 / 超时 / 任何未预期异常都归 "unreachable"(transient 语义, 交 DO 退避)。

    返回 {"status": "alive"|"expired"|"unreachable", "detail": "..."}。
    detail 只含可诊断的简短说明, 绝不含 ticket / cookies。
    """
    try:
        # 换到 ST(其值不回传, 探活只关心「能不能换到」) → alive。
        await cqu_ticket.fetch_service_ticket(PROBE_SERVICE, cookies, proxy)
        return {"status": "alive", "detail": "probe minted ST"}
    except TicketError as e:
        status = classify_probe(error=e)
        return {"status": status, "detail": f"{e.code}: {e}"}
    except Exception as e:  # noqa: BLE001 - 网络层(httpx)/超时/未知一律归 unreachable
        # 网络/超时/未知 → unreachable(保守, 让 DO 退避而非误判过期)。
        return {"status": "unreachable", "detail": f"{type(e).__name__}: {e}"}
