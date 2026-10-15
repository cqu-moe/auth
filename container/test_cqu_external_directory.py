#!/usr/bin/env python3
"""External weekly directory contract tests (loopback browser, no school network)."""
import asyncio
import os
import sys
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from aiohttp import web
from aiohttp.test_utils import AioHTTPTestCase
from posthog_client import POSTHOG_CLIENT_KEY

import server
import cqu_external_directory as directory


RESOURCE_BASE = "https://my.cqu.edu.cn/api/resourceapi"
TIMETABLE_BASE = "https://my.cqu.edu.cn/api/timetable"


class ExternalDirectoryEndpointTestCase(AioHTTPTestCase):
    async def get_application(self):
        app = server.build_app()
        app[POSTHOG_CLIENT_KEY] = Mock()
        return app

    def setUp(self):
        super().setUp()
        self.original_directory = server.cqu_external_directory.external_directory

    def tearDown(self):
        server.cqu_external_directory.external_directory = self.original_directory
        super().tearDown()

    async def test_transport_overrides_and_oversized_batches_are_rejected_before_action(self):
        async def unreachable(*_args, **_kwargs):
            raise AssertionError("browser action must not run")

        server.cqu_external_directory.external_directory = unreachable
        recipes = (
            {"kind": "catalog", "sourceType": "admin_class", "url": "https://example.com"},
            {"kind": "instructors", "expectedSessionId": "1", "classIds": [str(i) for i in range(11)]},
            {"kind": "instructors", "expectedSessionId": "1", "classIds": ["1"], "headers": {"x-any": "1"}},
            {"kind": "instructors", "expectedSessionId": "1", "classIds": ["1"], "stateEcho": True},
        )
        for recipe in recipes:
            response = await self.client.post("/external-directory", json={"state": {}, **recipe})
            assert response.status == 400, recipe
            assert await response.json() == {"ok": False, "error": "recipe not allowed"}

    async def test_cap_size_internal_reply_is_rejected_without_truncation(self):
        rows = [{"id": str(index), "name": f"class-{index}", "extra": ""} for index in range(20_000)]

        async def fake_directory(_state, _recipe, _timeout):
            return {
                "contractVersion": 1,
                "kind": "catalog",
                "sourceType": "admin_class",
                "session": {"id": "1", "name": "2026秋"},
                "items": rows,
            }

        server.cqu_external_directory.external_directory = fake_directory
        response = await self.client.post("/external-directory", json={
            "state": {},
            "kind": "catalog",
            "sourceType": "admin_class",
            "expectedSessionId": "1",
        })
        assert response.status == 502
        text = await response.text()
        assert await response.json() == {"ok": False, "error": "SCHEMA_INVALID"}
        assert "class-19999" not in text and "truncated" not in text.lower()

    async def test_operation_deadline_returns_non_200(self):
        cleaned = asyncio.Event()

        async def blocked(_state, _recipe, _timeout):
            try:
                await asyncio.Event().wait()
            finally:
                cleaned.set()

        server.cqu_external_directory.external_directory = blocked
        response = await self.client.post("/external-directory", json={
            "state": {},
            "kind": "catalog",
            "sourceType": "admin_class",
            "operationTimeoutMs": 10,
        })
        assert response.status == 503
        assert await response.json() == {"ok": False, "error": "BROWSER_DEADLINE"}
        assert await asyncio.wait_for(cleaned.wait(), timeout=2)


def instructor_envelope(count):
    teachers = [{
        "instructorId": f"1000130{index:03d}",
        "instrName": "肖富元",
        "instrCode": f"3270{index:02d}",
        "instrDeptName": "软件",
        "belongDeptId": None,
        "mobilePhone": "SECRET",
    } for index in range(count)]
    return {
        "status": "success",
        "ok": True,
        "code": None,
        "data": teachers,
    }


