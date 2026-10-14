#!/usr/bin/env python3
"""External admin-class capture contract and real browser-action tests."""
import asyncio
import json
import os
import sys
import urllib.parse
from unittest.mock import Mock

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from aiohttp import web
from aiohttp.test_utils import AioHTTPTestCase
from posthog_client import POSTHOG_CLIENT_KEY

import chromium_session
import server


def fixed_recipe():
    return {
        "action": "admin_class_capture",
        "sourceType": "admin_class",
        "targetId": "class-1",
        "targetName": "电气工程2026-01班",
        "expectedSessionId": "",
    }


def instructor_recipe():
    return {
        "action": "instructor_capture",
        "sourceType": "instructor",
        "targetId": "teacher-1",
        "targetName": "张三",
        "expectedSessionId": "",
    }


def valid_result():
    return {
        "contractVersion": 1,
        "sourceType": "admin_class",
        "target": {"id": "class-1", "name": "电气工程2026-01班"},
        "session": {"id": "session-current", "name": "2026秋", "beginDate": "2026-09-07"},
        "timetable": {
            "classTimetableVOList": [{
                "courseName": "高等数学",
                "instructorName": "教师",
                "roomName": "D101",
                "position": "1",
                "campusName": "A校区",
                "weekDay": 1,
                "teachingWeek": "110",
                "period": "101",
                "assignTeachingObject": [{"adminClassId": "class-1"}],
            }],
            "maxSection": 12,
        },
    }


def valid_instructor_result():
    return {
        "contractVersion": 1,
        "sourceType": "instructor",
        "target": {"id": "teacher-1", "name": "张三"},
        "session": {"id": "session-current", "name": "2026秋", "beginDate": "2026-09-07"},
        "timetable": {
            "classTimetableVOList": [{
                "courseName": "高等数学",
                "instructorName": "张三",
                "roomName": "D101",
                "position": "1",
                "campusName": "A校区",
                "weekDay": 1,
                "teachingWeek": "110",
                "period": "101",
                "instructorIdList": ["teacher-other", "teacher-1"],
            }],
            "maxSection": 12,
        },
    }


class ExternalCaptureTestCase(AioHTTPTestCase):
    async def get_application(self):
        app = server.build_app()
        app[POSTHOG_CLIENT_KEY] = Mock()
        return app

    def setUp(self):
        super().setUp()
        self.original_capture = server.cqu_external_capture.external_capture

    def tearDown(self):
        server.cqu_external_capture.external_capture = self.original_capture
        super().tearDown()

    async def test_fixed_recipe_reaches_browser_action_and_result_is_rebuilt(self):
        async def fake_capture(state, recipe):
            assert state == {"cookies": [], "origins": []}
            assert recipe == fixed_recipe()
            return valid_result()

        server.cqu_external_capture.external_capture = fake_capture
        response = await self.client.post("/external-capture", json={
            "state": {"cookies": [], "origins": []},
            **fixed_recipe(),
        })
        assert response.status == 200
        assert await response.json() == {"ok": True, **valid_result()}
        assert "SECRET" not in await response.text()

    async def test_transport_overrides_are_rejected_before_browser_action(self):
        async def unreachable(*_args, **_kwargs):
            raise AssertionError("browser action must not run")

        server.cqu_external_capture.external_capture = unreachable
        for override in (
            {"url": "https://example.com"},
            {"selector": "#arbitrary"},
            {"httpBody": ["class-1"]},
            {"method": "POST"},
        ):
            response = await self.client.post("/external-capture", json={
                "state": {"cookies": [], "origins": []},
                **fixed_recipe(),
                **override,
            })
            assert response.status == 400, override
            assert await response.json() == {"ok": False, "error": "recipe not allowed"}

    async def test_external_capture_reports_bounded_business_telemetry(self):
        async def fake_capture(_state, _recipe):
            return valid_result()

        server.cqu_external_capture.external_capture = fake_capture
        response = await self.client.post("/external-capture", json={
            "state": {"cookies": [], "origins": []},
            **fixed_recipe(),
        })
        assert response.status == 200
        client = self.client.app[POSTHOG_CLIENT_KEY]
        client.capture.assert_called_once()
        properties = client.capture.call_args.kwargs["properties"]
        assert properties["operation"] == "external_capture"
        assert properties["business_outcome"] == "success"
        assert properties["http_outcome"] == "success"

    async def test_fixed_instructor_recipe_reaches_browser_action_and_result_is_rebuilt(self):
        async def fake_capture(state, recipe):
            assert state == {"cookies": [], "origins": []}
            assert recipe == instructor_recipe()
            return valid_instructor_result()

        server.cqu_external_capture.external_capture = fake_capture
        response = await self.client.post("/external-capture", json={
            "state": {"cookies": [], "origins": []},
            **instructor_recipe(),
        })
        assert response.status == 200
        assert await response.json() == {"ok": True, **valid_instructor_result()}
        assert "SECRET" not in await response.text()


