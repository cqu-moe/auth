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
    def __init__(self, events=(), cookie_at=1, reload_events=(), requests=()):
        self.now = 0.0
        self.events = list(events)
        self.requests = list(requests)
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
        for at, request in list(self.requests):
            if at <= self.now:
                self.requests.remove((at, request))
                self.collector.on_request(request)
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
        if event == "response":
            self.collector.on_response = callback

    async def content(self):
        return "normal app"

    async def evaluate(self, script, args):
        self.fetch_times.append(self.now)
        return {"status": 200, "body": "{}"}


def response(path, **kwargs):
    return _FakeResponse("https://my.cqu.edu.cn/api" + path, **kwargs)


def bootstrap(app=35, judge=40):
    return [(app, _FakeResponse(NAV, resource_type="document")),
            (app, response("/session/list")),
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
        "APP_DOCUMENT_REACHED", "APP_READY_API", "JUDGE_RESPONSE", "TABLE_RESPONSE_SEEN", "TABLE_BODY_READY",
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
@pytest.mark.parametrize("request_at", [59, 63], ids=["before-pause", "during-pause"])
@pytest.mark.parametrize("response_at", [120, None], ids=["late-response", "hung-request"])
async def test_table_request_suppresses_reload_and_keeps_original_envelope(request_at, response_at):
    events = bootstrap() + ([] if response_at is None else [(response_at, response(TABLE))])
    page = TimelinePage(events, requests=[(
        request_at, SimpleNamespace(url=NAV + TABLE, resource_type="fetch"),
    )])

    await wait(page)

    assert page.reloads == []
    assert page.trace.has_stage("TABLE_REQUEST_SEEN")
    if response_at is None:
        assert page.captured == {}
        assert page.now == pytest.approx(130.05)  # observed judge + original 90s envelope
    else:
        assert page.captured[TABLE]["body"] == "{}"
        assert 120 <= page.now < 121


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
    ([], 100, 45), ([], 1, 45), (bootstrap(judge=100), 1, 60),
])
async def test_bootstrap_limits_are_milestones_not_additive(events, cookie_at, expected):
    page = TimelinePage(events, cookie_at=cookie_at)
    await wait(page)
    assert page.now == pytest.approx(expected)
    assert page.reloads == []


@pytest.mark.asyncio
async def test_app_document_progress_continues_when_dynamic_cookie_is_not_observed():
    page = TimelinePage(bootstrap() + [(55, response(TABLE))], cookie_at=100)
    page.trace.record("NAV_START", url=NAV)

    await wait(page)

    assert TABLE in page.captured
    assert page.trace.has_stage("APP_DOCUMENT_REACHED")
    assert not page.trace.has_stage("DYNAMIC_COOKIES_PRESENT")
    assert 55 <= page.now < 56
    assert page.reloads == []


