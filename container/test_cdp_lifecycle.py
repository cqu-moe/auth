import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

import cqu_login_cdp as m
import chromium_session as runtime


@pytest.fixture
def browser(monkeypatch, tmp_path):
    class Cdp:
        def __init__(self, _ws):
            self.handlers = {}
            self.calls = []
            self.close = AsyncMock()
            self.navigation_error = None
            self.navigation_ticket = True

        def on(self, method, handler):
            self.handlers[method] = handler

        async def call(self, method, params=None, **kwargs):
            self.calls.append((method, params))
            if method == "Browser.getVersion":
                return {"product": "Chrome/146.0.0.0"}
            if method == "Page.navigate":
                if self.navigation_ticket:
                    self.handlers["Network.requestWillBeSent"]({
                        "request": {"url": "https://my.cqu.edu.cn/cas?ticket=ST-synthetic"},
                    })
                if self.navigation_error:
                    return {"errorText": self.navigation_error}
            if method == "Network.getAllCookies":
                return {"cookies": [{"name": "SOURCEID_TGC", "value": "synthetic",
                                     "domain": "sso.cqu.edu.cn", "path": "/"}]}
            return {}

        async def evaluate(self, expression, **kwargs):
            if expression == "location.origin":
                return "https://my.cqu.edu.cn"
            return {"croypto": "", "execution": ""}

    cdp = Cdp(None)
    process = SimpleNamespace(pid=987654321, returncode=None, terminate=Mock(), kill=Mock(), wait=AsyncMock())
    process.launch = AsyncMock(return_value=process)
    monkeypatch.setattr(runtime.os, "killpg", lambda _group, sig: process.terminate() if sig == 15 else process.kill())
    http = SimpleNamespace(ws_connect=AsyncMock(), close=AsyncMock())
    monkeypatch.setenv("CQU_CDP_RUNTIME_DIR", str(tmp_path))
    monkeypatch.setattr(runtime, "find_chromium_executable", lambda: "/synthetic/chrome")
    monkeypatch.setattr(runtime, "_free_loopback_port", lambda: 43123)
    monkeypatch.setattr(runtime.asyncio, "create_subprocess_exec", process.launch)
    monkeypatch.setattr(runtime.aiohttp, "ClientSession", lambda: http)
    monkeypatch.setattr(runtime, "_wait_devtools_http", AsyncMock())
    monkeypatch.setattr(runtime, "_first_page_websocket", AsyncMock(return_value="ws://synthetic"))
    monkeypatch.setattr(runtime, "CdpSession", lambda _: cdp)
    monkeypatch.setattr(m.browser_profile, "LOGIN_COOKIE_WAIT_MS", 1)
    monkeypatch.setattr(m.browser_profile, "LOGIN_FORM_WAIT_MS", 1)
    monkeypatch.setattr(m.browser_profile, "LOGIN_READY_POLL_MS", 1)
    return cdp, process, http, tmp_path


@pytest.mark.asyncio
@pytest.mark.parametrize("callback_aborted", [False, True])
async def test_initial_navigation_ticket_reuses_session_without_password_or_code(browser, callback_aborted):
    cdp, _, _, _ = browser
    cdp.navigation_error = "net::ERR_ABORTED" if callback_aborted else None
    provider = AsyncMock(side_effect=AssertionError("must not request a code"))
    result = await m.run_login("synthetic", "synthetic", "https://my.cqu.edu.cn/cas",
                               code_provider=provider)
    assert result["ticket"] == "ST-synthetic"
    assert result["state"]["cookies"][0]["name"] == "SOURCEID_TGC"
    assert not any(method == "Runtime.evaluate" for method, _ in cdp.calls)
    provider.assert_not_called()


@pytest.mark.asyncio
async def test_initial_navigation_failure_without_ticket_keeps_net_error(browser):
    cdp, _, _, _ = browser
    cdp.navigation_error = "net::ERR_NAME_NOT_RESOLVED"
    cdp.navigation_ticket = False
    with pytest.raises(RuntimeError, match=r"^Browser navigation failed: net::ERR_NAME_NOT_RESOLVED$"):
        await m.run_login("synthetic", "synthetic", "https://my.cqu.edu.cn/cas",
                          code_provider=AsyncMock())


@pytest.mark.asyncio
async def test_chromium_launch_owns_an_independent_process_session(browser):
    _, process, _, _ = browser
    await m.run_login("synthetic", "synthetic", "https://my.cqu.edu.cn/cas", code_provider=AsyncMock())
    assert process.launch.call_args.kwargs.get("start_new_session") is True


@pytest.mark.asyncio
@pytest.mark.parametrize("failing_close", ["cdp", "http"])
async def test_close_failure_still_reaps_process_and_removes_profile(browser, failing_close):
    cdp, process, http, root = browser
    getattr(cdp if failing_close == "cdp" else http, "close").side_effect = RuntimeError("close failed")
    result = await m.run_login("synthetic", "synthetic", "https://my.cqu.edu.cn/cas",
                               code_provider=AsyncMock())
    assert result["ticket"] == "ST-synthetic"
    assert process.terminate.called
    assert http.close.called
    assert list(root.iterdir()) == []


@pytest.mark.asyncio
async def test_seed_restores_partitioned_cookies_and_excludes_non_school_origins():
    calls = []

    async def call(method, params=None, **kwargs):
        calls.append((method, params))
        return {}

    state = {
        "cookies": [{"name": "SESSION", "value": "synthetic", "domain": "sso.cqu.edu.cn",
                     "path": "/", "partitionKey": {"topLevelSite": "https://cqu.edu.cn",
                                                     "hasCrossSiteAncestor": False}}],
        "origins": [
            {"origin": "https://sso.cqu.edu.cn", "localStorage": [{"name": "trusted", "value": "synthetic"}]},
            {"origin": "https://attacker.example", "localStorage": [{"name": "untrusted", "value": "exclude"}]},
        ],
    }
    await runtime.restore_seed_cookies(SimpleNamespace(call=call), state)
    cookie_call = next(params for method, params in calls if method == "Network.setCookies")
    assert cookie_call["cookies"][0]["partitionKey"] == {
        "topLevelSite": "https://cqu.edu.cn", "hasCrossSiteAncestor": False,
    }
    assert runtime.seed_origins(state) == {'https://sso.cqu.edu.cn': [['trusted', 'synthetic']]}


@pytest.mark.asyncio
async def test_click_waits_for_actionable_target_before_dispatch(monkeypatch):
    evaluations = iter([None, {"x": 20, "y": 30}])
    events = []
    async def evaluate(*args, **kwargs):
        return next(evaluations)
    async def call(method, params=None, **kwargs):
        events.append((method, params))
    monkeypatch.setattr(m, "interaction_jitter", AsyncMock())
    browser = runtime.ChromiumSession()
    browser.evaluate = evaluate
    browser.cdp = SimpleNamespace(call=call)
    await m._click_send_code(browser)
    assert [params["type"] for _, params in events] == ["mouseMoved", "mousePressed", "mouseReleased"]
    assert all(params["x"] == 20 and params["y"] == 30 for _, params in events)
