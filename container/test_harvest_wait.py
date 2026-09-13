import asyncio
from pathlib import Path
import re
from types import SimpleNamespace

import pytest

import cqu_data_harvest as m
from test_cqu_data_harvest import _FakeResponse
from test_browser_profile import probe_profile


NAV = "https://my.cqu.edu.cn/workspace/curriculum"
TABLE = "/my-table-detail"


class TimelinePage:
    def __init__(self, events=(), cookie_at=1, reload_events=()):
        self.now = 0.0
        self.events = list(events)
        self.cookie_at = cookie_at
        self.reload_events = reload_events
        self.reloads = []
        self.url = NAV
        self.captured = {}
        self.trace = m.StageTrace(clock=lambda: self.now)
        self.collector = m.ResponseStageCollector(self.trace, [TABLE], self.captured)
        self.goto_modes = []
        self.fetch_times = []

    async def cookies(self, *args):
        if self.now < self.cookie_at:
            return []
        return [{"name": name, "value": "present", "domain": "my.cqu.edu.cn"}
                for name in ("CtLgrmkSWHBZS", "CtLgrmkSWHBZT")]

    async def wait_for_timeout(self, ms):
        self.now = round(self.now + ms / 1000, 6)
        for at, response in list(self.events):
            if at <= self.now:
                self.events.remove((at, response))
                self.collector.on_response(response)
        await asyncio.sleep(0)

    async def reload(self, **kwargs):
        self.reloads.append((self.now, kwargs))
        self.events.extend((self.now + after, response)
                           for after, response in self.reload_events)

    async def goto(self, url, **kwargs):
        self.goto_modes.append(kwargs["wait_until"])

    def on(self, event, callback):
        self.collector.on_response = callback

    async def content(self):
        return "normal app"

    async def evaluate(self, script, args):
        self.fetch_times.append(self.now)
        return {"status": 200, "body": "{}"}


def response(path, **kwargs):
    return _FakeResponse("https://my.cqu.edu.cn/api" + path, **kwargs)


def bootstrap(app=35, judge=40):
    return [(app, response("/session/list")),
            (judge, response("/judge-release-schedule-stu"))]


async def wait(page, patterns=None, deadline=150):
    try:
        await m.wait_for_harvest_captures(
            page, page, NAV, [TABLE] if patterns is None else patterns,
            page.captured, page.trace, started_at=0, deadline=deadline,
            clock=lambda: page.now, uniform=lambda low, high: (low + high) / 2,
        )
    finally:
        await page.collector.close()


@pytest.mark.asyncio
async def test_late_route_and_table_succeed_without_reload_in_soft_wait():
    page = TimelinePage(bootstrap() + [(55, response(TABLE))])
    page.trace.record("NAV_START", url=NAV)
    await wait(page)
    assert TABLE in page.captured
    assert 55 <= page.now < 56
    assert page.reloads == []
    assert [event["stage"] for event in page.trace.events] == [
        "NAV_START", "DYNAMIC_COOKIES_PRESENT", "FIRST_RESPONSE",
        "APP_READY_API", "JUDGE_RESPONSE", "TABLE_RESPONSE_SEEN", "TABLE_BODY_READY",
    ]


@pytest.mark.asyncio
async def test_one_same_page_reload_recovers_within_table_envelope():
    page = TimelinePage(bootstrap(), reload_events=[(35, response(TABLE))])
    await wait(page)
    assert TABLE in page.captured
    assert len(page.reloads) == 1
    assert 66 <= page.reloads[0][0] < 67  # judge + soft 20s + pause 6s
    assert 101 <= page.now < 102


@pytest.mark.asyncio
async def test_table_arriving_during_pre_reload_pause_avoids_reload():
    page = TimelinePage(bootstrap() + [(63, response(TABLE))])
    await wait(page)
    assert TABLE in page.captured
    assert page.reloads == []


@pytest.mark.asyncio
async def test_hung_table_body_is_distinct_and_does_not_reload():
    page = TimelinePage(bootstrap() + [(50, response(TABLE, body_gate=asyncio.Event()))])
    await wait(page)
    assert page.captured == {}
    assert page.trace.has_stage("TABLE_RESPONSE_SEEN")
    assert not page.trace.has_stage("TABLE_BODY_READY")
    assert page.reloads == []
    assert 129 <= page.now <= 131


@pytest.mark.asyncio
@pytest.mark.parametrize("events,cookie_at,expected", [
    ([], 100, 30), ([], 1, 45), ([(35, response("/session/list"))], 1, 60),
])
async def test_bootstrap_limits_are_milestones_not_additive(events, cookie_at, expected):
    page = TimelinePage(events, cookie_at=cookie_at)
    await wait(page)
    assert page.now == pytest.approx(expected)
    assert page.reloads == []


@pytest.mark.asyncio
async def test_recovery_and_waits_respect_remaining_overall_budget():
    page = TimelinePage(bootstrap())
    await wait(page, deadline=70)
    assert len(page.reloads) == 1
    assert page.now == pytest.approx(70)
    assert page.reloads[0][1]["timeout"] <= 4000
    assert page.captured == {}