PAGE_HTML = """<!doctype html><html><body>
  <main aria-label="排课管理">
    <div class="ant-select ant-select-disabled" aria-label="学期"><div class="ant-select-selection-item">2026年秋</div></div>
    <div><span>查询范围：</span><div class="ant-select" data-control="range"><div class="ant-select-selection-item">教师</div></div></div>
    <div><span>学院：</span><div class="ant-select" data-control="department"><div class="ant-select-selection-item">全部</div><span class="ant-select-clear" style="display:none">×</span></div></div>
    <div><span>年级：</span><div class="ant-select" data-control="grade"><div class="ant-select-selection-item">2025</div><span class="ant-select-clear">×</span></div></div>
    <div class="ant-select"><span class="ant-select-selection__choice"><span class="ant-select-selection__choice__content">旧目标</span><span class="ant-select-selection__choice__remove">×</span></span></div>
    <div class="keyword-control"><div class="ant-select"><div class="ant-select-selection__placeholder">请输入行政班名字快速查询</div><input class="ant-input ant-select-search__field" data-control="keyword" value=""></div></div>
    <button type="button">查询</button>
  </main><script>
    window.filters = {department: '', grade: '2025', keyword: ''};
    window.termTouched = false;
    window.targetCleared = false;
    document.querySelector('.ant-select-selection__choice__remove').onclick = () => {
      window.targetCleared = true;
      document.querySelector('.ant-select-selection__choice').remove();
    };
    document.querySelector('[aria-label="学期"]').addEventListener('click', () => { window.termTouched = true; });
    for (const control of document.querySelectorAll('.ant-select')) {
      if (control.closest('.keyword-control') || !control.dataset.control) continue;
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
    document.querySelector('[data-control="keyword"]').addEventListener('input', async event => {
      window.filters.keyword = event.target.value;
      fetch('/api/timetable/class/timetable/adminClass/table-detail?sessionId=session-current', {
        method: 'POST', credentials: 'include', body: JSON.stringify(['class-stale'])
      });
      const query = new URLSearchParams({grade: window.filters.grade, className: window.filters.keyword});
      await fetch('/api/timetable/admin-class/dept-admin-classes?' + query, {
        method: 'POST', credentials: 'include',
        body: JSON.stringify(window.filters.department ? [window.filters.department] : [])
      });
      const response = await fetch('/candidates.json');
      const items = await response.json();
      const list = document.createElement('div');
      list.className = 'ant-select-dropdown';
      list.setAttribute('role', 'listbox');
      for (const item of items) {
        const option = document.createElement('div');
        option.className = 'ant-select-item-option';
        option.setAttribute('role', 'option');
        option.dataset.value = item.id;
        option.title = item.className;
        option.textContent = item.className;
        option.onclick = () => {
          fetch('/api/timetable/class/timetable/adminClass/table-detail?sessionId=session-current', {
            method: 'POST', credentials: 'include', body: JSON.stringify([item.id])
          });
        };
        list.append(option);
      }
      document.body.append(list);
     });
  </script></body></html>"""


