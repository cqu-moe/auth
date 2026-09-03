import asyncio

import pytest

import cqu_atrust


def test_url_classification_uses_exact_atrust_hosts():
    assert cqu_atrust.is_rewritten_sso_url(
        "https://sso-cqu-edu-cn-s.atrust.cqu.edu.cn/login?service=x"
    ) is True
    assert cqu_atrust.is_rewritten_sso_url(
        "https://sso-cqu-edu-cn-s.atrust.cqu.edu.cn.evil.example/login"
    ) is False


def test_first_factor_failure_classification_only_marks_explicit_password_rejection():
    assert cqu_atrust.classify_first_factor_failure(
        "fail:用户名或密码错误"
    ) == "password_rejected"
    assert cqu_atrust.classify_first_factor_failure(
        "fail:登录页未渲染(疑似被瑞数挑战/限流)"
    ) == "transient"
    assert cqu_atrust.is_atrust_login_done(
        "https://my-cqu-edu-cn-s.atrust.cqu.edu.cn/workspace/curriculum"
    ) is True
    assert cqu_atrust.is_atrust_login_done(
        "https://atrust.cqu.edu.cn/portal/?#!/login"
    ) is False


class _Candidate:
    def __init__(self, text, clicks):
        self.text = text
        self.clicks = clicks

    async def inner_text(self):
        return self.text

    async def click(self, **_kwargs):
        self.clicks.append(self.text)


class _Candidates:
    def __init__(self, candidates):
        self.candidates = candidates

    async def count(self):
        return len(self.candidates)

    def nth(self, index):
        return self.candidates[index]


class _ExactText:
    async def count(self):
        return 0


class _PortalPage:
    def __init__(self):
        self.url = "about:blank"
        self.clicks = []

    async def goto(self, url, **_kwargs):
        self.url = "https://atrust.cqu.edu.cn/portal/?#!/login"
        self.goto_url = url

    def locator(self, selector):
        assert selector == "li.server-container .server-name"
        return _Candidates([
            _Candidate("本地认证", self.clicks),
            _Candidate("统一身份认证", self.clicks),
        ])

    def get_by_text(self, *_args, **_kwargs):
        return _ExactText()

    async def wait_for_timeout(self, _timeout):
        return None


def test_click_unified_identity_uses_fixed_entry_and_exact_visible_text():
    page = _PortalPage()
    asyncio.run(cqu_atrust.click_unified_identity(page))
    assert page.goto_url == cqu_atrust.ATRUST_APP_URL
    assert page.clicks == ["统一身份认证"]


class _FlowPage:
    def __init__(self):
        self.url = "about:blank"

    def set_default_timeout(self, _timeout):
        return None

    async def wait_for_timeout(self, _timeout):
        return None


class _FlowContext:
    def __init__(self):
        self.page = _FlowPage()

    async def new_page(self):
        return self.page

    async def storage_state(self):
        return {"cookies": [{"name": "sid", "value": "opaque"}], "origins": []}


class _FlowBrowser:
    def __init__(self):
        self.context = _FlowContext()
        self.closed = False

    async def new_context(self, **_kwargs):
        return self.context

    async def close(self):
        self.closed = True


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


def test_run_atrust_login_waits_for_permit_and_returns_state_only(monkeypatch):
    events = []
    cm = _FlowAsyncPlaywrightCM()
    page = cm.playwright.chromium.browser.context.page
    monkeypatch.setattr(cqu_atrust, "async_playwright", lambda: cm)
    monkeypatch.setattr(cqu_atrust.cqu_login, "install_send_code_sniffer", lambda *_: None)

    async def click(target):
        events.append("portal")
        target.url = "https://sso-cqu-edu-cn-s.atrust.cqu.edu.cn/login?service=x"

    async def wait_sso(_target):
        events.append("sso")

    async def first_factor(*_args, **_kwargs):
        return "2fa"

    async def switch(*_args):
        events.append("switch")

    async def permit():
        events.append("permit")

    async def request(*_args):
        events.append("request")
        return True

    async def code():
        events.append("code")
        return "123456"

    async def submit(target, *_args):
        events.append("submit")
        target.url = "https://my-cqu-edu-cn-s.atrust.cqu.edu.cn/workspace/curriculum"

    async def wait_app(_target):
        events.append("app")

    monkeypatch.setattr(cqu_atrust, "click_unified_identity", click)
    monkeypatch.setattr(cqu_atrust, "wait_for_rewritten_sso", wait_sso)
    monkeypatch.setattr(cqu_atrust, "wait_for_atrust_app", wait_app)
    monkeypatch.setattr(cqu_atrust.cqu_login, "do_first_factor", first_factor)
    monkeypatch.setattr(cqu_atrust.cqu_login, "switch_2fa_tab", switch)
    monkeypatch.setattr(cqu_atrust.cqu_login, "request_code", request)
    monkeypatch.setattr(cqu_atrust.cqu_login, "classify_send_code", lambda *_: "sent")
    monkeypatch.setattr(cqu_atrust.cqu_login, "submit_code", submit)

    result = asyncio.run(cqu_atrust.run_atrust_login(
        "20201234",
        "pw",
        method="mail",
        code_provider=code,
        permit_provider=permit,
    ))

    assert result == {
        "state": {"cookies": [{"name": "sid", "value": "opaque"}], "origins": []}
    }
    assert "ticket" not in result
    assert events == [
        "portal", "sso", "switch", "permit", "request", "code", "submit", "app"
    ]
    assert cm.playwright.chromium.browser.closed is True


def test_run_atrust_login_requires_both_providers():
    with pytest.raises(ValueError, match="code_provider"):
        asyncio.run(cqu_atrust.run_atrust_login("u", "p", permit_provider=lambda: None))
    with pytest.raises(ValueError, match="permit_provider"):
        asyncio.run(cqu_atrust.run_atrust_login("u", "p", code_provider=lambda: None))
