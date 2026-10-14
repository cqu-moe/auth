#!/usr/bin/env python3
"""External AllCourseSearch endpoint contract tests (no network or real browser)."""
import os
import sys
import asyncio
import json
import urllib.parse
from unittest.mock import AsyncMock, Mock

from posthog_client import POSTHOG_CLIENT_KEY
import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from aiohttp.test_utils import AioHTTPTestCase

import server
import chromium_session
import cqu_external_search


class ExternalSearchTestCase(AioHTTPTestCase):
    async def get_application(self):
        app = server.build_app()
        app[POSTHOG_CLIENT_KEY] = Mock()
        return app

    def setUp(self):
        super().setUp()
        self.original_search = server.cqu_external_search.external_search

    def tearDown(self):
        server.cqu_external_search.external_search = self.original_search
        super().tearDown()

    async def test_fixed_admin_class_recipe_reaches_browser_action(self):
        async def fake_search(state, recipe):
            assert state == {"cookies": [], "origins": []}
            assert recipe == {
                "action": "admin_class_search",
                "departmentId": "",
                "departmentName": "",
                "grade": "2026",
                "keyword": "电气",
            }
            return {
                "contractVersion": 1,
                "sourceType": "admin_class",
                "session": {"id": "session-current", "name": "2026秋"},
                "items": [{"id": "class-1", "name": "电气1班", "extra": "2026级"}],
                "truncated": True,
            }

        server.cqu_external_search.external_search = fake_search
        response = await self.client.post("/external-search", json={
            "state": {"cookies": [], "origins": []},
            "action": "admin_class_search",
            "departmentId": "",
            "grade": "2026",
            "keyword": "电气",
        })
        assert response.status == 200
        body = await response.json()
        assert body["ok"] is True
        assert body["items"] == [{"id": "class-1", "name": "电气1班", "extra": "2026级"}]
        assert body["truncated"] is True

    async def test_fixed_instructor_recipe_reaches_browser_action(self):
        async def fake_search(state, recipe):
            assert recipe == {
                "action": "instructor_search",
                "departmentId": "",
                "departmentName": "",
                "grade": "",
                "keyword": "张",
            }
            return {
                "contractVersion": 1,
                "sourceType": "instructor",
                "session": {"id": "session-current", "name": "2026秋"},
                "items": [{"id": "teacher-1", "name": "张三", "extra": "10001 / 电气工程学院 / A校区"}],
                "truncated": True,
            }

        server.cqu_external_search.external_search = fake_search
        response = await self.client.post("/external-search", json={
            "state": {"cookies": [], "origins": []},
            "action": "instructor_search",
            "keyword": "张",
        })
        assert response.status == 200
        body = await response.json()
        assert body["ok"] is True
        assert body["sourceType"] == "instructor"
        assert body["items"] == [{"id": "teacher-1", "name": "张三", "extra": "10001 / 电气工程学院 / A校区"}]
        assert body["truncated"] is True

    async def test_fixed_room_and_laboratory_recipes_keep_canonical_candidate_names(self):
        for source_type in ("room", "laboratory"):
            async def fake_search(state, recipe):
                assert recipe["action"] == source_type + "_search"
                return {"contractVersion": 1, "sourceType": source_type,
                    "session": {"id": "session-current", "name": "2026秋"},
                    "items": [{"id": "room-1", "name": "实验室101", "extra": "实验楼", "privateField": "SECRET"}], "truncated": False}
            server.cqu_external_search.external_search = fake_search
            response = await self.client.post("/external-search", json={"state": {"cookies": [], "origins": []}, "action": source_type + "_search", "keyword": "101"})
            assert response.status == 200
            body = await response.json()
            assert body["sourceType"] == source_type
            assert body["items"] == [{"id": "room-1", "name": "实验室101", "extra": "实验楼"}]

    async def test_external_search_reports_bounded_business_telemetry(self):
        async def fake_search(state, recipe):
            return {
                "contractVersion": 1,
                "sourceType": "department",
                "session": {"id": "session-current", "name": "2026秋"},
                "departments": [{"id": "dept-1", "name": "电气工程学院"}],
            }

        server.cqu_external_search.external_search = fake_search
        response = await self.client.post("/external-search", json={
            "state": {"cookies": [], "origins": []},
            "action": "department_list",
        })
        assert response.status == 200
        client = self.client.app[POSTHOG_CLIENT_KEY]
        client.capture.assert_called_once()
        properties = client.capture.call_args.kwargs["properties"]
        assert properties["operation"] == "external_search"
        assert properties["business_outcome"] == "success"
        assert properties["http_outcome"] == "success"

    async def test_transport_overrides_are_rejected_before_browser_action(self):
        async def unreachable(*_args, **_kwargs):
            raise AssertionError("browser action must not run")

        server.cqu_external_search.external_search = unreachable
        for override in (
            {"url": "https://example.com"},
            {"selector": "#arbitrary"},
            {"method": "POST"},
            {"body": {"anything": True}},
        ):
            response = await self.client.post("/external-search", json={
                "state": {"cookies": [], "origins": []},
                "action": "admin_class_search",
                **override,
            })
            assert response.status == 400, override
            body = await response.json()
            assert body == {"ok": False, "error": "recipe not allowed"}

    async def test_success_response_is_rebuilt_from_the_typed_allowlist(self):
        async def fake_search(*_args, **_kwargs):
            return {
                "contractVersion": 1,
                "sourceType": "admin_class",
                "session": {"id": "session-current", "name": "2026秋"},
                "items": [{"id": "class-1", "name": "电气1班", "extra": "2026级"}],
                "truncated": False,
                "state": {"cookie": "SECRET"},
                "diagnostics": {"body": "SECRET"},
            }

        server.cqu_external_search.external_search = fake_search
        response = await self.client.post("/external-search", json={
            "state": {"cookies": [], "origins": []},
            "action": "department_list",
        })
        assert response.status == 200
        text = await response.text()
        assert "SECRET" not in text
        assert '"state"' not in text and '"diagnostics"' not in text