async def start_capture_site(*, table_body=None, search_items=None, table_status=200, change_session_after_capture=False):
    if search_items is None:
        search_items = [
            {"id": "class-other", "className": "电气工程2026-02班"},
            {"id": "class-1", "className": "电气工程2026-01班"},
        ]
    default_table = {
        "classTimetableVOList": [{
            "courseName": "高等数学", "instructorName": "教师", "roomName": "D101",
            "position": "1", "campusName": "A校区", "weekDay": 1, "teachingWeek": "110",
            "period": "101", "bearer": "SECRET",
            "assignTeachingObject": [{"adminClassId": "class-1", "secret": "SECRET"}],
        }],
        "maxSection": 12,
    }
    app = web.Application()
    calls = {"search": [], "table": []}

    async def page(_request):
        return web.Response(text=PAGE_HTML, content_type="text/html")

    async def candidates(_request):
        return web.json_response(search_items)

    async def session_info(_request):
        return web.json_response({
            "curSessionId": "session-next" if change_session_after_capture and '["class-1"]' in calls["table"] else "session-current",
            "sessionFinder": [{"id": "session-current", "name": "2026秋"}],
        })

    async def session_list(_request):
        return web.json_response({
            "sessionVOList": [{
                "id": "session-current", "year": "2026", "term": "秋", "beginDate": "2026-09-07",
            }],
        })

    async def search(request):
        calls["search"].append({
            "body": await request.text(),
            "grade": request.query.get("grade"),
            "keyword": request.query.get("className"),
        })
        return web.json_response(search_items)

    async def table(request):
        body = await request.text()
        calls["table"].append(body)
        if body != '["class-1"]':
            await asyncio.sleep(0.75)
            return web.json_response({
                "classTimetableVOList": [{
                    "courseName": "旧数据",
                    "assignTeachingObject": [{"adminClassId": "class-old"}],
                }],
                "maxSection": 12,
            })
        await asyncio.sleep(0.9)
        return web.json_response(default_table if table_body is None else table_body, status=table_status)

    app.router.add_get("/", page)
    app.router.add_get("/candidates.json", candidates)
    app.router.add_get("/api/resourceapi/session/info-detail", session_info)
    app.router.add_get("/api/resourceapi/session/list", session_list)
    app.router.add_post("/api/timetable/admin-class/dept-admin-classes", search)
    app.router.add_post("/api/timetable/class/timetable/adminClass/table-detail", table)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    address = site._server.sockets[0].getsockname()
    return runner, f"http://{address[0]}:{address[1]}", calls


def run_real_browser(monkeypatch, tmp_path, table_marker=None, recipe=None, **site_kwargs):
    async def run():
        import cqu_external_capture
        runner, origin, calls = await start_capture_site(**site_kwargs)
        monkeypatch.setenv("CQU_CDP_RUNTIME_DIR", str(tmp_path))
        monkeypatch.setattr(cqu_external_capture, "ALL_COURSE_URL", origin + "/")
        if table_marker is not None:
            monkeypatch.setattr(cqu_external_capture, "ADMIN_TABLE_MARKER", table_marker)
        try:
            async with chromium_session.ChromiumSession() as browser:
                await browser.navigate(origin + "/", timeout_s=5)
                result = await cqu_external_capture.capture_admin_class(browser, recipe or fixed_recipe())
                term_touched = await browser.evaluate("window.termTouched")
                target_cleared = await browser.evaluate("window.targetCleared")
                return result, calls, term_touched, target_cleared
        finally:
            await runner.cleanup()

    return asyncio.run(run())


def test_real_browser_capture_selects_exact_id_and_sanitizes(monkeypatch, tmp_path):
    result, calls, term_touched, target_cleared = run_real_browser(monkeypatch, tmp_path)
    assert result == valid_result()
    assert calls["search"] == [{
        "body": "[]", "grade": "", "keyword": "电气工程2026-01班",
    }]
    assert calls["table"] == ['["class-stale"]', '["class-1"]']
    assert term_touched is False
    assert target_cleared is True


