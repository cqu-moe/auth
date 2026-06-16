#!/usr/bin/env python3
"""qg_proxy 纯函数单测 —— 青果短效代理提取 URL 构造 + 响应解析。不打网络。

运行:
    python3 -m pytest container/test_qg_proxy.py -v
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pytest  # noqa: E402

from qg_proxy import (  # noqa: E402
    build_extract_url,
    parse_extract_response,
    QgExtractError,
    should_use_proxy,
)


def test_build_extract_url_has_required_params():
    url = build_extract_url(base="https://share.proxy.qg.net/get", key="K", area="500100")
    assert "key=K" in url and "area=500100" in url
    assert "format=json" in url and "num=1" in url and "isp=0" in url and "distinct=true" in url


def test_parse_extract_response_ok():
    body = {"code": "SUCCESS", "data": [{"server": "1.2.3.4:20000",
            "proxy_ip": "183.226.0.1", "area": "重庆市市辖区", "isp": "移动",
            "deadline": "2026-06-16 13:00:00"}]}
    assert parse_extract_response(body) == "1.2.3.4:20000"


def test_parse_extract_response_empty_raises():
    with pytest.raises(QgExtractError):
        parse_extract_response({"code": "SUCCESS", "data": []})


def test_parse_extract_response_error_code_raises():
    with pytest.raises(QgExtractError):
        parse_extract_response({"code": "NO_BALANCE", "data": []})


def test_parse_extract_response_malformed_item_raises():
    # data[0] 非 dict(畸形响应)也应抛 QgExtractError, 而非 AttributeError
    with pytest.raises(QgExtractError):
        parse_extract_response({"code": "SUCCESS", "data": ["not-a-dict"]})


def test_acquire_qg_proxy_network_error_raises(monkeypatch):
    # 网络错误/超时也算"拿不到 IP" → 必须收口成 QgExtractError(让上游 502 退避)
    # 注: acquire 不再依赖 QG_ENABLED(改由 should_use_proxy 门控), 默认 profile=short。
    import asyncio
    import httpx as _httpx

    from qg_proxy import acquire_qg_proxy

    monkeypatch.setenv("QG_AUTH_KEY", "K")
    monkeypatch.setenv("QG_AUTH_PWD", "P")

    class _FakeClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url):
            raise _httpx.ConnectTimeout("boom")

    monkeypatch.setattr(_httpx, "AsyncClient", _FakeClient)
    with pytest.raises(QgExtractError):
        asyncio.run(acquire_qg_proxy())


def test_acquire_qg_proxy_http_status_error_does_not_leak_key(monkeypatch):
    # 安全(P1): 青果 API 非 2xx → raise_for_status 抛 HTTPStatusError, 其 str(e) 形如
    # "Client error '403 Forbidden' for url 'https://.../get?key=<Authkey>&...'" 带完整 URL 含密钥。
    # 锁住: QgExtractError 消息绝不含 Authkey(只报状态码), 否则泄露进日志/上游 DO 响应。
    import asyncio
    import httpx as _httpx

    from qg_proxy import acquire_qg_proxy

    monkeypatch.setenv("QG_AUTH_KEY", "SECRETKEY123")
    monkeypatch.setenv("QG_AUTH_PWD", "P")

    class _FakeResp:
        def raise_for_status(self):
            req = _httpx.Request(
                "GET", "https://share.proxy.qg.net/get?key=SECRETKEY123&num=1")
            resp = _httpx.Response(403, request=req)
            raise _httpx.HTTPStatusError(
                "Client error '403 Forbidden' for url "
                "'https://share.proxy.qg.net/get?key=SECRETKEY123&num=1'",
                request=req, response=resp)

        def json(self):  # 不应到达(raise_for_status 先抛)
            return {}

    class _FakeClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url):
            return _FakeResp()

    monkeypatch.setattr(_httpx, "AsyncClient", _FakeClient)
    with pytest.raises(QgExtractError) as ei:
        asyncio.run(acquire_qg_proxy("short"))
    msg = str(ei.value)
    assert "SECRETKEY123" not in msg  # 密钥绝不出现在错误消息里
    assert "403" in msg               # 状态码仍报出来(可诊断)


def _install_fake_client(monkeypatch, server="1.2.3.4:20000"):
    """monkeypatch httpx.AsyncClient 返回固定 server, 记录收到的 url。返回 captured list。"""
    import httpx as _httpx

    captured = []

    class _FakeResp:
        def raise_for_status(self):
            return None

        def json(self):
            return {"code": "SUCCESS", "data": [{"server": server}]}

    class _FakeClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url):
            captured.append(url)
            return _FakeResp()

    monkeypatch.setattr(_httpx, "AsyncClient", _FakeClient)
    return captured


def test_acquire_qg_proxy_login_uses_login_key(monkeypatch):
    # profile="login" 应选 QG_AUTH_KEY_LOGIN/QG_AUTH_PWD_LOGIN, 不取 short 套餐的 K0/P0。
    import asyncio

    from qg_proxy import acquire_qg_proxy

    monkeypatch.setenv("QG_AUTH_KEY", "K0")
    monkeypatch.setenv("QG_AUTH_PWD", "P0")
    monkeypatch.setenv("QG_AUTH_KEY_LOGIN", "K1")
    monkeypatch.setenv("QG_AUTH_PWD_LOGIN", "P1")
    captured = _install_fake_client(monkeypatch)

    result = asyncio.run(acquire_qg_proxy("login"))
    assert result["username"] == "K1"
    assert result["password"] == "P1"
    assert result["server"] == "http://1.2.3.4:20000"
    # 提取 URL 必须用 login key(而非 short key K0)
    assert "key=K1" in captured[0]
    assert "key=K0" not in captured[0]


def test_acquire_qg_proxy_login_falls_back_to_short_key(monkeypatch):
    # 只设 short 套餐(未设 LOGIN) → profile="login" 回退到 QG_AUTH_KEY/QG_AUTH_PWD。
    import asyncio

    from qg_proxy import acquire_qg_proxy

    monkeypatch.setenv("QG_AUTH_KEY", "K0")
    monkeypatch.setenv("QG_AUTH_PWD", "P0")
    monkeypatch.delenv("QG_AUTH_KEY_LOGIN", raising=False)
    monkeypatch.delenv("QG_AUTH_PWD_LOGIN", raising=False)
    captured = _install_fake_client(monkeypatch)

    result = asyncio.run(acquire_qg_proxy("login"))
    assert result["username"] == "K0"
    assert result["password"] == "P0"
    assert "key=K0" in captured[0]


def test_acquire_qg_proxy_short_uses_base_key(monkeypatch):
    # 默认 profile="short" 用 QG_AUTH_KEY/QG_AUTH_PWD。
    import asyncio

    from qg_proxy import acquire_qg_proxy

    monkeypatch.setenv("QG_AUTH_KEY", "K0")
    monkeypatch.setenv("QG_AUTH_PWD", "P0")
    monkeypatch.setenv("QG_AUTH_KEY_LOGIN", "K1")
    monkeypatch.setenv("QG_AUTH_PWD_LOGIN", "P1")
    captured = _install_fake_client(monkeypatch)

    # 显式 "short" 与默认应一致
    result = asyncio.run(acquire_qg_proxy("short"))
    assert result["username"] == "K0"
    assert result["password"] == "P0"
    assert "key=K0" in captured[0]

    default_result = asyncio.run(acquire_qg_proxy())
    assert default_result["username"] == "K0"


def test_should_use_proxy_default_all_on(monkeypatch):
    monkeypatch.delenv("QG_ENABLED", raising=False)
    monkeypatch.delenv("QG_PROXY_LOGIN", raising=False)
    monkeypatch.delenv("QG_PROXY_SHORT", raising=False)
    assert should_use_proxy("login") is True
    assert should_use_proxy("short") is True


def test_should_use_proxy_master_switch_off(monkeypatch):
    monkeypatch.setenv("QG_ENABLED", "0")
    # 总闸关 → 两路都直连(忽略 per-route)
    monkeypatch.setenv("QG_PROXY_LOGIN", "1")
    monkeypatch.setenv("QG_PROXY_SHORT", "1")
    assert should_use_proxy("login") is False
    assert should_use_proxy("short") is False


def test_should_use_proxy_login_off_short_on(monkeypatch):
    monkeypatch.delenv("QG_ENABLED", raising=False)
    monkeypatch.setenv("QG_PROXY_LOGIN", "0")
    monkeypatch.delenv("QG_PROXY_SHORT", raising=False)
    assert should_use_proxy("login") is False
    assert should_use_proxy("short") is True


def test_should_use_proxy_short_off_login_on(monkeypatch):
    monkeypatch.delenv("QG_ENABLED", raising=False)
    monkeypatch.delenv("QG_PROXY_LOGIN", raising=False)
    monkeypatch.setenv("QG_PROXY_SHORT", "0")
    assert should_use_proxy("short") is False
    assert should_use_proxy("login") is True


def test_should_use_proxy_unknown_profile_raises(monkeypatch):
    # 闭集守卫: 未知 profile → ValueError(不静默拼一个不存在的 QG_PROXY_BOGUS env)。
    monkeypatch.delenv("QG_ENABLED", raising=False)
    with pytest.raises(ValueError):
        should_use_proxy("bogus")


def test_acquire_qg_proxy_unknown_profile_raises(monkeypatch):
    # 闭集守卫: 未知 profile → ValueError(不静默当 short 处理)。在触网前就拒。
    import asyncio

    from qg_proxy import acquire_qg_proxy

    monkeypatch.setenv("QG_AUTH_KEY", "K0")
    monkeypatch.setenv("QG_AUTH_PWD", "P0")
    with pytest.raises(ValueError):
        asyncio.run(acquire_qg_proxy("bogus"))


def test_acquire_qg_proxy_login_empty_key_falls_back_to_short(monkeypatch):
    # QG_AUTH_KEY_LOGIN="" (空串) 也算未配 → profile="login" 回退到 QG_AUTH_KEY。
    # 锁住 `or` 对空串的回退(空环境变量不应顶替成空 username)。
    import asyncio

    from qg_proxy import acquire_qg_proxy

    monkeypatch.setenv("QG_AUTH_KEY", "K0")
    monkeypatch.setenv("QG_AUTH_PWD", "P0")
    monkeypatch.setenv("QG_AUTH_KEY_LOGIN", "")
    monkeypatch.setenv("QG_AUTH_PWD_LOGIN", "")
    captured = _install_fake_client(monkeypatch)

    result = asyncio.run(acquire_qg_proxy("login"))
    assert result["username"] == "K0"
    assert result["password"] == "P0"
    assert "key=K0" in captured[0]