async def start_action_site(search_status=200, search_body=None):
    app = __import__("aiohttp", fromlist=["web"]).web.Application()
    calls = []

    async def page(_request):
        return __import__("aiohttp", fromlist=["web"]).web.Response(text="""<!doctype html><html><body>
          <main aria-label="排课管理">
            <div class="ant-select ant-select-disabled" aria-label="学期"><div class="ant-select-selection-item">2026年秋</div></div>
            <div><span>查询范围：</span><div class="ant-select" data-control="range"><div class="ant-select-selection-item">教师</div></div></div>
            <div><span>学院：</span><div class="ant-select" data-control="department"><div class="ant-select-selection-item">全部</div><span class="ant-select-clear" style="display:none">×</span></div></div>
            <div><span>年级：</span><div class="ant-select" data-control="grade"><div class="ant-select-selection-item">2025</div><span class="ant-select-clear">×</span></div></div>
            <div class="keyword-control"><div class="ant-select"><div class="ant-select-selection__placeholder">请输入行政班名字快速查询</div><input class="ant-input ant-select-search__field" data-control="keyword" value=""></div></div>
            <button type="button">查询</button>
          </main><script>
            window.filters = {department: '', grade: '2025', keyword: ''};
            window.termTouched = false;
            document.querySelector('[aria-label="学期"]').addEventListener('click', () => { window.termTouched = true; });
            for (const control of document.querySelectorAll('.ant-select')) {
              if (control.closest('.keyword-control')) continue;
              control.addEventListener('click', event => {
                if (control.closest('[aria-label="学期"]')) return;
                const name = control.dataset.control;
                if (event.target.closest('.ant-select-clear')) {
                  window.filters[name] = '';
                  control.querySelector('.ant-select-selection-item').textContent = '全部';
                  return;
                }
                const options = {range: ['行政班'], department: ['电气工程学院'], grade: ['2025', '2026']};
                const list = document.createElement('div');
                list.className = 'ant-select-dropdown';
                for (const text of options[name] || []) {
                  const option = document.createElement('div');
                  option.className = 'ant-select-item-option';
                  option.textContent = text;
                  option.onclick = () => {
                    window.filters[name] = text;
                    control.querySelector('.ant-select-selection-item').textContent = text;
                    list.remove();
                  };
                  list.append(option);
                }
                if (!event.target.closest('.ant-select-clear')) document.body.append(list);
              });
            }
            document.querySelector('[data-control="keyword"]').addEventListener('input', event => {
              window.filters.keyword = event.target.value;
              const query = new URLSearchParams({grade: window.filters.grade, className: window.filters.keyword});
              fetch('/api/timetable/admin-class/dept-admin-classes?' + query, {
                method: 'POST', credentials: 'include', body: JSON.stringify(window.filters.department ? [window.filters.department] : [])
              });
            });
            fetch('/api/timetable/admin-class/dept-admin-classes?stale=1', {
              method: 'POST', credentials: 'include', body: JSON.stringify([])
            });
          </script></body></html>""", content_type="text/html")

    async def search(request):
        calls.append({
            "body": await request.text(),
            "grade": request.query.get("grade"),
            "keyword": request.query.get("className"),
        })
        if request.query.get("stale") == "1":
            await asyncio.sleep(0.25)
            return __import__("aiohttp", fromlist=["web"]).web.json_response([
                {"id": "class-stale", "className": "旧查询班级", "departmentName": "旧学院", "grade": "2025", "personNumber": 1}
            ])
        return __import__("aiohttp", fromlist=["web"]).web.json_response(search_body if search_body is not None else [
            {"id": "class-1", "className": "电气1班", "departmentName": "电气工程学院", "grade": "2026", "personNumber": 30}
        ], status=search_status)

    app.router.add_get("/", page)
    app.router.add_post("/api/timetable/admin-class/dept-admin-classes", search)
    runner = __import__("aiohttp", fromlist=["web"]).web.AppRunner(app)
    await runner.setup()
    site = __import__("aiohttp", fromlist=["web"]).web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    address = site._server.sockets[0].getsockname()
    return runner, f"http://{address[0]}:{address[1]}", calls