def test_real_browser_accepts_valid_empty_timetable(monkeypatch, tmp_path):
    result, _calls, _term_touched, _target_cleared = run_real_browser(
        monkeypatch, tmp_path, table_body={"classTimetableVOList": [], "maxSection": 12}
    )
    assert result == {
        **valid_result(),
        "timetable": {"classTimetableVOList": [], "maxSection": 12},
    }
    assert result["timetable"]["classTimetableVOList"] == []


def test_real_browser_preserves_owned_bad_content_as_adapter_skip_marker(monkeypatch, tmp_path):
    valid_row = {
        "courseName": "高等数学", "instructorName": "教师", "roomName": "D101",
        "position": "1", "campusName": "A校区", "weekDay": 1, "teachingWeek": "110",
        "period": "101", "assignTeachingObject": [{"adminClassId": "class-1"}],
    }
    result, _calls, _term_touched, _target_cleared = run_real_browser(
        monkeypatch,
        tmp_path,
        table_body={
            "classTimetableVOList": [
                valid_row,
                {**valid_row, "courseName": "不可验证课程", "instructorName": 42},
            ],
            "maxSection": 12,
        },
    )
    assert result["timetable"]["classTimetableVOList"] == [
        valid_result()["timetable"]["classTimetableVOList"][0],
        {"assignTeachingObject": [{"adminClassId": "class-1"}]},
    ]


def test_real_browser_rejects_unknown_timetable_arrays(monkeypatch, tmp_path):
    with pytest.raises(Exception) as raised:
        run_real_browser(monkeypatch, tmp_path, table_body={
            "classTimetableVOList": [], "maxSection": 12, "unknownBusinessRows": [],
        })
    assert getattr(raised.value, "code", None) == "SCHEMA_INVALID"


def test_real_browser_enforces_expected_current_session(monkeypatch, tmp_path):
    with pytest.raises(Exception) as raised:
        run_real_browser(monkeypatch, tmp_path, recipe={
            **fixed_recipe(), "expectedSessionId": "session-old",
        })
    assert getattr(raised.value, "code", None) == "CURRENT_SESSION_CHANGED"


def test_real_browser_missing_or_out_of_order_table_capture_fails(monkeypatch, tmp_path):
    with pytest.raises(Exception) as raised:
        run_real_browser(
            monkeypatch,
            tmp_path,
            table_marker="/api/timetable/class/timetable/not-captured",
        )
    assert getattr(raised.value, "code", None) == "CAPTURE_MISSING"


@pytest.mark.parametrize(
    ("items", "code"),
    [
        ([{"id": "other", "className": "电气工程2026-01班"}], "TARGET_NOT_FOUND"),
        ([
            {"id": "class-1", "className": "wrong"},
            {"id": "class-1", "className": "电气工程2026-01班"},
        ], "AMBIGUOUS_TARGET"),
    ],
)
def test_real_browser_rejects_missing_or_ambiguous_target(monkeypatch, tmp_path, items, code):
    with pytest.raises(Exception) as raised:
        run_real_browser(monkeypatch, tmp_path, search_items=items)
    assert getattr(raised.value, "code", None) == code


def test_real_browser_rejects_stale_or_unowned_table_body(monkeypatch, tmp_path):
    with pytest.raises(Exception) as raised:
        run_real_browser(monkeypatch, tmp_path, table_body={
            "classTimetableVOList": [{
                "courseName": "旧数据",
                "assignTeachingObject": [{"adminClassId": "class-old"}],
            }],
            "maxSection": 12,
        })
    assert getattr(raised.value, "code", None) == "SCHEMA_INVALID"


def test_real_browser_rejects_term_change_during_capture(monkeypatch, tmp_path):
    with pytest.raises(Exception) as raised:
        run_real_browser(monkeypatch, tmp_path, change_session_after_capture=True)
    assert getattr(raised.value, "code", None) == "CURRENT_SESSION_CHANGED"


