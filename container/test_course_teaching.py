#!/usr/bin/env python3
"""Course catalog and teaching-class fixed browser-action tests."""
import asyncio
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from aiohttp import web

import chromium_session
import cqu_course_teaching


def catalog_recipe():
    return {"action": "course_catalog_search", "keyword": "高等数学"}


def class_recipe():
    return {
        "action": "teaching_class_search",
        "courseId": "course-1",
        "courseName": "高等数学",
        "expectedSessionId": "session-current",
    }


def capture_recipe():
    return {
        "action": "teaching_class_capture",
        "targetId": "class-1",
        "targetName": "高等数学01班",
        "courseId": "course-1",
        "courseName": "高等数学",
        "expectedSessionId": "session-current",
    }


PAGE_HTML = """<!doctype html><html><body>
  <main aria-label="排课管理">
    <div class="ant-select ant-select-disabled" aria-label="学期"><div class="ant-select-selection-item">2026年秋</div></div>
    <div><span>查询范围：</span><div class="ant-select" data-control="range"><div class="ant-select-selection-item">教师</div></div></div>
    <div class="target-control"><div class="ant-select"><span class="ant-select-selection__placeholder">请输入目标快速查询</span><input data-control="keyword"></div></div>
  </main><script>
    window.state = {range: '教师', keyword: '', selectedCourse: null};
    window.termTouched = false;
    document.querySelector('[aria-label="学期"]').onclick = () => { window.termTouched = true; };
    document.querySelector('[data-control="range"]').onclick = () => {
      const options = ['课程'];
      const list = document.createElement('div');
      list.className = 'ant-select-dropdown';
      for (const text of options) {
        const option = document.createElement('div');
        option.className = 'ant-select-item-option';
        option.textContent = text;
        option.onclick = () => {
          window.state.range = text;
          document.querySelector('[data-control="range"] .ant-select-selection-item').textContent = text;
          list.remove();
        };
        list.append(option);
      }
      document.body.append(list);
    };
    document.querySelector('[data-control="keyword"]').addEventListener('input', event => {
      window.state.keyword = event.target.value;
      const query = new URLSearchParams({nameOrCode: window.state.keyword, pageSize: '50', sessionId: 'session-current'});
      fetch('/api/timetable/course/info-by-name-or-code?' + query, {credentials: 'include'}).then(r => r.json()).then(r => window.showCourses(r.data));
    });
    window.showCourses = items => {
      const list = document.createElement('div');
      list.className = 'ant-select-dropdown';
      list.setAttribute('role', 'listbox');
      for (const item of items) {
        const option = document.createElement('div');
        option.className = 'ant-select-item-option';
        option.setAttribute('role', 'option');
        option.dataset.value = item.id;
        option.textContent = item.name;
        option.onclick = () => {
          window.state.selectedCourse = item.id;
          const query = new URLSearchParams({courseId: item.id, sessionId: 'session-current'});
          list.remove();
          Promise.all([
            fetch('/api/timetable/optionFinder/expr-prj?courseId=' + item.id, {credentials:'include'}).then(r => r.json()),
            fetch('/api/timetable/course/search-class-by-courseId?' + query, {credentials:'include'}).then(r => r.json())
          ]).then(([projects, classes]) => {
            window.showClasses(classes);
            fetch('/api/timetable/class/timetable/expr-prj/table-detail?sessionId=session-current', {
              method:'POST', credentials:'include', body:JSON.stringify(projects.filter(p => p.id).map(p => p.id))
            }).then(() => fetch('/api/timetable/class/timetable/course/table-detail?sessionId=session-current', {
              method:'POST', credentials:'include', body:JSON.stringify(classes.map(c => c.id))
            }));
          });
        };
        list.append(option);
      }
      document.body.append(list);
    };
    window.showClasses = items => {
      const list = document.createElement('div');
      list.className = 'ant-select-dropdown';
      list.setAttribute('role', 'listbox');
      for (const item of items) {
        const option = document.createElement('div');
        option.className = 'ant-select-item-option';
        option.setAttribute('role', 'option');
        option.dataset.value = item.id;
        option.textContent = item.name;
        option.onclick = () => {
          fetch('/api/timetable/class/timetable/expr-prj/table-detail?sessionId=session-current', {
            method: 'POST', credentials: 'include', body: JSON.stringify(item.experimentProjectIds || [])
          });
          fetch('/api/timetable/class/timetable/course/table-detail?sessionId=session-current', {
            method: 'POST', credentials: 'include', body: JSON.stringify([item.id])
          });
        };
        list.append(option);
      }
      document.body.append(list);
    };
  </script></body></html>"""