def test_admin_class_action_uses_visible_page_controls(monkeypatch, tmp_path):
    async def run():
        runner, origin, calls = await start_action_site()
        monkeypatch.setenv("CQU_CDP_RUNTIME_DIR", str(tmp_path))
        try:
            async with chromium_session.ChromiumSession() as browser:
                await browser.navigate(origin + "/", timeout_s=5)
                capture = await cqu_external_search.perform_admin_class_search(
                    browser, {"departmentId": "", "grade": "2026", "keyword": "电气"}
                )
                assert capture["status"] == 200
                assert '"class-1"' in capture["body"]
                assert await browser.evaluate("window.termTouched") is False
                assert len(calls) == 2
                assert calls[0]["body"] == "[]"
                assert calls[-1] == {
                    "body": "[]", "grade": "2026", "keyword": "电气",
                }
        finally:
            await runner.cleanup()

    asyncio.run(run())


def test_admin_class_action_distinguishes_page_permission_denied(monkeypatch, tmp_path):
    async def run():
        runner, origin, _calls = await start_action_site(
            search_status=403,
            search_body={"error": "forbidden"},
        )
        monkeypatch.setenv("CQU_CDP_RUNTIME_DIR", str(tmp_path))
        try:
            async with chromium_session.ChromiumSession() as browser:
                await browser.navigate(origin + "/", timeout_s=5)
                with pytest.raises(cqu_external_search.ExternalSearchTransientError) as raised:
                    await cqu_external_search.perform_admin_class_search(
                        browser,
                        {"departmentId": "", "departmentName": "", "grade": "", "keyword": "电气"},
                    )
                assert raised.value.code == "PAGE_PERMISSION_DENIED"
        finally:
            await runner.cleanup()

    asyncio.run(run())