INSTRUCTOR_CAPTURE_HTML = """<!doctype html><html><body>
  <main aria-label="排课管理">
    <div class="ant-select ant-select-disabled" aria-label="学期"><div class="ant-select-selection-item">2026年秋</div></div>
    <div><span>查询范围：</span><div class="ant-select" data-control="range"><div class="ant-select-selection-item">行政班</div></div></div>
    <div class="ant-select"><span class="ant-select-selection__choice"><span class="ant-select-selection__choice__content">旧目标</span><span class="ant-select-selection__choice__remove">×</span></span></div>
    <div class="target-control"><div class="ant-select"><div class="ant-select-selection__placeholder">请输入教师姓名或工号</div><input class="ant-input ant-select-search__field" data-control="keyword" placeholder="请输入教师姓名或工号" value=""></div></div>
  </main><script>
    window.range = '行政班';
    window.termTouched = false;
    window.targetCleared = false;
    document.querySelector('.ant-select-selection__choice__remove').onclick = () => {
      window.targetCleared = true;
      document.querySelector('.ant-select-selection__choice').remove();
    };
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
    document.querySelector('[data-control="keyword"]').addEventListener('input', async event => {
      if (window.range !== '教师') return;
      fetch('/api/timetable/class/timetable/instructor/table-detail?sessionId=session-current', {
        method: 'POST', credentials: 'include', body: JSON.stringify(['teacher-old'])
      });
      const query = new URLSearchParams({nameOrCode: event.target.value, limitNum: '50', deptId: ''});
      const response = await fetch('/api/timetable/instructor/filter?' + query);
      const items = await response.json();
      const list = document.createElement('div');
      list.className = 'ant-select-dropdown';
      list.setAttribute('role', 'listbox');
      for (const item of items) {
        const option = document.createElement('div');
        option.className = 'ant-select-item-option';
        option.setAttribute('role', 'option');
        option.dataset.value = item.id;
        option.title = item.name;
        option.textContent = item.name;
        option.onclick = () => {
          fetch('/api/timetable/class/timetable/instructor/table-detail?sessionId=session-current', {
            method: 'POST', credentials: 'include', body: JSON.stringify([item.id])
          });
        };
        list.append(option);
      }
      document.body.append(list);
    });
  </script></body></html>"""


async def start_instructor_capture_site(*, table_body=None, search_items=None, expose_identity=True):
    if search_items is None:
        search_items = [
            {"id": "teacher-other", "name": "张三", "code": "10002", "departmentName": "电气工程学院", "campusName": "A校区", "mobilePhone": "SECRET"},
            {"id": "teacher-1", "name": "张三", "code": "10001", "departmentName": "电气工程学院", "campusName": "A校区", "mobilePhone": "SECRET"},
        ]
    default_table = {
        "classTimetableVOList": [{
            "courseName": "高等数学", "instructorName": "张三", "roomName": "D101",
            "position": "1", "campusName": "A校区", "weekDay": 1, "teachingWeek": "110",
            "period": "101", "mobilePhone": "SECRET",
            "instructorIdList": ["teacher-other", "teacher-1"],
        }],
        "maxSection": 12,
    }
    app = web.Application()
    calls = {"search": [], "table": []}

    async def page(_request):
        return web.Response(text=INSTRUCTOR_CAPTURE_HTML if expose_identity else INSTRUCTOR_CAPTURE_HTML.replace("option.dataset.value = item.id;", ""), content_type="text/html")

    async def session_info(_request):
        return web.json_response({
            "curSessionId": "session-current",
            "sessionFinder": [{"id": "session-current", "name": "2026秋"}],
        })

    async def session_list(_request):
        return web.json_response({
            "sessionVOList": [{
                "id": "session-current", "year": "2026", "term": "秋", "beginDate": "2026-09-07",
            }],
        })

    async def search(request):
        calls["search"].append({
            "keyword": request.query.get("nameOrCode"),
            "limit": request.query.get("limitNum"),
        })
        return web.json_response(search_items)

    async def table(request):
        body = await request.text()
        calls["table"].append(body)
        if body != '["teacher-1"]':
            await asyncio.sleep(0.75)
            return web.json_response({
                "classTimetableVOList": [{
                    "courseName": "旧数据",
                    "instructorIdList": ["teacher-old"],
                }],
                "maxSection": 12,
            })
        await asyncio.sleep(0.9)
        return web.json_response(default_table if table_body is None else table_body)

    app.router.add_get("/", page)
    app.router.add_get("/api/resourceapi/session/info-detail", session_info)
    app.router.add_get("/api/resourceapi/session/list", session_list)
    app.router.add_get("/api/timetable/instructor/filter", search)
    app.router.add_post("/api/timetable/class/timetable/instructor/table-detail", table)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    address = site._server.sockets[0].getsockname()
    return runner, f"http://{address[0]}:{address[1]}", calls


