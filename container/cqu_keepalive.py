"""Probe CAS through the same CDP ticket path and return refreshed browser state."""

import cqu_ticket_browser

PROBE_SERVICE = "https://my.cqu.edu.cn/authserver/authentication/cas"
_VERDICT_TO_STATUS = {"ok": "alive", "expired": "expired", "no_ticket": "unreachable"}

def probe_status_from_verdict(verdict: str) -> str:
    """把浏览器取票 verdict 归成探活三态。纯函数, 便于单测。

    未知 verdict 一律兜底 unreachable(保守退避, 绝不误判过期)。
    """
    return _VERDICT_TO_STATUS.get(verdict, "unreachable")


async def probe_session_browser(state: dict) -> dict:
    """Return alive/expired/unreachable without exposing raw browser errors."""
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
