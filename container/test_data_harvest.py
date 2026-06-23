#!/usr/bin/env python3
"""/data-harvest 端点契约测 —— 经 aiohttp test client 打 build_app()。不触网、不起真浏览器。

契约(organic harvest): 端点收 {state, navUrl, capture[], fetch[]}, 二次校验 recipe(host 白名单)后
走临时浏览器水化取数(navigate + capture + in-page fetch)。
  · 取数成功 → 200 {ok:true, captures, fetches}。
  · recipe 非法(缺 state / navUrl host 越界 / fetch host 越界 / 缺字段)→ 400 {ok:false}。
  · 浏览器崩/超时/任意异常 → 502 {ok:false, error:type(e).__name__}(脱敏, 绝不回 str(e))。

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
            }
        server.cqu_data_harvest.harvest = fake_harvest

        resp = await self.client.post("/data-harvest", json=_payload())
        assert resp.status == 200, f"expected 200, got {resp.status}"
        body = await resp.json()
        assert body["ok"] is True
        assert body["captures"][0]["status"] == 200
        assert body["fetches"][0]["body"] == "[]"

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

    async def test_data_harvest_harvest_raises_is_502_sanitized(self):
        async def boom(state, recipe):
            raise RuntimeError("cookie=SECRET should never leak")
        server.cqu_data_harvest.harvest = boom

        resp = await self.client.post("/data-harvest", json=_payload())
        assert resp.status == 502
        body = await resp.json()
        # 脱敏:只回类型名,绝不回 str(e)(可能含 state/cookie 明文)。
        assert body["error"] == "RuntimeError"
        assert "SECRET" not in body["error"]