async def start_directory_site(
    *,
    instructor_counts=None,
    fail_class_id=None,
    flip_session_after_class=False,
    late_vue=False,
):
    instructor_counts = instructor_counts or {}
    loop = asyncio.get_running_loop()
    config = {"resource_base": RESOURCE_BASE, "timetable_base": TIMETABLE_BASE}
    transport_calls = []
    api_calls = []
    state = {"session": "1061"}
    admin_rows = [
        {
            "id": "class-1",
            "className": "电气1班",
            "departmentName": "计算机学院",
            "campusName": "A校区",
            "departmentId": None,
            "grade": 2017,
            "personNumber": 30,
            "certificate": "SECRET",
        },
        {
            "id": "class-2",
            "className": "同名学院班",
            "departmentName": "同名学院",
            "campusName": "B校区",
            "departmentId": None,
            "departmentNameFull": "another",
        },
    ]

    app = web.Application()

    async def page(_request):
        html = """<!doctype html><html><body>
          <div id="vue-root"></div><script>
            const parent = {
              sessionId: '1061',
              getSearchList() {},
              async postJsonRequest(path, body, base, cancelFunctions) {
                return transport('postJsonRequest', path, base, {
                  method: 'POST', body: JSON.stringify(body ?? [])
                });
              },
              async getRequest(path, base, cancelFunctions) {
                return transport('getRequest', path, base);
              },
            };
            const child = {
              async postJsonRequest(path, body, base, cancelFunctions) { return 'child must not own requests'; },
              $parent: parent,
            };
            const attachVue = () => { document.getElementById('vue-root').__vue__ = child; };
            if (LATE_VUE) setTimeout(attachVue, 100); else attachVue();
            async function transport(functionName, path, base, init = {}) {
              const allowed = base === 'RESOURCE_BASE' || base === 'TIMETABLE_BASE';
              await fetch('/transport', {
                method: 'POST',
                headers: {'content-type': 'application/json'},
                body: JSON.stringify({functionName, path, base, method: init.method ?? 'GET'})
              });
              if (!allowed) return {status: 404, data: null};
              const localBase = base.startsWith(location.origin + '/api/')
                ? base
                : location.origin + '/api/timetable';
              const response = await fetch(localBase + path, {credentials: 'include', ...init});
              return {status: response.status, data: await response.json()};
            }
          </script>
          <main><span>查询范围：</span><div class="ant-select"><div class="ant-select-selection-item">行政班</div></div></main>
          </body></html>""".replace("RESOURCE_BASE", config["resource_base"]).replace("TIMETABLE_BASE", config["timetable_base"]).replace("LATE_VUE", "true" if late_vue else "false")
        return web.Response(
            text=html,
            content_type="text/html",
            headers={"Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'"},
        )

    async def transport(request):
        call = await request.json()
        transport_calls.append({**call, "at": loop.time()})
        return web.json_response({})

    async def session_info(_request):
        api_calls.append("session-info")
        return web.json_response({"curSessionId": state["session"]})

    async def session_list(_request):
        api_calls.append("session-list")
        return web.json_response({"sessionVOList": [
            {"id": "1061", "year": "2026", "term": "秋"},
            {"id": "1060", "year": "2027", "term": "春"},
        ]})

    async def departments(_request):
        api_calls.append("departments")
        return web.json_response({"data": [
            {"id": "001", "name": "计算机学院"},
            {"id": "011", "name": "同名学院"},
            {"id": "012", "name": "同名学院"},
        ]})

    async def admin_classes(request):
        api_calls.append(("admin-classes", await request.text()))
        return web.json_response(admin_rows)

    async def instructors(request):
        class_id = request.match_info["class_id"]
        api_calls.append(("instructors", class_id))
        if class_id == fail_class_id:
            return web.json_response({"status": "failure"}, status=500)
        result = web.json_response(instructor_envelope(instructor_counts.get(class_id, 0)))
        if flip_session_after_class:
            state["session"] = "1060"
        return result

    app.router.add_get("/tt/AllCourseSchedule", page)
    app.router.add_post("/transport", transport)
    app.router.add_get("/api/resourceapi/session/info-detail", session_info)
    app.router.add_get("/api/resourceapi/session/list", session_list)
    app.router.add_get("/api/resourceapi/department/list", departments)
    app.router.add_post("/api/timetable/admin-class/dept-admin-classes", admin_classes)
    app.router.add_get("/api/timetable/class/instructors/{class_id}", instructors)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    address = site._server.sockets[0].getsockname()
    return SimpleNamespace(
        runner=runner,
        origin=f"http://{address[0]}:{address[1]}",
        config=config,
        transport_calls=transport_calls,
        api_calls=api_calls,
    )


def patch_loopback_school(monkeypatch, site, local_timetable=False):
    resource_base = site.origin + "/api/resourceapi"
    site.config["resource_base"] = resource_base
    monkeypatch.setattr(directory, "ALL_COURSE_URL", site.origin + "/tt/AllCourseSchedule")
    monkeypatch.setattr(directory, "SESSION_INFO_URL", site.origin + "/api/resourceapi/session/info-detail")
    monkeypatch.setattr(directory, "SESSION_LIST_URL", site.origin + "/api/resourceapi/session/list")
    monkeypatch.setattr(directory, "DEPARTMENT_LIST_URL", site.origin + "/api/resourceapi/department/list")
    monkeypatch.setattr(directory, "RESOURCE_API_BASE", resource_base)
    if local_timetable:
        timetable_base = site.origin + "/api/timetable"
        site.config["timetable_base"] = timetable_base
        monkeypatch.setattr(directory, "TIMETABLE_API_BASE", timetable_base)


def run_external_directory(site, recipe, timeout_ms=90_000):
    return directory.external_directory({"cookies": [], "origins": []}, recipe, timeout_ms)


