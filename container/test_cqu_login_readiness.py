import asyncio
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import cqu_login  # noqa: E402


class FakeClock:
    def __init__(self):
        self.now = 0.0

    def monotonic(self):
        return self.now

    async def sleep(self, seconds):
        self.now += seconds


class FakeLocator:
    def __init__(self, page, selector):
        self.page = page
        self.selector = selector

    async def count(self):
        if self.selector == "#login-croypto":
            return int(self.page.croypto_ready())
        if self.selector == "#login-page-flowkey":
            return int(self.page.flowkey_visible())
        return 0

    async def inner_text(self, **_kwargs):
        if self.selector == "#login-croypto":
            return "crypto-key" if self.page.croypto_ready() else ""
        if self.selector == "#login-page-flowkey":
            return "flow-key" if self.page.flowkey_ready() else ""
        return ""


class FakeContext:
    def __init__(self, page):
        self.page = page

    async def cookies(self, _urls=None):
        if not self.page.cookies_ready():
            return []
        return [
            {"name": "CtLgrmkSWHBZO", "value": self.page.cookie_values[0]},
            {"name": "CtLgrmkSWHBZP", "value": self.page.cookie_values[1]},
        ]


class FakeLoginPage:
    def __init__(
        self,
        clock,
        *,
        cookie_at,
        form_at,
        flowkey_at=None,
        cookie_values=("secret-o", "secret-p"),
    ):
        self.clock = clock
        self.cookie_at = cookie_at
        self.form_at = form_at
        self.flowkey_at = form_at if flowkey_at is None else flowkey_at
        self.cookie_values = cookie_values
        self.attempt = -1
        self.attempt_started = 0.0
        self.goto_count = 0
        self.reload_count = 0
        self.context = FakeContext(self)

    def _threshold_reached(self, thresholds):
        threshold = thresholds[min(self.attempt, len(thresholds) - 1)]
        return threshold is not None and self.clock.now - self.attempt_started >= threshold

    def cookies_ready(self):
        return self._threshold_reached(self.cookie_at)

    def croypto_ready(self):
        return self._threshold_reached(self.form_at)

    def flowkey_visible(self):
        return self._threshold_reached(self.form_at)

    def flowkey_ready(self):
        return self._threshold_reached(self.flowkey_at)

    async def goto(self, _url, **_kwargs):
        self.goto_count += 1
        self.attempt += 1
        self.attempt_started = self.clock.now

    async def reload(self, **_kwargs):
        self.reload_count += 1
        self.attempt += 1
        self.attempt_started = self.clock.now

    def locator(self, selector):
        return FakeLocator(self, selector)


def run_load(page, clock):
    return asyncio.run(
        cqu_login.load_login_page(
            page,
            "https://sso.cqu.edu.cn/login",
            sleep=clock.sleep,
            monotonic=clock.monotonic,
        )
    )


def test_login_ready_when_cookie_pair_arrives_before_complete_form_without_reload():
    """恢复固定 render wait 会在慢表单就绪前错误 reload。"""
    clock = FakeClock()
    page = FakeLoginPage(clock, cookie_at=[0.2], form_at=[0.6])

    assert run_load(page, clock) == ("crypto-key", "flow-key")
    assert page.goto_count == 1
    assert page.reload_count == 0
    assert clock.now == pytest.approx(0.6)


def test_login_ready_when_complete_form_arrives_before_cookie_pair_without_reload():
    """只在表单后检查一次 cookie 会漏掉稍后到达的动态 pair。"""
    clock = FakeClock()
    page = FakeLoginPage(clock, cookie_at=[0.6], form_at=[0.2])

    assert run_load(page, clock) == ("crypto-key", "flow-key")
    assert page.reload_count == 0
    assert clock.now == pytest.approx(0.6)


def test_missing_cookie_pair_reloads_once_only_after_each_twenty_second_timeout():
    """提前 reload 或无界 reload 都会改变已加载的瑞数上下文。"""
    clock = FakeClock()
    page = FakeLoginPage(clock, cookie_at=[None, None], form_at=[0.0, 0.0])

    assert run_load(page, clock) == (None, None)
    assert page.reload_count == 1
    assert clock.now == pytest.approx(40.0)


def test_empty_dynamic_cookie_value_does_not_make_pair_ready():
    clock = FakeClock()
    page = FakeLoginPage(
        clock,
        cookie_at=[0.0, 0.0],
        form_at=[0.0, 0.0],
        cookie_values=("secret-o", ""),
    )

    assert run_load(page, clock) == (None, None)
    assert page.reload_count == 1
    assert clock.now == pytest.approx(40.0)


def test_incomplete_form_reloads_once_only_after_each_thirty_second_timeout():
    """只有 selector 而 flowkey 为空时不得提交或提前 reload。"""
    clock = FakeClock()
    page = FakeLoginPage(
        clock,
        cookie_at=[0.0, 0.0],
        form_at=[0.0, 0.0],
        flowkey_at=[None, None],
    )

    assert run_load(page, clock) == (None, None)
    assert page.reload_count == 1
    assert clock.now == pytest.approx(60.0)


class FakeInteractiveLocator:
    def __init__(self, events):
        self.events = events
        self.first = self

    def filter(self, **_kwargs):
        return self

    async def count(self):
        return 1

    async def wait_for(self, **kwargs):
        self.events.append(("visible", kwargs["state"]))

    async def click(self, **_kwargs):
        self.events.append(("click", None))


class FakeInteractivePage:
    def __init__(self):
        self.events = []
        self.target = FakeInteractiveLocator(self.events)

    def locator(self, _selector):
        return self.target

    async def wait_for_timeout(self, milliseconds):
        self.events.append(("pause", milliseconds))


def test_switching_2fa_tab_waits_for_visibility_and_uses_injected_safe_pacing():
    page = FakeInteractivePage()
    pauses = iter((300.0, 400.0))
    ranges = []

    def uniform(low, high):
        ranges.append((low, high))
        return next(pauses)

    asyncio.run(
        cqu_login.switch_2fa_tab(
            page,
            "mail",
            uniform=uniform,
        )
    )

    assert ranges == [(150, 450), (200, 500)]
    assert page.events == [
        ("visible", "visible"),
        ("pause", 300.0),
        ("click", None),
        ("visible", "visible"),
        ("pause", 400.0),
    ]


def test_request_code_uses_injected_pre_click_pause():
    page = FakeInteractivePage()
    ranges = []

    def uniform(low, high):
        ranges.append((low, high))
        return 275.0

    clicked = asyncio.run(
        cqu_login.request_code(
            page,
            {"status": None, "body": None},
            uniform=uniform,
        )
    )

    assert clicked is True
    assert ranges == [(150, 450)]
    assert page.events == [
        ("visible", "visible"),
        ("pause", 275.0),
        ("click", None),
        ("pause", 3500),
    ]
