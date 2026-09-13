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


class _FlowPage:
    def __init__(self):
        self.url = "https://sso.cqu.edu.cn/login"

    def set_default_timeout(self, _timeout):
        return None


class _FlowContext:
    def __init__(self):
        self.page = _FlowPage()

    async def new_page(self):
        return self.page

    async def storage_state(self):
        return {"cookies": [], "origins": []}


class _FlowBrowser:
    def __init__(self):
        self.context = _FlowContext()

    async def new_context(self, **_kwargs):
        return self.context

    async def close(self):
        return None


class _FlowChromium:
    def __init__(self):
        self.browser = _FlowBrowser()

    async def launch(self, **_kwargs):
        return self.browser


class _FlowPlaywright:
    def __init__(self):
        self.chromium = _FlowChromium()


class _FlowAsyncPlaywrightCM:
    def __init__(self):
        self.playwright = _FlowPlaywright()

    async def __aenter__(self):
        return self.playwright

    async def __aexit__(self, *exc):
        return False


@pytest.mark.parametrize(
    ("send_verdict", "expected_code_event"),
    [("sent", "fresh-code"), ("already_valid", "reusable-code")],
)
def test_run_login_waits_for_permit_and_selects_the_right_code_source(
    monkeypatch, send_verdict, expected_code_event
):
    """缺少 permit await 会让 CAS/QuickLogin 同时点击发码，竞争消费共享验证码。"""
    events = []
    cm = _FlowAsyncPlaywrightCM()
    monkeypatch.setattr(cqu_login, "async_playwright", lambda: cm)
    monkeypatch.setattr(cqu_login, "install_ticket_sniffer", lambda *_: None)
    monkeypatch.setattr(cqu_login, "install_send_code_sniffer", lambda *_: None)

    async def first_factor(*_args, **_kwargs):
        return "2fa"

    async def switch(*_args):
        events.append("switch")

    async def request(*_args):
        events.append("request")
        return True

    async def submit(page, *_args):
        events.append("submit")
        page.url = "https://my.cqu.edu.cn/workspace/cas?ticket=ST-test"

    async def permit_provider():
        events.append("permit")

    async def code_provider():
        events.append("fresh-code")
        return "123456"

    async def reusable_code_provider():
        events.append("reusable-code")
        return "123456"

    monkeypatch.setattr(cqu_login, "do_first_factor", first_factor)
    monkeypatch.setattr(cqu_login, "switch_2fa_tab", switch)
    monkeypatch.setattr(cqu_login, "request_code", request)
    monkeypatch.setattr(cqu_login, "classify_send_code", lambda *_: send_verdict)
    monkeypatch.setattr(cqu_login, "submit_code", submit)

    result = asyncio.run(
        cqu_login.run_login(
            "20201234",
            "pw",
            cqu_login.DEFAULT_SERVICE,
            method="mail",
            code_provider=code_provider,
            reusable_code_provider=reusable_code_provider,
            permit_provider=permit_provider,
        )
    )

    assert result["ticket"] == "ST-test"
    assert events == ["switch", "permit", "request", expected_code_event, "submit"]
