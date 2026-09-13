#!/usr/bin/env python3
"""/data-harvest 端点契约测 —— 经 aiohttp test client 打 build_app()。不触网、不起真浏览器。

契约(organic harvest): 端点收 {state, navUrl, capture[], fetch[]}, 二次校验 recipe(host 白名单)后
走临时浏览器水化取数(navigate + capture + in-page fetch)。
  · 取数成功 → 200 {ok:true, captures, fetches}。
  · recipe 非法(缺 state / navUrl host 越界 / fetch host 越界 / 缺字段)→ 400 {ok:false}。
  · 未识别浏览器异常 → 503 {ok:false, error:HARVEST_TRANSIENT}，不回显异常原文。

测试把 server.cqu_data_harvest.harvest monkeypatch(端点 handler 直接调它),不触网、不起真浏览器。
沿用 test_service_ticket.py 的 AioHTTPTestCase 模式(本仓未装 pytest-aiohttp,无 aiohttp_client fixture)。

运行:
    python3 -m pytest container/test_data_harvest.py -v
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from aiohttp.test_utils import AioHTTPTestCase  # noqa: E402

import server  # noqa: E402


def _payload():
    return {
        "state": {"cookies": [], "origins": []},
        "navUrl": "https://my.cqu.edu.cn/workspace/curriculum",
        "capture": ["student/my-table-detail"],
        "fetch": [{"method": "GET", "url": "https://my.cqu.edu.cn/api/exam/x"}],
    }


class DataHarvestTestCase(AioHTTPTestCase):
    async def get_application(self):
        return server.build_app()

    def setUp(self):
        super().setUp()
        self._orig_harvest = server.cqu_data_harvest.harvest

    def tearDown(self):
        server.cqu_data_harvest.harvest = self._orig_harvest
        super().tearDown()

    async def test_data_harvest_ok(self):
        async def fake_harvest(state, recipe):
            assert recipe["navUrl"] == "https://my.cqu.edu.cn/workspace/curriculum"
            return {
                "captures": [{"url": "u", "status": 200, "contentType": "application/json", "body": "{}"}],
                "fetches": [{"url": "https://my.cqu.edu.cn/api/exam/x", "status": 200, "body": "[]"}],
                "state": {"cookies": [], "origins": []},
            }
        server.cqu_data_harvest.harvest = fake_harvest

        resp = await self.client.post("/data-harvest", json=_payload())
        assert resp.status == 200, f"expected 200, got {resp.status}"
        body = await resp.json()
        assert body["ok"] is True
        assert body["captures"][0]["status"] == 200
        assert body["fetches"][0]["body"] == "[]"
        assert body["state"] == {"cookies": [], "origins": []}

    async def test_data_harvest_invalid_json(self):
        resp = await self.client.post("/data-harvest", data="not json")
        assert resp.status == 400

    async def test_data_harvest_missing_state(self):
        p = _payload()
        del p["state"]
        resp = await self.client.post("/data-harvest", json=p)
        assert resp.status == 400

    async def test_data_harvest_bad_navurl_host_rejected(self):
        p = _payload() | {"navUrl": "https://lib.cqu.edu.cn/x"}
        resp = await self.client.post("/data-harvest", json=p)
        assert resp.status == 400

    async def test_data_harvest_fetch_host_rejected(self):
        p = _payload() | {"fetch": [{"method": "GET", "url": "https://evil.com/x"}]}
        resp = await self.client.post("/data-harvest", json=p)
        assert resp.status == 400

    async def test_data_harvest_unknown_exception_is_residual_sanitized(self):
        async def boom(state, recipe):
            raise RuntimeError("cookie=SECRET should never leak")
        server.cqu_data_harvest.harvest = boom

        resp = await self.client.post("/data-harvest", json=_payload())
        assert resp.status == 503
        body = await resp.json()
        # 不回显异常类型或原文。
        assert body["error"] == "HARVEST_TRANSIENT"
        assert "SECRET" not in body["error"]
        assert "state" not in body

    async def test_data_harvest_expired_is_409(self):
        # 会话过期(navUrl 落回 CAS 登录页)→ 409 {"error":"TGT_EXPIRED"} → DO 触发重登。
        async def expired(state, recipe):
            raise server.cqu_data_harvest.HarvestExpiredError("redirected to CAS login")
        server.cqu_data_harvest.harvest = expired

        resp = await self.client.post("/data-harvest", json=_payload())
        assert resp.status == 409
        body = await resp.json()
        assert body["error"] == "TGT_EXPIRED"
        # 脱敏:绝不回 str(e)。
        assert "redirected" not in body["error"]

    async def test_data_harvest_transient_is_503_distinct_from_expired(self):
        # 期望 capture 没到齐且页面非登录页 → 503 {"error":"HARVEST_TRANSIENT"}(瞬态退避),
        # 与 409(过期)严格区分, 绝不当 ok 空成功返回。
        async def transient(state, recipe):
            raise server.cqu_data_harvest.HarvestTransientError("expected captures missing")
        server.cqu_data_harvest.harvest = transient

        resp = await self.client.post("/data-harvest", json=_payload())
        assert resp.status == 503
        body = await resp.json()
        assert body["error"] == "HARVEST_TRANSIENT"
        assert body["ok"] is False
        assert "state" not in body

    async def test_data_harvest_transient_sanitizes_diagnostics_at_handler_boundary(self):
        async def transient(state, recipe):
            raise server.cqu_data_harvest.HarvestTransientError(
                "expected captures missing",
                {
                    "timeline": [{
                        "stage": "TABLE_RESPONSE_SEEN",
                        "elapsedMs": 42,
                        "url": "https://my.cqu.edu.cn/api/x"
                            "?CAqWHAeT=SECRET#fragment",
                        "status": 412,
                        "resourceType": "fetch",
                        "contentType": "application/json; charset=utf-8",
                        "body": "raw course body SECRET",
                        "cookie": "CtLgrmkSWHBZT=SECRET",
                        "Authorization": "Bearer SECRET",
                        "studentId": "20260001",
                        "storageState": {"cookies": [{"value": "SECRET"}]},
                        "title": "student name SECRET",
                        "failure": "arbitrary failure SECRET",
                    }],
                    "requestFailures": [{"failure": "SECRET"}],
                },
            )

        server.cqu_data_harvest.harvest = transient

        resp = await self.client.post("/data-harvest", json=_payload())
        assert resp.status == 503
        body = await resp.json()
        diagnostics = body["diagnostics"]
        assert diagnostics == {"timeline": [{
            "stage": "TABLE_RESPONSE_SEEN",
            "elapsedMs": 42,
            "url": "https://my.cqu.edu.cn/api/x",
            "status": 412,
            "resourceType": "fetch",
            "contentType": "application/json",
        }]}
        assert "expected captures missing" not in body["error"]
        assert "SECRET" not in str(body)
        assert "20260001" not in str(body)

    async def test_stable_error_codes_and_statuses(self):
        for code, status in [
            ("WAF_BOOTSTRAP_TIMEOUT", 503), ("APP_READY_TIMEOUT", 503),
            ("TABLE_CAPTURE_TIMEOUT", 503), ("TABLE_REQUEST_HUNG", 504),
            ("TABLE_BODY_TIMEOUT", 504), ("TABLE_API_REJECTED", 502),
            ("WAF_CHALLENGE", 503), ("SCHEDULE_NOT_PUBLISHED", 409),
            ("HARVEST_TRANSIENT", 503), ("unrecognized SECRET", 503),
        ]:
            async def fail(state, recipe):
                error = server.cqu_data_harvest.HarvestTransientError("SECRET")
                error.code = code
                raise error
            server.cqu_data_harvest.harvest = fail
            resp = await self.client.post("/data-harvest", json=_payload())
            assert resp.status == status
            body = await resp.json()
            assert body == {"ok": False, "error": code if "SECRET" not in code else "HARVEST_TRANSIENT", "diagnostics": {"timeline": []}}