async def start_instructor_site(search_status=200, page_delay_ms=0, bootstrap_reload=False, bootstrap_script_delay_s=0):
    app = __import__("aiohttp", fromlist=["web"]).web.Application()
    calls = []

    async def page(_request):
        if bootstrap_reload and _request.query.get("ready") != "1":
            return __import__("aiohttp", fromlist=["web"]).web.Response(
                text='<!doctype html><script>setTimeout(() => location.replace("/?ready=1"), 300)</script>',
                content_type="text/html",
            )
        html = """<!doctype html><html><body>
          <main aria-label="排课管理">
            <div class="ant-select ant-select-disabled" aria-label="学期"><div class="ant-select-selection-item">2026年秋</div></div>
            <div><span>查询范围：</span><div class="ant-select" data-control="range"><div class="ant-select-selection-item">行政班</div></div></div>
            <div class="target-control"><div class="ant-select"><div class="ant-select-selection__placeholder">请输入教师姓名或工号</div><input class="ant-input ant-select-search__field" data-control="keyword" value=""></div></div>
          </main><script>
            window.termTouched = false;
            window.range = '行政班';
            document.querySelector('[aria-label="学期"]').addEventListener('click', () => { window.termTouched = true; });
            document.querySelector('[data-control="range"]').addEventListener('click', () => {
              const list = document.createElement('div');
              list.className = 'ant-select-dropdown';
              const option = document.createElement('div');
              option.className = 'ant-select-item-option';
              option.textContent = '教师';
              option.onclick = () => {
                window.range = '教师';
                document.querySelector('[data-control="range"] .ant-select-selection-item').textContent = '教师';
                list.remove();
              };
              list.append(option);
              document.body.append(list);
            });
            document.querySelector('[data-control="keyword"]').addEventListener('input', event => {
              if (window.range !== '教师') return;
              const query = new URLSearchParams({nameOrCode: event.target.value, limitNum: '50', deptId: ''});
              fetch('/api/timetable/instructor/filter?' + query);
            });
            fetch('/api/timetable/instructor/filter?stale=1');
          </script></body></html>"""
        if bootstrap_script_delay_s:
            html = html.replace('<html><body>', '<html><head><script src="/bootstrap.js"></script></head><body>')
        if page_delay_ms:
            html = html.replace('<main aria-label="排课管理">', '<template id="delayed-controls"><main aria-label="排课管理">')
            html = html.replace('</main><script>', '</main></template><script>setTimeout(() => { const template = document.getElementById("delayed-controls"); template.replaceWith(template.content);')
            html = html.replace('</script>', '}, ' + str(page_delay_ms) + ');</script>')
        return __import__("aiohttp", fromlist=["web"]).web.Response(text=html, content_type="text/html")

    async def search(request):
        calls.append({"nameOrCode": request.query.get("nameOrCode"), "limit": request.query.get("limitNum")})
        if request.query.get("stale") == "1":
            await asyncio.sleep(0.25)
            return __import__("aiohttp", fromlist=["web"]).web.json_response([
                {"id": "teacher-stale", "name": "旧教师", "code": "90000", "certificate": "SECRET"}
            ])
        return __import__("aiohttp", fromlist=["web"]).web.json_response([
            {
                "id": f"teacher-{index}",
                "name": "张三",
                "code": f"1000{index}",
                "departmentName": "电气工程学院",
                "campusName": "A校区",
                "mobilePhone": "SECRET",
                "certificate": "SECRET",
            }
            for index in range(50)
        ], status=search_status)

    async def bootstrap(_request):
        await asyncio.sleep(bootstrap_script_delay_s)
        return __import__("aiohttp", fromlist=["web"]).web.Response(text="", content_type="application/javascript")

    app.router.add_get("/", page)
    app.router.add_get("/bootstrap.js", bootstrap)
    app.router.add_get("/api/resourceapi/session/info-detail", lambda _request: __import__("aiohttp", fromlist=["web"]).web.json_response({
        "curSessionId": "session-current",
        "sessionFinder": [{"id": "session-current", "name": "2026秋"}],
    }))
    app.router.add_get("/api/resourceapi/session/list", lambda _request: __import__("aiohttp", fromlist=["web"]).web.json_response({
        "sessionVOList": [{"id": "session-current", "year": "2026", "term": "秋"}],
    }))
    app.router.add_get("/api/timetable/instructor/filter", search)
    runner = __import__("aiohttp", fromlist=["web"]).web.AppRunner(app)
    await runner.setup()
    site = __import__("aiohttp", fromlist=["web"]).web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    address = site._server.sockets[0].getsockname()
    return runner, f"http://{address[0]}:{address[1]}", calls


def test_instructor_action_uses_visible_page_controls_and_safe_projection(monkeypatch, tmp_path):
    async def run():
        runner, origin, calls = await start_instructor_site(
            page_delay_ms=1500, bootstrap_reload=True, bootstrap_script_delay_s=16,
        )
        monkeypatch.setattr(cqu_external_search.browser_profile, "CLOUDFLARE_PROFILE", True)
        monkeypatch.setenv("CQU_CDP_RUNTIME_DIR", str(tmp_path))
        monkeypatch.setattr(cqu_external_search, "ALL_COURSE_URL", origin + "/")
        monkeypatch.setattr(cqu_external_search, "SESSION_INFO_URL", origin + "/api/resourceapi/session/info-detail")
        monkeypatch.setattr(cqu_external_search, "SESSION_LIST_URL", origin + "/api/resourceapi/session/list")
        try:
            result = await cqu_external_search.external_search(
                {"cookies": [], "origins": []},
                {
                    "action": "instructor_search",
                    "departmentId": "",
                    "departmentName": "",
                    "grade": "",
                    "keyword": "张",
                },
            )
            assert calls == [
                {"nameOrCode": None, "limit": None},
                {"nameOrCode": "张", "limit": "50"},
            ]
            assert len(result["items"]) == 50
            assert result["items"][0] == {
                "id": "teacher-0", "name": "张三", "extra": "10000 / 电气工程学院 / A校区"
            }
            assert result["truncated"] is True
            assert "SECRET" not in json.dumps(result, ensure_ascii=False)
        finally:
            await runner.cleanup()

    asyncio.run(run())


def test_real_browser_course_catalog_remains_reachable_at_shared_search_entry(monkeypatch, tmp_path):
    from test_course_teaching import start_site
    async def run():
        runner, origin, _calls = await start_site()
        monkeypatch.setenv("CQU_CDP_RUNTIME_DIR", str(tmp_path))
        monkeypatch.setattr(cqu_external_search, "ALL_COURSE_URL", origin + "/")
        try:
            result = await cqu_external_search.external_search({"cookies": [], "origins": []}, {"action": "course_catalog_search", "keyword": "高等"})
            assert result["sourceType"] == "course_catalog"
            assert [item["id"] for item in result["items"]] == ["course-other", "course-1"]
        finally:
            await runner.cleanup()
    asyncio.run(run())