@pytest.mark.asyncio
async def test_missing_table_stops_after_single_recovery_wait():
    page = TimelinePage(bootstrap())
    await wait(page)
    assert len(page.reloads) == 1
    assert 111 <= page.now < 112
    assert page.captured == {}


@pytest.mark.asyncio
async def test_fetch_only_wait_is_immediate_and_generic_capture_keeps_old_limit():
    page = TimelinePage(cookie_at=100)
    await wait(page, patterns=[])
    assert page.now == 0
    page = TimelinePage(cookie_at=100)
    await wait(page, patterns=["/unrelated"])
    assert page.now == pytest.approx(m.CAPTURE_WAIT_MS / 1000)
    assert page.reloads == []


@pytest.mark.asyncio
@pytest.mark.parametrize("fetch_only,missing,fetch_status,export_fails,capture_status,include_fetch", [
    (False, False, 200, False, 200, True), (False, True, 200, False, 200, True),
    (True, False, 200, False, 200, True), (False, False, 503, False, 200, True),
    (True, False, 503, False, 200, True), (False, False, 200, True, 200, True),
    (False, False, 200, False, 503, True), (False, False, 200, False, 503, False),
])
async def test_harvest_uses_one_browser_context_page_and_preserves_failure_gate(
    monkeypatch, fetch_only, missing, fetch_status, export_fails, capture_status, include_fetch,
):
    page = TimelinePage(bootstrap(), reload_events=[] if missing else [(5, response(TABLE, status=capture_status))])
    counts = {"launch": 0, "context": 0, "page": 0}
    exports = []
    refreshed = {"cookies": [{"name": "marker", "value": "refreshed"}], "origins": []}

    async def evaluate(script, args):
        page.fetch_times.append(page.now)
        return {"status": fetch_status, "body": "{}"}

    async def storage_state():
        # Export cannot run before every required body and supplemental GET.
        assert fetch_only or TABLE in page.captured
        assert len(page.fetch_times) == int(include_fetch)
        exports.append(page.now)
        if export_fails:
            raise RuntimeError("state export failed SECRET")
        return refreshed

    page.evaluate = evaluate

    async def new_page():
        counts["page"] += 1
        return page

    async def new_context(**kwargs):
        counts["context"] += 1
        return SimpleNamespace(new_page=new_page, cookies=page.cookies, storage_state=storage_state)

    async def launch(**kwargs):
        counts["launch"] += 1
        return SimpleNamespace(new_context=new_context)

    async def start():
        return SimpleNamespace(chromium=SimpleNamespace(launch=launch))

    async def close(*args):
        pass

    original_wait = m.wait_for_harvest_captures

    async def timed_wait(p, ctx, nav, patterns, captured, trace, **kwargs):
        page.captured = captured
        page.trace = trace
        await original_wait(p, ctx, nav, patterns, captured, trace,
                            started_at=0, deadline=150, clock=lambda: page.now,
                            uniform=lambda low, high: (low + high) / 2)

    monkeypatch.setattr(m, "async_playwright", lambda: SimpleNamespace(start=start))
    monkeypatch.setattr(m, "wait_for_harvest_captures", timed_wait)
    monkeypatch.setattr(m.cqu_ticket_browser, "_close_browser_driver", close)
    recipe = {"navUrl": NAV, "capture": [] if fetch_only else [TABLE],
              "fetch": [{"url": "https://my.cqu.edu.cn/api/example"}] if include_fetch else []}
    if missing or (fetch_only and fetch_status == 503):
        with pytest.raises(m.HarvestTransientError):
            await m.harvest({}, recipe)
        assert exports == []
    else:
        result = await m.harvest({}, recipe)
        assert result["fetches" if fetch_only else "captures"]
        if capture_status == 503:
            assert result["captures"][0]["status"] == 503
            assert exports == []
            assert "state" not in result
        elif fetch_status == 200 and not export_fails:
            assert result["state"] == refreshed
            assert len(exports) == 1
        else:
            assert "state" not in result
            assert len(exports) == (1 if export_fails else 0)
    assert counts == {"launch": 1, "context": 1, "page": 1}
    assert len(page.reloads) == (0 if fetch_only else 1)
    assert page.goto_modes == ["domcontentloaded" if fetch_only else "commit"]
    if fetch_only:
        assert page.fetch_times == [0]


def test_cross_layer_browser_work_budget_leaves_queue_cleanup_and_margin():
    source = (Path(__file__).resolve().parents[1] / "src/services/cqu-browser-budget.ts").read_text()
    outer_ms = int(re.search(r"CONTAINER_BROWSER_DEADLINE_MS = ([\d_]+)", source)[1].replace("_", ""))
    for name in ("default", "cloudflare"):
        work = probe_profile({"CQU_BROWSER_PROFILE": name})["harvest_overall"]
        assert work == 150
        assert (m.cqu_ticket_browser.QUEUE_WAIT + work + 15 + 10) * 1000 <= outer_ms