def test_real_browser_instructor_capture_selects_exact_id_and_sanitizes(monkeypatch, tmp_path):
    async def run():
        import cqu_external_capture
        runner, origin, calls = await start_instructor_capture_site()
        monkeypatch.setenv("CQU_CDP_RUNTIME_DIR", str(tmp_path))
        monkeypatch.setattr(cqu_external_capture, "ALL_COURSE_URL", origin + "/")
        try:
            async with chromium_session.ChromiumSession() as browser:
                await browser.navigate(origin + "/", timeout_s=5)
                result = await cqu_external_capture.capture_instructor(browser, instructor_recipe())
                term_touched = await browser.evaluate("window.termTouched")
                target_cleared = await browser.evaluate("window.targetCleared")
        finally:
            await runner.cleanup()
        assert result == valid_instructor_result()
        assert calls["search"] == [{"keyword": "张三", "limit": "50"}]
        assert calls["table"] == ['["teacher-old"]', '["teacher-1"]']
        assert term_touched is False
        assert target_cleared is True
        assert "SECRET" not in json.dumps(result, ensure_ascii=False)

    asyncio.run(run())


def test_real_browser_accepts_valid_empty_instructor_timetable(monkeypatch, tmp_path):
    async def run():
        import cqu_external_capture
        runner, origin, _calls = await start_instructor_capture_site(
            table_body={"classTimetableVOList": [], "maxSection": 12},
        )
        monkeypatch.setenv("CQU_CDP_RUNTIME_DIR", str(tmp_path))
        monkeypatch.setattr(cqu_external_capture, "ALL_COURSE_URL", origin + "/")
        try:
            async with chromium_session.ChromiumSession() as browser:
                await browser.navigate(origin + "/", timeout_s=5)
                result = await cqu_external_capture.capture_instructor(browser, instructor_recipe())
        finally:
            await runner.cleanup()
        assert result == {
            **valid_instructor_result(),
            "timetable": {"classTimetableVOList": [], "maxSection": 12},
        }

    asyncio.run(run())


def test_real_browser_same_name_without_visible_identity_fails_without_selecting(monkeypatch, tmp_path):
    async def run():
        import cqu_external_capture
        runner, origin, calls = await start_instructor_capture_site(expose_identity=False)
        monkeypatch.setenv("CQU_CDP_RUNTIME_DIR", str(tmp_path))
        try:
            async with chromium_session.ChromiumSession() as browser:
                await browser.navigate(origin + "/", timeout_s=5)
                with pytest.raises(cqu_external_capture.ExternalCaptureTransientError) as raised:
                    await cqu_external_capture.capture_instructor(browser, instructor_recipe())
                assert raised.value.code == "AMBIGUOUS_TARGET"
                assert '["teacher-1"]' not in calls["table"]
                assert '["teacher-other"]' not in calls["table"]
        finally:
            await runner.cleanup()
    asyncio.run(run())