def course_rows():
    return [
        {"id": "course-other", "name": "高等数学（其他）", "code": "OTHER", "secret": "SECRET"},
        {"id": "course-1", "name": "高等数学", "code": "MATH101", "secret": "SECRET"},
    ]


def class_rows():
    return [
        {"id": "class-other", "name": "高等数学02班", "classNbr": "02", "teacherName": "其他教师", "secret": "SECRET"},
        {"id": "class-1", "name": "高等数学01班", "classNbr": "01", "teacherName": "主讲教师", "secret": "SECRET"},
    ]


async def start_site(*, catalog_status=200, class_status=200, expr_body=None, course_body=None, omit_expr=False, projects=None, wrong_class_body=False, wrong_project_body=False):
    app = web.Application()
    calls = {"catalog": [], "classes": [], "expr": [], "course": []}

    async def page(_request):
        html = PAGE_HTML
        if omit_expr:
            html = html.replace("fetch('/api/timetable/class/timetable/expr-prj/table-detail?sessionId=session-current', {", "fetch('/ignored', {")
        if wrong_class_body:
            html = html.replace("JSON.stringify(classes.map(c => c.id))", "JSON.stringify(['class-1'])")
        if wrong_project_body:
            html = html.replace("JSON.stringify(projects.filter(p => p.id).map(p => p.id))", "JSON.stringify([])")
        return web.Response(text=html, content_type="text/html")

    async def session_info(_request):
        return web.json_response({"curSessionId": "session-current"})

    async def session_list(_request):
        return web.json_response({"sessionVOList": [{
            "id": "session-current", "year": "2026", "term": "秋", "beginDate": "2026-09-07",
        }]})

    async def catalog(request):
        calls["catalog"].append({
            "keyword": request.query.get("nameOrCode"),
            "pageSize": request.query.get("pageSize"),
            "sessionId": request.query.get("sessionId"),
        })
        return web.json_response(
            {"status": 200, "data": course_rows()},
            status=catalog_status,
        )

    async def classes(request):
        calls["classes"].append({
            "courseId": request.query.get("courseId"),
            "sessionId": request.query.get("sessionId"),
        })
        return web.json_response(class_rows(), status=class_status)

    async def expr_table(request):
        calls["expr"].append(await request.text())
        return web.json_response(expr_body if expr_body is not None else {
            "classTimetableVOList": [], "maxSection": 12,
        })

    async def course_table(request):
        calls["course"].append(await request.text())
        return web.json_response(course_body if course_body is not None else {
            "classTimetableVOList": [
                {
                    "classId": "class-other", "courseName": "其他班级课程", "secret": "SECRET",
                },
                {
                    "classId": "class-1", "courseName": "高等数学", "instructorName": "主讲教师",
                    "roomName": "D101", "position": "1", "campusName": "A校区", "weekDay": 1,
                    "teachingWeek": "110", "period": "101", "secret": "SECRET",
                },
            ],
            "maxSection": 12,
        })

    app.router.add_get("/", page)
    app.router.add_get("/api/resourceapi/session/info-detail", session_info)
    app.router.add_get("/api/resourceapi/session/list", session_list)
    app.router.add_get("/api/timetable/course/info-by-name-or-code", catalog)
    app.router.add_get("/api/timetable/course/search-class-by-courseId", classes)
    async def project_finder(_request):
        return web.json_response(projects if projects is not None else [])
    app.router.add_get("/api/timetable/optionFinder/expr-prj", project_finder)
    app.router.add_post("/api/timetable/class/timetable/expr-prj/table-detail", expr_table)
    app.router.add_post("/api/timetable/class/timetable/course/table-detail", course_table)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    address = site._server.sockets[0].getsockname()
    return runner, f"http://{address[0]}:{address[1]}", calls