def test_app_document_progress_classifies_missing_api_as_app_ready_timeout():
    trace = m.StageTrace()
    trace.record("APP_DOCUMENT_REACHED", url=NAV, status=200, resource_type="document")

    assert m.harvest_failure_code(
        trace,
        [TABLE],
        {},
        required_statuses=[],
        fetch_statuses=[],
    ) == "APP_READY_TIMEOUT"


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
async def test_inpage_gets_are_serial_with_between_only_injected_jitter():
    events = []
    first_started = asyncio.Event()
    allow_first_to_finish = asyncio.Event()

    class Page:
        async def evaluate(self, script, args):
            events.append(("fetch", args["u"]))
            if args["u"].endswith("/one"):
                first_started.set()
                await allow_first_to_finish.wait()
            return {"status": 200, "body": args["u"]}

    async def sleep(seconds):
        events.append(("sleep", seconds))

    fetches = []
    trace = m.StageTrace()
    task = asyncio.create_task(m.run_serial_inpage_gets(
        Page(),
        [{"url": "https://my.cqu.edu.cn/api/one"},
         {"url": "https://my.cqu.edu.cn/api/two"},
         {"url": "https://my.cqu.edu.cn/api/three"}],
        trace,
        fetches,
        uniform=lambda low, high: low if len(fetches) == 1 else high,
        sleep=sleep,
    ))

    await first_started.wait()
    await asyncio.sleep(0)
    assert events == [("fetch", "https://my.cqu.edu.cn/api/one")]
    allow_first_to_finish.set()
    await task

    assert events == [
        ("fetch", "https://my.cqu.edu.cn/api/one"),
        ("sleep", 0.250),
        ("fetch", "https://my.cqu.edu.cn/api/two"),
        ("sleep", 0.800),
        ("fetch", "https://my.cqu.edu.cn/api/three"),
    ]
    assert [item["body"] for item in fetches] == [
        "https://my.cqu.edu.cn/api/one",
        "https://my.cqu.edu.cn/api/two",
        "https://my.cqu.edu.cn/api/three",
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("urls", [[], ["https://my.cqu.edu.cn/api/only"]])
async def test_inpage_get_jitter_is_absent_for_zero_or_one_fetch(urls):
    sleeps = []

    class Page:
        async def evaluate(self, script, args):
            return {"status": 200, "body": "{}"}

    async def sleep(seconds):
        sleeps.append(seconds)

    fetches = []
    await m.run_serial_inpage_gets(
        Page(), [{"url": url} for url in urls], m.StageTrace(), fetches,
        uniform=lambda low, high: pytest.fail("uniform must not be called"),
        sleep=sleep,
    )
    assert sleeps == []


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
    if missing or fetch_status == 503 or capture_status == 503:
        with pytest.raises(m.HarvestTransientError) as failure:
            await m.harvest({}, recipe)
        assert failure.value.code == (
            "TABLE_CAPTURE_TIMEOUT" if missing else
            "TABLE_API_REJECTED" if capture_status == 503 else "HARVEST_TRANSIENT"
        )
        assert exports == []
        if missing or capture_status == 503:
            assert page.fetch_times == []
    else:
        result = await m.harvest({}, recipe)
        assert result["fetches" if fetch_only else "captures"]
        if fetch_status == 200 and not export_fails:
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


@pytest.fixture
def complete_harvest_browser(monkeypatch):
    callbacks = {}
    counts = {"launch": 0, "context": 0, "page": 0, "close": 0}

    async def goto(*args, **kwargs):
        callbacks["response"](response(TABLE, body='{"courses":["complete"]}'))
        await asyncio.sleep(0)

    async def evaluate(*args):
        return {"status": 200, "body": '["complete exam"]'}

    page = SimpleNamespace(
        on=lambda event, callback: callbacks.update({event: callback}),
        goto=goto, evaluate=evaluate, url=NAV,
    )

    async def new_page():
        counts["page"] += 1
        return page

    context = SimpleNamespace(new_page=new_page)

    async def new_context(**kwargs):
        counts["context"] += 1
        return context

    async def launch(**kwargs):
        counts["launch"] += 1
        return SimpleNamespace(new_context=new_context)

    async def start():
        return SimpleNamespace(chromium=SimpleNamespace(launch=launch))

    async def close(*args):
        counts["close"] += 1

    monkeypatch.setattr(m, "async_playwright", lambda: SimpleNamespace(start=start))
    monkeypatch.setattr(m.cqu_ticket_browser, "_close_browser_driver", close)
    return context, counts


@pytest.mark.asyncio
@pytest.mark.parametrize("work,export_cap,margin,export_started", [
    (0.2, 0.02, 0.05, True),
    (0.1, 1.0, 0.05, True),
    (0.02, 1.0, 0.05, False),
], ids=["export-cap", "remaining-work-margin", "insufficient-margin"])
async def test_optional_export_stall_preserves_complete_data(
    monkeypatch, complete_harvest_browser, work, export_cap, margin, export_started,
):
    context, counts = complete_harvest_browser
    started = asyncio.Event()
    cancelled = asyncio.Event()

    async def storage_state():
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    context.storage_state = storage_state
    monkeypatch.setattr(m, "HARVEST_OVERALL_TIMEOUT", work)
    monkeypatch.setattr(m, "STATE_EXPORT_TIMEOUT_S", export_cap, raising=False)
    monkeypatch.setattr(m, "STATE_EXPORT_DEADLINE_MARGIN_S", margin, raising=False)
    result = await m.harvest({}, {
        "navUrl": NAV, "capture": [TABLE],
        "fetch": [{"url": "https://my.cqu.edu.cn/api/exam/x"}],
    })

    assert result["captures"][0]["body"] == '{"courses":["complete"]}'
    assert result["fetches"][0]["body"] == '["complete exam"]'
    assert "state" not in result
    assert result["diagnostics"]["timeline"][-1]["stage"] == "DONE"
    assert started.is_set() is export_started
    assert cancelled.is_set() is export_started
    assert counts == {"launch": 1, "context": 1, "page": 1, "close": 1}


@pytest.mark.asyncio
@pytest.mark.parametrize("external_deadline", [False, True], ids=["task-cancellation", "server-deadline"])
async def test_optional_export_propagates_external_cancellation(
    monkeypatch, complete_harvest_browser, external_deadline,
):
    import server
    context, counts = complete_harvest_browser
    started = asyncio.Event()
    cancelled = asyncio.Event()

    async def storage_state():
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    context.storage_state = storage_state
    monkeypatch.setattr(m, "HARVEST_OVERALL_TIMEOUT", 1.0)
    monkeypatch.setattr(m, "STATE_EXPORT_TIMEOUT_S", 0.5, raising=False)
    monkeypatch.setattr(m, "STATE_EXPORT_DEADLINE_MARGIN_S", 0.1, raising=False)
    operation = m.harvest({}, {"navUrl": NAV, "capture": [TABLE], "fetch": []})
    if external_deadline:
        with pytest.raises(server.BrowserDeadlineExceeded):
            await server.run_bounded(operation, 30)
    else:
        task = asyncio.create_task(operation)
        await asyncio.wait_for(started.wait(), timeout=0.5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    assert started.is_set()
    assert cancelled.is_set()
    assert counts == {"launch": 1, "context": 1, "page": 1, "close": 1}


@pytest.mark.asyncio
async def test_failed_get_omits_diagnostic_status_but_keeps_business_zero():
    async def evaluate(*args):
        raise RuntimeError("transport SECRET")

    trace = m.StageTrace()
    fetches = []
    await m.run_serial_inpage_gets(
        SimpleNamespace(evaluate=evaluate),
        [{"url": "https://my.cqu.edu.cn/api/exam/x"}], trace, fetches,
    )
    assert fetches == [{"url": "https://my.cqu.edu.cn/api/exam/x", "status": 0, "body": ""}]
    failure = trace.diagnostics()["timeline"][-1]
    assert failure["stage"] == "GET_FETCH_FAILURE"
    assert "status" not in failure
    assert "SECRET" not in str(trace.diagnostics())


@pytest.mark.parametrize("stages,statuses,fetches,expected", [
    ([], [], [], "WAF_BOOTSTRAP_TIMEOUT"),
    (["DYNAMIC_COOKIES_PRESENT"], [], [], "APP_READY_TIMEOUT"),
    (["DYNAMIC_COOKIES_PRESENT", "APP_READY_API", "JUDGE_RESPONSE"], [], [], "APP_READY_TIMEOUT"),
    (["DYNAMIC_COOKIES_PRESENT", "APP_DOCUMENT_REACHED", "APP_READY_API"], [], [], "APP_READY_TIMEOUT"),
    (["DYNAMIC_COOKIES_PRESENT", "APP_DOCUMENT_REACHED", "APP_READY_API", "JUDGE_RESPONSE"], [], [], "TABLE_CAPTURE_TIMEOUT"),
    (["TABLE_REQUEST_SEEN"], [], [], "TABLE_REQUEST_HUNG"),
    (["TABLE_RESPONSE_SEEN"], [], [], "TABLE_BODY_TIMEOUT"),
    (["TABLE_RESPONSE_SEEN", "TABLE_BODY_FAILURE"], [], [], "TABLE_BODY_TIMEOUT"),
    (["TABLE_RESPONSE_SEEN"], [503], [], "TABLE_API_REJECTED"),
    (["TABLE_RESPONSE_SEEN", "TABLE_BODY_FAILURE"], [503, 412], [], "WAF_CHALLENGE"),
    ([], [], [412], "WAF_CHALLENGE"),
    ([], [], [0], "HARVEST_TRANSIENT"),
])
def test_failure_precedence(stages, statuses, fetches, expected):
    trace = m.StageTrace()
    for stage in stages:
        trace.record(stage)
    assert m.harvest_failure_code(trace, [TABLE], {}, statuses, fetches,
                                  table_statuses=statuses) == expected


@pytest.mark.asyncio
async def test_initial_412_is_bootstrap_and_table_request_is_sanitized():
    trace = m.StageTrace()
    collector = m.ResponseStageCollector(trace, [TABLE], {})
    collector.on_response(_FakeResponse(NAV, status=412, resource_type="document"))
    assert not trace.has_stage("APP_DOCUMENT_REACHED")
    assert m.harvest_failure_code(trace, [TABLE], {}, collector.required_statuses, []) == "WAF_BOOTSTRAP_TIMEOUT"
    collector.on_request(SimpleNamespace(url=NAV + TABLE + "?token=SECRET", resource_type="fetch"))
    assert m.harvest_failure_code(trace, [TABLE], {}, collector.required_statuses, []) == "TABLE_REQUEST_HUNG"
    assert "SECRET" not in str(trace.diagnostics())
    await collector.close()


@pytest.mark.asyncio
async def test_unmatched_table_412_does_not_override_generic_capture_failure():
    trace = m.StageTrace()
    collector = m.ResponseStageCollector(trace, ["/session/list"], {})
    collector.on_response(response(TABLE, status=412, body_gate=asyncio.Event()))
    assert m.harvest_failure_code(trace, ["/session/list"], {}, collector.required_statuses, []) == "HARVEST_TRANSIENT"
    await collector.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("status,expected", [(404, "HARVEST_TRANSIENT"), (503, "HARVEST_TRANSIENT"), (412, "WAF_CHALLENGE")])
async def test_generic_capture_rejections_preserve_resource_provenance(status, expected):
    trace = m.StageTrace()
    captured = {}
    collector = m.ResponseStageCollector(trace, ["/session/list"], captured)
    collector.on_response(response("/session/list", status=status))
    await collector.close()
    assert m.harvest_failure_code(trace, ["/session/list"], captured,
                                  collector.required_statuses, []) == expected


@pytest.mark.asyncio
@pytest.mark.parametrize("incidental", ["request", "pending", "failed", "rejected", "challenge"])
async def test_successful_generic_capture_ignores_incidental_table_traffic(incidental):
    trace = m.StageTrace()
    captured = {}
    collector = m.ResponseStageCollector(trace, ["/session/list"], captured)
    collector.on_response(response("/session/list"))
    collector.on_request(SimpleNamespace(url=NAV + TABLE, resource_type="fetch"))
    if incidental != "request":
        collector.on_response(response(TABLE,
            status=503 if incidental == "rejected" else 412 if incidental == "challenge" else 200,
            body_gate=asyncio.Event() if incidental == "pending" else None,
            body_error=RuntimeError("SECRET") if incidental == "failed" else None,
        ))
    await collector.close()
    assert m.harvest_failure_code(trace, ["/session/list"], captured,
                                  collector.required_statuses, []) is None


@pytest.mark.asyncio
@pytest.mark.parametrize("external_deadline", [False, True])
async def test_outer_short_budget_classifies_observed_hung_body(monkeypatch, external_deadline):
    import server
    callbacks = {}

    async def goto(*args, **kwargs):
        callbacks["response"](_FakeResponse(NAV, resource_type="document"))
        callbacks["response"](response("/session/list"))
        callbacks["response"](response("/judge-release-schedule-stu"))
        callbacks["response"](response(TABLE, body_gate=asyncio.Event()))

    async def content():
        return "normal app"

    async def cookies(*args):
        return [{"name": name, "value": "present"}
                for name in ("CtLgrmkSWHBZS", "CtLgrmkSWHBZT")]

    page = SimpleNamespace(
        on=lambda event, callback: callbacks.update({event: callback}),
        goto=goto, content=content, url=NAV,
        wait_for_timeout=lambda ms: asyncio.sleep(ms / 1000),
    )

    async def new_page():
        return page

    async def new_context(**kwargs):
        return SimpleNamespace(new_page=new_page, cookies=cookies)

    async def launch(**kwargs):
        return SimpleNamespace(new_context=new_context)

    async def start():
        return SimpleNamespace(chromium=SimpleNamespace(launch=launch))

    async def close(*args):
        pass

    monkeypatch.setattr(m, "async_playwright", lambda: SimpleNamespace(start=start))
    monkeypatch.setattr(m, "HARVEST_OVERALL_TIMEOUT", 1 if external_deadline else 0.03)
    monkeypatch.setattr(m.cqu_ticket_browser, "_close_browser_driver", close)
    operation = m.harvest({}, {"navUrl": NAV, "capture": [TABLE], "fetch": []})
    if external_deadline:
        with pytest.raises(server.BrowserDeadlineExceeded):
            await server.run_bounded(operation, 30)
        return
    with pytest.raises(m.HarvestTransientError) as failure:
        await operation
    assert failure.value.code == "TABLE_BODY_TIMEOUT"
    assert "TABLE_RESPONSE_SEEN" in str(failure.value.diagnostics)


@pytest.mark.asyncio
async def test_empty_judge_data_does_not_prove_schedule_unpublished():
    page = TimelinePage(bootstrap(judge=100) + [
        (40, response("/judge-release-schedule-stu", body='{"data":""}')),
    ])
    await wait(page)
    assert m.harvest_failure_code(page.trace, [TABLE], page.captured,
                                  page.collector.required_statuses, []) == "TABLE_CAPTURE_TIMEOUT"


def test_cross_layer_browser_work_budget_leaves_queue_cleanup_and_margin():
    source = (Path(__file__).resolve().parents[1] / "src/services/cqu-browser-budget.ts").read_text()
    outer_ms = int(re.search(r"CONTAINER_BROWSER_DEADLINE_MS = ([\d_]+)", source)[1].replace("_", ""))
    for name in ("default", "cloudflare"):
        work = probe_profile({"CQU_BROWSER_PROFILE": name})["harvest_overall"]
        assert work == 150
        assert (m.cqu_ticket_browser.QUEUE_WAIT + work + 15 + 10) * 1000 <= outer_ms