def test_admin_catalog_waits_for_parent_vue_routes_maps_departments_and_checks_terms(monkeypatch, tmp_path):
    async def run():
        site = await start_directory_site(late_vue=True)
        monkeypatch.setenv("CQU_CDP_RUNTIME_DIR", str(tmp_path))
        patch_loopback_school(monkeypatch, site)
        try:
            result = await run_external_directory(site, {
                "kind": "catalog",
                "sourceType": "admin_class",
                "expectedSessionId": "1061",
            })
            assert result["items"] == [
                {
                    "id": "class-1",
                    "name": "电气1班",
                    "extra": "计算机学院 / A校区",
                    "departmentId": "001",
                    "grade": "2017",
                },
                {"id": "class-2", "name": "同名学院班", "extra": "同名学院 / B校区"},
            ]
            assert "SECRET" not in repr(result)
            assert [(call["functionName"], call["path"], call["base"]) for call in site.transport_calls] == [
                ("getRequest", "/session/info-detail", site.config["resource_base"]),
                ("getRequest", "/session/list", site.config["resource_base"]),
                ("postJsonRequest", "/admin-class/dept-admin-classes?pageSize=20000", TIMETABLE_BASE),
                ("getRequest", "/department/list", site.config["resource_base"]),
                ("getRequest", "/session/info-detail", site.config["resource_base"]),
                ("getRequest", "/session/list", site.config["resource_base"]),
            ]
            assert ("admin-classes", "[]") in site.api_calls
        finally:
            await site.runner.cleanup()

    asyncio.run(run())


def test_instructor_batch_accepts_empty_class_and_paces_every_request(monkeypatch, tmp_path):
    class_ids = ["745004", "745005", "745006", "745616", "745008", "744669"]
    counts = [1, 1, 1, 4, 2, 0]

    async def run():
        site = await start_directory_site(instructor_counts=dict(zip(class_ids, counts)))
        monkeypatch.setenv("CQU_CDP_RUNTIME_DIR", str(tmp_path))
        patch_loopback_school(monkeypatch, site, local_timetable=True)
        random_contracts = []

        def deterministic_uniform(low, high):
            random_contracts.append((low, high))
            return (low + high) / 2

        monkeypatch.setattr(directory, "random", SimpleNamespace(uniform=deterministic_uniform))
        try:
            result = await run_external_directory(site, {
                "kind": "instructors",
                "expectedSessionId": "1061",
                "classIds": class_ids,
            })
            assert result["classes"] == [{
                "classId": class_id,
                "items": [{
                    "id": f"1000130{index:03d}",
                    "name": "肖富元",
                    "extra": f"3270{index:02d} / 软件",
                } for index in range(count)],
            } for class_id, count in zip(class_ids, counts)]
            assert "SECRET" not in repr(result)
            gaps = [
                current["at"] - previous["at"]
                for previous, current in zip(site.transport_calls, site.transport_calls[1:])
            ]
            assert gaps
            assert all(gap >= 0.70 for gap in gaps), gaps
            assert random_contracts
            assert all(args == (0.75, 1.25) for args in random_contracts)
        finally:
            await site.runner.cleanup()

    asyncio.run(run())


def test_instructor_ids_are_fenced_against_current_term_before_and_after(monkeypatch, tmp_path):
    async def run():
        site = await start_directory_site(
            instructor_counts={"745004": 1},
            flip_session_after_class=True,
        )
        monkeypatch.setenv("CQU_CDP_RUNTIME_DIR", str(tmp_path))
        patch_loopback_school(monkeypatch, site, local_timetable=True)
        recipe = {
            "kind": "instructors",
            "expectedSessionId": "1059",
            "classIds": ["745004"],
        }
        try:
            with pytest.raises(directory.ExternalDirectoryTransientError) as raised:
                await run_external_directory(site, recipe)
            assert raised.value.code == "CURRENT_SESSION_CHANGED"
            assert [call["path"] for call in site.transport_calls] == ["/session/info-detail", "/session/list"]

            site.transport_calls.clear()
            site.api_calls.clear()
            recipe["expectedSessionId"] = "1061"
            with pytest.raises(directory.ExternalDirectoryTransientError) as raised:
                await run_external_directory(site, recipe)
            assert raised.value.code == "CURRENT_SESSION_CHANGED"
            paths = [call["path"] for call in site.transport_calls]
            assert "/class/instructors/745004" in paths
            assert paths.index("/class/instructors/745004") < len(paths) - 2
            assert paths[-2:] == ["/session/info-detail", "/session/list"]
        finally:
            await site.runner.cleanup()

    asyncio.run(run())


def test_instructor_school_failure_is_all_or_nothing(monkeypatch, tmp_path):
    async def run():
        site = await start_directory_site(
            instructor_counts={"745004": 1, "745005": 1},
            fail_class_id="745005",
        )
        monkeypatch.setenv("CQU_CDP_RUNTIME_DIR", str(tmp_path))
        patch_loopback_school(monkeypatch, site, local_timetable=True)
        try:
            with pytest.raises(directory.ExternalDirectoryTransientError) as raised:
                await run_external_directory(site, {
                    "kind": "instructors",
                    "expectedSessionId": "1061",
                    "classIds": ["745004", "745005"],
                })
            assert raised.value.code == "DIRECTORY_API_REJECTED"
            assert ("instructors", "745005") in site.api_calls
            assert ("instructors", "745004") in site.api_calls
        finally:
            await site.runner.cleanup()

    asyncio.run(run())
