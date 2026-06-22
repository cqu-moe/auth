#!/usr/bin/env python3
"""国内节点探测 CQU 会话存活 —— httpx 探活(出站默认经青果、灰度可节点直连), 返回三态(alive/expired/unreachable)。
=============================================================================
出站策略: 默认经青果(让 CQU 只看到动态重庆移动 IP); `proxy=None` 时改**节点直连**
(成都境内节点 IP 直连 CQU, 省青果配额)。走/不走青果由上游灰度门(qg_proxy.should_use_proxy,
开关 QG_PROXY_*/QG_ENABLED)决定, 本模块只把入参 proxy 透传给 fetch_service_ticket 选路。

职责边界(只返回「探测事实」, 不做「决策」):
  · 本模块只负责: 拿 DO 给的 3 个 cookie, 经青果或直连(由 proxy 是否为 None 决定)去 CQU CAS
    做一次探测换票, 把结果归成三态(alive / expired / unreachable)如实返回 DO。
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

DRY: 探测换票直接复用 cqu_ticket.fetch_service_ticket(同一条 ST-mint 路径, 复用
UA / 3-cookie / _proxy_url / looks_like_cas_login, 同样支持青果或 proxy=None 直连),
只是把它的 TicketError 语义重新归成探活三态(关键差异: NO_TICKET 在取票端是 502 瞬态,
在探活端归 unreachable 让 DO 退避)。
"""
import cqu_ticket
from cqu_ticket import TicketError

import cqu_ticket_browser

# 探测用的 service: 对齐 DO 的 DUMMY_SERVICE(runKeepAlive 凭它试换 ST 做探活)。
PROBE_SERVICE = "https://my.cqu.edu.cn/authserver/authentication/cas"

# verdict(cqu_ticket_browser.classify_browser_result)→ 探活三态。
#   ok       = 浏览器换到票 = 会话活        → alive
#   expired  = 落回 CAS 登录页(TGT 真失效) → expired(交 DO 重登)
#   no_ticket= 无票且非登录页(未知/瑞数误判) → unreachable(保守退避, 绝不误判过期)
_VERDICT_TO_STATUS = {"ok": "alive", "expired": "expired", "no_ticket": "unreachable"}


def probe_status_from_verdict(verdict: str) -> str:
    """把浏览器取票 verdict 归成探活三态。纯函数, 便于单测。

    未知 verdict 一律兜底 unreachable(保守退避, 绝不误判过期)。
    """
    return _VERDICT_TO_STATUS.get(verdict, "unreachable")


def classify_probe(ticket: str | None = None, error: Exception | None = None) -> str:
    """把一次探测的结果(换到 ticket / 抛出的异常)归成三态字符串。纯函数, 便于单测。

    返回:
      · "alive":       探测换到了 ST(会话服务端有效)。
      · "expired":     交 DO 重登的「确定性坏态」, 退避修不好, 只能重铸凭证。含两种:
                       - SESSION_EXPIRED: 落回 CAS 登录页, TGT 真失效(正向认出 cas-login)。
                       - MISSING_COOKIE:  3 个 cookie(SOURCEID_TGC/SESSION/rg_objectid)缺任一,
                         探测无从发起 —— 确定性坏态, 非瞬态。归 unreachable 会让 DO 永远退避、
                         留着坏 cookie 不重登, 用户卡死在反复 transient 失败; 故交 DO 重登铸
                         一套新的完整 cookie。
      · "unreachable": 其余一切 —— NO_TICKET(瑞数误判/未知页)、网络层/超时、未知异常。
                       对齐 DO isTransientSsoError 的 transient 语义: 不证明凭证坏, 让 DO
                       退避快重试而非误触重登。

    判定区分「确定性坏态(SESSION_EXPIRED/MISSING_COOKIE → expired, 重登铸新凭证)」与
    「瞬态/不确定(其余 → unreachable, 退避重试)」—— 后者保守不重登, 因「误判重登」的代价
    (触瑞数风控 + 烧容器)远高于「多退避一轮」; 但确定性坏态退避永远修不好, 必须重登。
    """
    if error is None and ticket:
        return "alive"
    # 确定性坏态 → expired(交 DO 重登): SESSION_EXPIRED(正向认出 CAS 登录页, TGT 真失效)、
    # MISSING_COOKIE(cookie 残缺, 探测无从发起, 退避修不好)。其余 TicketError code(NO_TICKET 等)
    # 与任何非 TicketError 异常(网络层/超时/未知)一律保守归 unreachable(瞬态, 让 DO 退避)。
    if isinstance(error, TicketError) and error.code in ("SESSION_EXPIRED", "MISSING_COOKIE"):
        return "expired"
    return "unreachable"


async def probe_session(cookies: dict, proxy: dict | None) -> dict:
    """凭 3 个 cookie 去 CQU CAS 做一次探测换票, 返回结构化三态结果。

    proxy 透传给 fetch_service_ticket(已支持 None): 青果 dict → 经青果; None → 节点直连(灰度省钱)。

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


async def probe_session_browser(state: dict) -> dict:
    """临时浏览器水化完整 storage_state → navigate 探活 → 导出刷新后的 state 回吐。

    瑞数动态 JS 挡无浏览器 httpx(浏览器能过), 故探活改浏览器水化(对齐 /service-ticket 取票路径)。
    水化 DO 给的完整 storage_state 起临时无头浏览器, navigate CAS /login?service=<PROBE_SERVICE>,
    凭是否换到票 / 是否落 CAS 登录页判三态; 同时导出刷新后的 storage_state(瑞数 cookie 会轮换,
    DO 据此保鲜), 探不通时回吐原 state。

    返回 {"status": "alive"|"expired"|"unreachable", "state": <刷新后或原>, "detail": "..."}。
    探不通(浏览器起不来 / 导航全异常 / 超时 / 未知)→ unreachable + 原 state(绝不误判过期)。
    复用 cqu_ticket_browser._hydrate_navigate(与 /service-ticket 取票同一条浏览器路径:尽力拦
    落向目标服务 host 的回调以避免核销单次 ST(非安全闸)、整体超时兜底、共用 TICKET_SEMAPHORE 限总并发)。
    detail 只含 verdict / 异常**类型名**, 绝不拼 str(e) —— patchright.new_context(storage_state=非法)
    的异常 message 可能把出错的 cookie/value 条目内容拼进去, 而本返回的 detail 经节点 200 回传、
    DO console.warn 落 CF observability, 故只放类型名以杜绝 state/cookie 明文进日志
    (对齐 CLAUDE.md「ticket/cookies/state 明文绝不进日志」)。
    """
    try:
        ticket, body, refreshed = await cqu_ticket_browser._hydrate_navigate(
            PROBE_SERVICE, state, capture_state=True)
    except Exception as e:  # noqa: BLE001 - 探不通(含整体超时)一律 unreachable, 绝不误判过期
        # detail 只放异常类型名(白名单化): str(e) 可能回显非法 state/cookie 条目 → 泄露明文。
        return {"status": "unreachable", "state": state, "detail": type(e).__name__}
    verdict, _ = cqu_ticket_browser.classify_browser_result(ticket, body)
    return {"status": probe_status_from_verdict(verdict),
            "state": refreshed if isinstance(refreshed, dict) else state,
            "detail": verdict}
