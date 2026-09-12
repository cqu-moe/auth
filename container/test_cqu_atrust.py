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
    assert cqu_atrust.is_supported_sso_url(
        "https://sso.cqu.edu.cn/login?service=x"
    ) is True
    assert cqu_atrust.is_supported_sso_url(
        "https://sso.cqu.edu.cn.evil.example/login"
    ) is False


def test_first_factor_failure_classification_only_marks_explicit_password_rejection():
    assert cqu_atrust.classify_first_factor_failure(
        "credential_rejected:用户名或密码错误"
    ) == "password_rejected"
    # 自由诊断文本不再作为凭据判据；只有 do_first_factor 的结构化前缀可熔断。
    assert cqu_atrust.classify_first_factor_failure(
        "fail:用户名或密码错误"
    ) == "transient"
    assert cqu_atrust.classify_first_factor_failure(
        "fail:登录页未渲染(疑似被瑞数挑战/限流)"
    ) == "transient"
    assert cqu_atrust.classify_first_factor_failure(
        "fail:回到登录页(密码错误/瑞数软重挑战)"
    ) == "transient"
    assert cqu_atrust.is_atrust_login_done(
        "https://my-cqu-edu-cn-s.atrust.cqu.edu.cn/workspace/curriculum"
    ) is True
    assert cqu_atrust.is_atrust_login_done(
        "https://atrust.cqu.edu.cn/portal/?#!/login"
    ) is False
    assert cqu_atrust.is_forced_client_page(
        "https://atrust.cqu.edu.cn/portal/?redirectid=opaque#/down_client_pc"
    ) is True
    assert cqu_atrust.is_forced_client_page(
        "https://atrust.cqu.edu.cn.evil.example/portal/#/down_client_pc"
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


class _AutoForwardPortalPage:
    def __init__(self, destination):
        self.url = "about:blank"
        self.destination = destination
        self.goto_url = None
        self.waits = 0

    async def goto(self, url, **_kwargs):
        self.url = (
            "https://atrust.cqu.edu.cn/portal/shortcut.html"
            "?dest=%23!%2Flogin&source=logout_cas"
        )
        self.goto_url = url

    def locator(self, selector):
        assert selector == "li.server-container .server-name"
        return _Candidates([])

    def get_by_text(self, *_args, **_kwargs):
        return _ExactText()

    async def wait_for_timeout(self, _timeout):
        self.waits += 1
        self.url = self.destination


def test_click_unified_identity_accepts_remembered_auto_forward_to_rewritten_sso():
    page = _AutoForwardPortalPage(
        "https://sso-cqu-edu-cn-s.atrust.cqu.edu.cn/login?service=x"
    )

    asyncio.run(cqu_atrust.click_unified_identity(page))

    assert page.goto_url == cqu_atrust.ATRUST_APP_URL
    assert page.waits == 1


def test_click_unified_identity_rejects_auto_forward_to_similar_host():
    page = _AutoForwardPortalPage(
        "https://sso-cqu-edu-cn-s.atrust.cqu.edu.cn.evil.example/login"
    )

    with pytest.raises(RuntimeError, match="ATRUST_PORTAL_FALLBACK_FAILED"):
        asyncio.run(cqu_atrust.click_unified_identity(page))


class _ForcedClientPortalPage:
    def __init__(self, fallback_destination):
        self.url = "about:blank"
        self.fallback_destination = fallback_destination
        self.goto_urls = []
        self.waits = 0

    async def goto(self, url, **_kwargs):
        self.goto_urls.append(url)
        self.url = (
            "https://atrust.cqu.edu.cn/portal/?redirectid=opaque#/down_client_pc"
            if url == cqu_atrust.ATRUST_APP_URL
            else self.fallback_destination
        )

    def locator(self, selector):
        assert selector == "li.server-container .server-name"
        return _Candidates([])

    def get_by_text(self, *_args, **_kwargs):
        return _ExactText()

    async def wait_for_timeout(self, _timeout):
        self.waits += 1


def test_click_unified_identity_bypasses_forced_client_page_via_fixed_cas_route():
    page = _ForcedClientPortalPage(
        "https://sso.cqu.edu.cn/login?service=x"
    )

    asyncio.run(cqu_atrust.click_unified_identity(page))

    assert page.goto_urls == [
        cqu_atrust.ATRUST_APP_URL,
        cqu_atrust.ATRUST_CAS_LOGIN_URL,
    ]
    assert page.waits == 0


def test_click_unified_identity_rejects_fallback_redirect_to_untrusted_host():
    page = _ForcedClientPortalPage("https://evil.example/login")

    with pytest.raises(RuntimeError, match="ATRUST_PORTAL_FALLBACK_FAILED"):
        asyncio.run(cqu_atrust.click_unified_identity(page))


class _ReadyResponse:
    url = (
        "https://my-cqu-edu-cn-s.atrust.cqu.edu.cn/"
        "api/timetable/class/timetable/student/my-table-detail"
    )
    status = 200

    def __init__(self, payload):
        self.payload = payload

    async def json(self):
        return self.payload


class _ReadyPage:
    def __init__(self, payload):
        self.url = cqu_atrust.ATRUST_APP_URL
        self.response = _ReadyResponse(payload)
        self.handler = None

    def on(self, event, handler):
        assert event == "response"
        self.handler = handler

    def remove_listener(self, event, handler):
        assert event == "response"
        assert handler is self.handler

    async def goto(self, url, **_kwargs):
        self.url = url
        self.handler(self.response)

    async def wait_for_timeout(self, _timeout):
        return None


def test_atrust_ready_gate_requires_the_real_timetable_success_shape():
    asyncio.run(
        cqu_atrust.verify_atrust_app_ready(
            _ReadyPage({"classTimetableVOList": []}), timeout_seconds=0.1
        )
    )
    with pytest.raises(RuntimeError, match="ATRUST_APP_NOT_READY"):
        asyncio.run(
            cqu_atrust.verify_atrust_app_ready(
                _ReadyPage({"status": "failed", "message": "expired"}),
                timeout_seconds=0.01,
            )
        )


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


def test_run_atrust_login_reuses_pending_code_when_backend_refuses_to_resend(monkeypatch):
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
        events.append("fresh-code")
        return "999999"

    async def reusable_code():
        events.append("reusable-code")
        return "123456"

    async def submit(target, *_args):
        events.append("submit")
        target.url = "https://my-cqu-edu-cn-s.atrust.cqu.edu.cn/workspace/curriculum"

    async def wait_app(_target):
        events.append("app")

    async def verify_app(_target):
        events.append("ready")

    monkeypatch.setattr(cqu_atrust, "click_unified_identity", click)
    monkeypatch.setattr(cqu_atrust, "wait_for_rewritten_sso", wait_sso)
    monkeypatch.setattr(cqu_atrust, "wait_for_atrust_app", wait_app)
    monkeypatch.setattr(cqu_atrust, "verify_atrust_app_ready", verify_app)
    monkeypatch.setattr(cqu_atrust.cqu_login, "do_first_factor", first_factor)
    monkeypatch.setattr(cqu_atrust.cqu_login, "switch_2fa_tab", switch)
    monkeypatch.setattr(cqu_atrust.cqu_login, "request_code", request)
    monkeypatch.setattr(
        cqu_atrust.cqu_login, "classify_send_code", lambda *_: "already_valid"
    )
    monkeypatch.setattr(cqu_atrust.cqu_login, "submit_code", submit)

    result = asyncio.run(cqu_atrust.run_atrust_login(
        "20201234",
        "pw",
        method="mail",
        code_provider=code,
        reusable_code_provider=reusable_code,
        permit_provider=permit,
    ))

    assert result == {
        "state": {"cookies": [{"name": "sid", "value": "opaque"}], "origins": []}
    }
    assert "ticket" not in result
    assert events == [
        "portal", "sso", "switch", "permit", "request", "reusable-code", "submit", "app", "ready"
    ]
    assert cm.playwright.chromium.browser.closed is True


def test_run_atrust_login_requires_both_providers():
    with pytest.raises(ValueError, match="code_provider"):
        asyncio.run(cqu_atrust.run_atrust_login("u", "p", permit_provider=lambda: None))
    with pytest.raises(ValueError, match="permit_provider"):
        asyncio.run(cqu_atrust.run_atrust_login("u", "p", code_provider=lambda: None))