def run_browser(monkeypatch, tmp_path, action, **site_kwargs):
    async def run():
        runner, origin, calls = await start_site(**site_kwargs)
        monkeypatch.setenv("CQU_CDP_RUNTIME_DIR", str(tmp_path))
        try:
            async with chromium_session.ChromiumSession() as browser:
                await browser.navigate(origin + "/", timeout_s=5)
                result = await action(browser)
                return result, calls, await browser.evaluate("window.termTouched")
        finally:
            await runner.cleanup()

    return asyncio.run(run())


def test_real_chromium_catalog_search_is_typed_and_request_correlated(monkeypatch, tmp_path):
    result, calls, term_touched = run_browser(
        monkeypatch,
        tmp_path,
        lambda browser: cqu_course_teaching.search_course_catalog(browser, catalog_recipe()),
    )
    assert result == {
        "contractVersion": 1,
        "sourceType": "course_catalog",
        "session": {"id": "session-current", "name": "2026秋"},
        "items": [{"id": "course-other", "name": "高等数学（其他）", "extra": "OTHER"}, {"id": "course-1", "name": "高等数学", "extra": "MATH101"}],
        "truncated": False,
    }
    assert calls["catalog"] == [{
        "keyword": "高等数学", "pageSize": "50", "sessionId": "session-current",
    }]
    assert term_touched is False
    assert "SECRET" not in str(result)


def test_real_chromium_teaching_search_requires_course_and_current_session(monkeypatch, tmp_path):
    result, calls, term_touched = run_browser(
        monkeypatch,
        tmp_path,
        lambda browser: cqu_course_teaching.search_teaching_classes(browser, class_recipe()),
    )
    assert result == {
        "contractVersion": 1,
        "sourceType": "course",
        "session": {"id": "session-current", "name": "2026秋"},
        "course": {"id": "course-1", "name": "高等数学"},
        "items": [{"id": "class-other", "name": "高等数学02班", "extra": "02班 / 其他教师"}, {"id": "class-1", "name": "高等数学01班", "extra": "01班 / 主讲教师"}],
        "truncated": False,
    }
    assert calls["classes"] == [{"courseId": "course-1", "sessionId": "session-current"}]
    assert term_touched is False
    assert "SECRET" not in str(result)

    stale = {**class_recipe(), "expectedSessionId": "session-old"}
    with pytest.raises(Exception) as raised:
        run_browser(monkeypatch, tmp_path, lambda browser: cqu_course_teaching.search_teaching_classes(browser, stale))
    assert getattr(raised.value, "code", None) == "CURRENT_SESSION_CHANGED"


def test_real_chromium_capture_requires_both_responses_and_filters_mixed_classes(monkeypatch, tmp_path):
    result, calls, term_touched = run_browser(
        monkeypatch,
        tmp_path,
        lambda browser: cqu_course_teaching.capture_teaching_class(browser, capture_recipe()),
    )
    assert result == {
        "contractVersion": 1,
        "sourceType": "course",
        "target": {"id": "class-1", "name": "高等数学01班"},
        "course": {"id": "course-1", "name": "高等数学"},
        "session": {"id": "session-current", "name": "2026秋", "beginDate": "2026-09-07"},
        "timetable": {
            "classTimetableVOList": [{
                "classId": "class-1", "courseName": "高等数学", "instructorName": "主讲教师",
                "roomName": "D101", "position": "1", "campusName": "A校区", "weekDay": 1,
                "teachingWeek": "110", "period": "101",
            }],
            "maxSection": 12,
        },
    }
    assert calls["expr"] == ["[]"]
    assert calls["course"] == ['["class-other","class-1"]']
    assert term_touched is False
    assert "SECRET" not in str(result)


def test_real_chromium_missing_experiment_capture_fails(monkeypatch, tmp_path):
    async def action(browser):
        return await cqu_course_teaching.capture_teaching_class(browser, capture_recipe())

    with pytest.raises(Exception) as raised:
        run_browser(monkeypatch, tmp_path, action, omit_expr=True)
    assert getattr(raised.value, "code", None) == "CAPTURE_MISSING"

@pytest.mark.parametrize('field', ['courseId', 'courseName', 'expectedSessionId'])
def test_course_capture_requires_parent_and_current_term(field):
    recipe = {**capture_recipe(), 'sourceType': 'course'}
    del recipe[field]
    with pytest.raises(ValueError):
        cqu_course_teaching.parse_course_recipe(recipe)


