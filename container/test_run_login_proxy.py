#!/usr/bin/env python3
"""run_login proxy 透传单测 —— 断言 proxy 参数原样传给 patchright chromium.launch。不打网络。

patchright launch 是集成行为(起真实浏览器), 难纯函数单测; 这里用 monkeypatch 把整个
async_playwright 栈换成轻量 fake, 只验证「run_login 把 proxy 透传给 launch」这一条契约:
  · proxy=None(默认)   → launch 收到 proxy=None(等价不设代理, 保持旧行为)
  · proxy={...}(青果)  → launch 原样收到该 dict
fake 在 do_first_factor 之前抛出, 流程不进入登录逻辑, 不触网。

运行:
    python3 -m pytest container/test_run_login_proxy.py -v
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pytest  # noqa: E402

import cqu_login  # noqa: E402


class _StopBeforeLogin(Exception):
    """fake 浏览器哨兵: 拿到 launch 入参后立即中止, 不进入真实登录流程。"""


class _FakeChromium:
    def __init__(self, captured):
        self._captured = captured

    async def launch(self, **kwargs):
        self._captured.update(kwargs)
        # 已捕获 launch 入参, 无需起真实浏览器/触网 —— 立即中止流程。
        raise _StopBeforeLogin


class _FakePlaywright:
    def __init__(self, captured):
        self.chromium = _FakeChromium(captured)


class _FakeAsyncPlaywrightCM:
    def __init__(self, captured):
        self._captured = captured

    async def __aenter__(self):
        return _FakePlaywright(self._captured)

    async def __aexit__(self, *exc):
        return False


def _run_login_capture_launch_kwargs(monkeypatch, proxy):
    captured = {}
    monkeypatch.setattr(
        cqu_login, "async_playwright", lambda: _FakeAsyncPlaywrightCM(captured)
    )

    async def _code_provider():
        return "000000"

    with pytest.raises(_StopBeforeLogin):
        asyncio.run(
            cqu_login.run_login(
                "20201234", "pw", cqu_login.DEFAULT_SERVICE,
                method="mail", code_provider=_code_provider, proxy=proxy,
            )
        )
    return captured


def test_proxy_none_passed_through_as_no_proxy(monkeypatch):
    # 默认 proxy=None 必须原样透传 launch(playwright 语义 = 不设代理), 保持旧行为。
    captured = _run_login_capture_launch_kwargs(monkeypatch, proxy=None)
    assert "proxy" in captured
    assert captured["proxy"] is None


def test_proxy_dict_passed_through(monkeypatch):
    # 青果代理 dict 必须原样透传给 launch。
    proxy = {"server": "http://1.2.3.4:20000", "username": "u", "password": "p"}
    captured = _run_login_capture_launch_kwargs(monkeypatch, proxy=proxy)
    assert captured["proxy"] is proxy
