#!/usr/bin/env python3
"""External AllCourseSearch endpoint contract tests (no network or real browser)."""
import os
import sys
import asyncio
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
            <div class="ant-form-item"><label>查询范围</label><div class="ant-select" data-control="range"><div class="ant-select-selection-item">教师</div></div></div>
            <div class="ant-form-item"><label>学院</label><div class="ant-select" data-control="department"><div class="ant-select-selection-item">电气工程学院</div><span class="ant-select-clear">×</span></div></div>
            <div class="ant-form-item"><label>年级</label><div class="ant-select" data-control="grade"><div class="ant-select-selection-item">2025</div><span class="ant-select-clear">×</span></div></div>
            <label>班级名称</label><input class="ant-input" data-control="keyword" placeholder="请输入班级名称" value="">
            <button type="button">查询</button>
          </main><script>
            window.filters = {department: 'dept-ee', grade: '2025', keyword: ''};
            window.termTouched = false;
            document.querySelector('[aria-label="学期"]').addEventListener('click', () => { window.termTouched = true; });
            for (const control of document.querySelectorAll('.ant-select')) {
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
            });
            fetch('/api/timetable/admin-class/dept-admin-classes?stale=1', {
              method: 'POST', credentials: 'include', body: JSON.stringify(['stale-dept'])
            });
            document.querySelector('button').onclick = () => {
              const query = new URLSearchParams({grade: window.filters.grade, className: window.filters.keyword});
              fetch('/api/timetable/admin-class/dept-admin-classes?' + query, {
                method: 'POST', credentials: 'include', body: JSON.stringify(window.filters.department ? [window.filters.department] : [])
              });
            };
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
                assert calls[0]["body"] == '["stale-dept"]'
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