@pytest.mark.parametrize('field,value', [('url', 'https://elsewhere.example'), ('method', 'POST'), ('body', ['class-other']), ('selector', '#semester')])
def test_course_recipes_reject_transport_controls(field, value):
    recipe = {**capture_recipe(), 'sourceType': 'course', field: value}
    with pytest.raises(ValueError):
        cqu_course_teaching.parse_course_recipe(recipe)


def test_real_chromium_empty_tables_are_valid(monkeypatch, tmp_path):
    empty = {'classTimetableVOList': [], 'maxSection': 12}
    result, _, _ = run_browser(monkeypatch, tmp_path,
        lambda browser: cqu_course_teaching.capture_teaching_class(browser, capture_recipe()),
        course_body=empty, expr_body=empty)
    assert result['timetable'] == empty


def test_real_chromium_owned_bad_content_keeps_partial_marker(monkeypatch, tmp_path):
    result, _, _ = run_browser(monkeypatch, tmp_path,
        lambda browser: cqu_course_teaching.capture_teaching_class(browser, capture_recipe()),
        course_body={'classTimetableVOList': [{'classId': 'class-1', 'courseName': {'bad': 'shape'}}], 'maxSection': 12})
    assert result['timetable']['classTimetableVOList'] == [{'classId': 'class-1'}]


def test_real_chromium_missing_row_ownership_fails_whole_capture(monkeypatch, tmp_path):
    with pytest.raises(Exception) as raised:
        run_browser(monkeypatch, tmp_path,
            lambda browser: cqu_course_teaching.capture_teaching_class(browser, capture_recipe()),
            course_body={'classTimetableVOList': [{'courseName': '高等数学'}], 'maxSection': 12})
    assert raised.value.code == 'SCHEMA_INVALID'


def test_real_chromium_ordinary_experiment_name_and_string_day_are_preserved(monkeypatch, tmp_path):
    result, _, _ = run_browser(monkeypatch, tmp_path,
        lambda browser: cqu_course_teaching.capture_teaching_class(browser, capture_recipe()),
        course_body={'classTimetableVOList': [{'classId':'class-1', 'courseName':'大学物理实验（II）', 'exprProjectName':'Photoelectric effect ', 'weekDay':'4', 'teachingWeek':'00000001', 'period':'000001111'}], 'maxSection':13},
        expr_body={'classTimetableVOList':[], 'maxSection':13})
    assert result['timetable']['classTimetableVOList'] == [{'classId':'class-1', 'courseName':'大学物理实验（II）', 'exprProjectName':'Photoelectric effect ', 'weekDay':4, 'teachingWeek':'00000001', 'period':'000001111'}]


def test_real_chromium_project_finder_ids_bind_nonempty_post_and_empty_response(monkeypatch, tmp_path):
    result, calls, term_touched = run_browser(monkeypatch, tmp_path,
        lambda browser: cqu_course_teaching.capture_teaching_class(browser, capture_recipe()),
        projects=[{'id':'', 'name':'全部'}, {'id':'project-a'}, {'id':'project-b'}])
    assert calls['expr'] == ['["project-a","project-b"]']
    assert result['timetable']['classTimetableVOList'][0]['classId'] == 'class-1'
    assert term_touched is False


@pytest.mark.parametrize('override', ['wrong_class_body', 'wrong_project_body'])
def test_real_chromium_rejects_posts_unrelated_to_captured_finder_ids(monkeypatch, tmp_path, override):
    with pytest.raises(Exception) as raised:
        run_browser(monkeypatch, tmp_path,
            lambda browser: cqu_course_teaching.capture_teaching_class(browser, capture_recipe()),
            projects=[{'id':'project-a'}], **{override:True})
    assert raised.value.code == 'SCHEMA_INVALID'


def test_real_chromium_nonempty_unverified_expr_table_fails_closed(monkeypatch, tmp_path):
    with pytest.raises(Exception) as raised:
        run_browser(monkeypatch, tmp_path,
            lambda browser: cqu_course_teaching.capture_teaching_class(browser, capture_recipe()),
            expr_body={'classTimetableVOList':[{'classId':'class-1','exprProjectName':'synthetic-unverified'}], 'maxSection':12})
    assert raised.value.code == 'SCHEMA_INVALID'
