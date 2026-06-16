#!/usr/bin/env python3
"""cqu_ticket 纯函数单测 —— ST 提取 / cookie 组装 / URL 组装 / 登录页判别 / 代理 URL。
全部不触网。

运行:
    python3 -m pytest container/test_cqu_ticket.py -v
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pytest  # noqa: E402

import cqu_ticket  # noqa: E402
from cqu_ticket import (  # noqa: E402
    TicketError,
    build_service_login_url,
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
