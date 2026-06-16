#!/usr/bin/env python3
"""cqu_ticket 纯函数单测 —— ST 提取 / cookie 组装 / URL 组装 / 登录页判别 / 代理 URL。
全部不触网。

运行:
    python3 -m pytest container/test_cqu_ticket.py -v
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import httpx  # noqa: E402
import pytest  # noqa: E402

import cqu_ticket  # noqa: E402
from cqu_ticket import (  # noqa: E402
    TicketError,
    build_service_login_url,
    fetch_service_ticket_retrying,
    looks_like_cas_login,
    select_cookies,
)

_FULL_COOKIES = {
    "SOURCEID_TGC": "tgc-val",
    "SESSION": "sess-val",
    "rg_objectid": "rg-val",
}


# ── build_service_login_url ────────────────────────────────────────────────
def test_build_url_encodes_service():
    url = build_service_login_url("https://my.cqu.edu.cn/authserver/authentication/cas")
    assert url.startswith("https://sso.cqu.edu.cn/login?service=")
    # serviceUrl 必须整体 urlencode(对齐 cqu-sso.ts encodeURIComponent): ':' '/' 都被转义。
    assert "%3A%2F%2Fmy.cqu.edu.cn" in url
    assert "://my.cqu.edu.cn" not in url.split("service=", 1)[1]


def test_build_url_encodes_query_and_special_chars():
    url = build_service_login_url("https://x.cqu.edu.cn/cb?a=1&b=2")
    tail = url.split("service=", 1)[1]
    # query 里的 & = 也要被编码, 不能泄进取票 URL 自身的 query。
    assert "&" not in tail
    assert "%26" in tail and "%3D" in tail


# ── select_cookies ─────────────────────────────────────────────────────────
def test_select_cookies_keeps_only_wanted_three():
    noisy = {**_FULL_COOKIES, "extra": "drop-me", "JSESSIONID": "drop-too"}
    out = select_cookies(noisy)
    assert out == _FULL_COOKIES
    assert "extra" not in out and "JSESSIONID" not in out


@pytest.mark.parametrize("drop", ["SOURCEID_TGC", "SESSION", "rg_objectid"])
def test_select_cookies_missing_one_raises(drop):
    partial = {k: v for k, v in _FULL_COOKIES.items() if k != drop}
    with pytest.raises(TicketError) as ei:
        select_cookies(partial)
    assert ei.value.code == "MISSING_COOKIE"
    assert drop in str(ei.value)


def test_select_cookies_empty_value_counts_as_missing():
    with pytest.raises(TicketError) as ei:
        select_cookies({**_FULL_COOKIES, "SESSION": ""})
    assert ei.value.code == "MISSING_COOKIE"
    assert "SESSION" in str(ei.value)


def test_select_cookies_none_raises():
    with pytest.raises(TicketError) as ei:
        select_cookies(None)
    assert ei.value.code == "MISSING_COOKIE"


# ── ST 提取(复用 cqu_login.extract_ticket; 经 collect_response_urls 喂入) ──────
def test_extract_ticket_from_location_url():
    # ST 通常出现在某一跳的 Location: <service>?ticket=ST-...
    urls = [
        "https://sso.cqu.edu.cn/login?service=https%3A%2F%2Fx.cqu.edu.cn",
        "https://x.cqu.edu.cn/cb?ticket=ST-12345-abcDEF.gh-ij",
    ]
    assert cqu_ticket.extract_ticket(urls) == "ST-12345-abcDEF.gh-ij"


def test_extract_ticket_none_when_absent():
    urls = [
        "https://sso.cqu.edu.cn/login?service=https%3A%2F%2Fx.cqu.edu.cn",
        "https://sso.cqu.edu.cn/login",  # 落回登录页, 无 ticket
    ]
    assert cqu_ticket.extract_ticket(urls) == ""


# ── looks_like_cas_login ───────────────────────────────────────────────────
def test_looks_like_cas_login_positive_markers():
    assert looks_like_cas_login('<input id="login-croypto" value="xx">') is True
    assert looks_like_cas_login('<div id="login-page-flowkey">key</div>') is True


def test_looks_like_cas_login_negative():
    assert looks_like_cas_login("<html><body>some unrelated page</body></html>") is False
    assert looks_like_cas_login("") is False
    assert looks_like_cas_login(None) is False


# ── _proxy_url(青果 dict → httpx 带账密 proxy URL) ─────────────────────────
def test_proxy_url_injects_credentials():
    proxy = {"server": "http://1.2.3.4:20000", "username": "user1", "password": "pass1"}
    assert cqu_ticket._proxy_url(proxy) == "http://user1:pass1@1.2.3.4:20000"


def test_proxy_url_url_encodes_credentials():
    # 账密含 @ : 等特殊字符时必须编码, 否则破坏 netloc 解析。
    proxy = {"server": "http://1.2.3.4:20000", "username": "u@x", "password": "p:w/d"}
    out = cqu_ticket._proxy_url(proxy)
    assert out == "http://u%40x:p%3Aw%2Fd@1.2.3.4:20000"


# ── fetch_service_ticket_retrying(同青果 IP 瞬态退避重试) ────────────────────
# 对齐 cqu-sso.ts getServiceTicket 的重试语义: 只重试网络错误 + 瑞数误判(NO_TICKET),
# 真过期(SESSION_EXPIRED)与契约错(MISSING_COOKIE)不重试; 同一 proxy 全程复用不重抽青果。
#
# 测试策略: monkeypatch cqu_ticket.fetch_service_ticket 为脚本化的假实现(一串返回/抛出),
# monkeypatch asyncio.sleep 为 no-op 跳过真延时, asyncio.run(...) 驱动协程。

_PROXY = {"server": "http://1.2.3.4:20000", "username": "u", "password": "p"}


class _ScriptedFetch:
    """脚本化的假 fetch_service_ticket: 按 steps 顺序逐次「返回值」或「抛异常」。

    steps 每项: callable 抛异常类实例则 raise, 否则当返回值(ST 字符串)。
    记录调用次数(calls)与每次入参, 供断言「重试复用同一 proxy / 调用次数」。
    """

    def __init__(self, steps):
        self._steps = list(steps)
        self.calls = 0
        self.seen_proxies = []

    async def __call__(self, service_url, cookies, proxy):
        self.calls += 1
        self.seen_proxies.append(proxy)
        # 末次之后仍被调用 → 复用最后一步(用于「始终失败」耗尽场景)。
        step = self._steps[min(self.calls - 1, len(self._steps) - 1)]
        if isinstance(step, BaseException):
            raise step
        return step


def _patch(monkeypatch, steps):
    fake = _ScriptedFetch(steps)
    monkeypatch.setattr(cqu_ticket, "fetch_service_ticket", fake)

    async def _no_sleep(_s):
        return None

    monkeypatch.setattr(cqu_ticket.asyncio, "sleep", _no_sleep)
    return fake


def test_retrying_succeeds_on_second_attempt(monkeypatch):
    # 首次 NO_TICKET(瞬态/瑞数误判), 第二次拿到 ST → 返回 ST, 共调 2 次。
    fake = _patch(monkeypatch, [TicketError("NO_TICKET", "transient"), "ST-ok"])
    out = asyncio.run(
        fetch_service_ticket_retrying("https://x.cqu.edu.cn/cb", _FULL_COOKIES, _PROXY)
    )
    assert out == "ST-ok"
    assert fake.calls == 2
    # 同青果 IP 全程复用: 两次入参 proxy 是同一对象, 未重抽。
    assert fake.seen_proxies == [_PROXY, _PROXY]


def test_retrying_does_not_retry_session_expired(monkeypatch):
    # 真过期立即上抛同款 TicketError, 不浪费重试(对齐 isRetryableSsoError 不重试过期)。
    fake = _patch(monkeypatch, [TicketError("SESSION_EXPIRED", "fell back to login")])
    with pytest.raises(TicketError) as ei:
        asyncio.run(
            fetch_service_ticket_retrying("https://x.cqu.edu.cn/cb", _FULL_COOKIES, _PROXY)
        )
    assert ei.value.code == "SESSION_EXPIRED"
    assert fake.calls == 1


def test_retrying_does_not_retry_contract_error(monkeypatch):
    # 契约错(缺 cookie)立即上抛, 重试无意义。
    fake = _patch(monkeypatch, [TicketError("MISSING_COOKIE", "missing SESSION")])
    with pytest.raises(TicketError) as ei:
        asyncio.run(
            fetch_service_ticket_retrying("https://x.cqu.edu.cn/cb", _FULL_COOKIES, _PROXY)
        )
    assert ei.value.code == "MISSING_COOKIE"
    assert fake.calls == 1


def test_retrying_exhausts_and_raises_last(monkeypatch):
    # 始终 NO_TICKET → 调满 max_attempts(默认 3)后抛最后一个 TicketError(code 仍 NO_TICKET)。
    fake = _patch(monkeypatch, [TicketError("NO_TICKET", "always transient")])
    with pytest.raises(TicketError) as ei:
        asyncio.run(
            fetch_service_ticket_retrying("https://x.cqu.edu.cn/cb", _FULL_COOKIES, _PROXY)
        )
    assert ei.value.code == "NO_TICKET"
    assert fake.calls == cqu_ticket.ST_MAX_ATTEMPTS == 3


def test_retrying_retries_network_error(monkeypatch):
    # 网络瞬态(httpx.ConnectTimeout, HTTPError 子类)首次抛, 第二次拿到 ST → 返回 ST, 调 2 次。
    fake = _patch(monkeypatch, [httpx.ConnectTimeout("boom"), "ST-net"])
    out = asyncio.run(
        fetch_service_ticket_retrying("https://x.cqu.edu.cn/cb", _FULL_COOKIES, _PROXY)
    )
    assert out == "ST-net"
    assert fake.calls == 2


def test_retrying_honours_custom_max_attempts(monkeypatch):
    # 自定义小 max_attempts 形参便于快测: 始终失败时调用次数 == max_attempts。
    fake = _patch(monkeypatch, [TicketError("NO_TICKET", "always")])
    with pytest.raises(TicketError):
        asyncio.run(
            fetch_service_ticket_retrying(
                "https://x.cqu.edu.cn/cb",
                _FULL_COOKIES,
                _PROXY,
                max_attempts=2,
                base_backoff_s=0.0,
            )
        )
    assert fake.calls == 2
