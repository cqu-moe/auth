#!/usr/bin/env python3
"""/service-ticket 端点契约测 —— 经 aiohttp test client 打 build_app()。不触网。

新契约(Task 3.1): 端点收完整 storage_state, 走浏览器水化取票(过瑞数 JS 挑战), 砍青果。
  · 成功(返回 ST) → 200 {ok:true, ticket}。
  · 会话过期(落回 CAS 登录页, ExpiredError) → 409 {ok:false}。
  · 未取到票(NoTicketError / 浏览器崩 / 任意异常) → 502 {ok:false}。
  · 缺 serviceUrl 或 state 非 dict → 400 {ok:false}。

测试把 server.cqu_ticket_browser.fetch_service_ticket_browser monkeypatch(端点 handler 直接调它),
不触网、不起真浏览器。端点不再碰青果(acquire_qg_proxy/should_use_proxy)。

运行:
    python3 -m pytest container/test_service_ticket.py -v
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from aiohttp.test_utils import AioHTTPTestCase  # noqa: E402

import server  # noqa: E402

_VALID_BODY = {
    "serviceUrl": "https://my.cqu.edu.cn/authserver/authentication/cas",
    "state": {
        "cookies": [
            {"name": "SOURCEID_TGC", "value": "tgc", "domain": "sso.cqu.edu.cn", "path": "/"},
        ],
        "origins": [],
    },
}


class ServiceTicketTestCase(AioHTTPTestCase):
    async def get_application(self):
        return server.build_app()

    def setUp(self):
        super().setUp()
        self._orig_fetch = server.cqu_ticket_browser.fetch_service_ticket_browser

    def tearDown(self):
        server.cqu_ticket_browser.fetch_service_ticket_browser = self._orig_fetch
        super().tearDown()

    async def test_success_returns_ticket(self):
        # 浏览器水化成功 → 200 {ok, ticket}; serviceUrl/state 原样透传给取票函数。
        captured = {}

        async def _fetch(service_url, state):
            captured["service_url"] = service_url
            captured["state"] = state
            return "ST-realticket-xyz"

        server.cqu_ticket_browser.fetch_service_ticket_browser = _fetch

        resp = await self.client.post("/service-ticket", json=_VALID_BODY)
        assert resp.status == 200, f"expected 200, got {resp.status}"
        data = await resp.json()
        assert data["ok"] is True
        assert data["ticket"] == "ST-realticket-xyz"
        # 关键: serviceUrl/state 不被顶替, 原样透传。
        assert captured["service_url"] == _VALID_BODY["serviceUrl"]
        assert captured["state"] == _VALID_BODY["state"]

    async def test_success_log_does_not_leak_ticket(self):
        # ST 是 bearer 凭据, 成功日志绝不该打它的值(对齐 DO 审计「绝不记录 ticket/cookies/密码」)。
        sentinel = "ST-SENSITIVE-xyz-DO-NOT-LOG"

        async def _fetch(service_url, state):
            return sentinel

        server.cqu_ticket_browser.fetch_service_ticket_browser = _fetch

        with self.assertLogs("cqu-login-server", level="INFO") as cm:
            resp = await self.client.post("/service-ticket", json=_VALID_BODY)
        assert resp.status == 200, f"expected 200, got {resp.status}"
        data = await resp.json()
        # 返回体仍含 ticket(那是给 DO 的, 不是日志)。
        assert data["ticket"] == sentinel
        # 关键: 任何一条日志记录都不得出现 ticket 值(全值或任意前缀片段)。
        joined = "\n".join(cm.output)
        assert sentinel not in joined, f"ticket value leaked into logs: {cm.output}"
        assert sentinel[:24] not in joined, f"ticket prefix leaked into logs: {cm.output}"

    async def test_expired_returns_409(self):
        # 落回 CAS 登录页(ExpiredError) → 409(客户端态: 会话失效, 交上游 DO 重登)。
        async def _fetch(*_a, **_k):
            raise server.cqu_ticket_browser.ExpiredError("fell back to CAS login page")

        server.cqu_ticket_browser.fetch_service_ticket_browser = _fetch

        resp = await self.client.post("/service-ticket", json=_VALID_BODY)
        assert resp.status == 409, f"expected 409, got {resp.status}"
        data = await resp.json()
        assert data["ok"] is False
        assert "CAS login page" in data["error"]

    async def test_no_ticket_returns_502(self):
        # 未抓到 ST 且非登录页(NoTicketError) → 502(瞬态, 上游退避重试)。
        async def _fetch(*_a, **_k):
            raise server.cqu_ticket_browser.NoTicketError("no ST, non-login page")

        server.cqu_ticket_browser.fetch_service_ticket_browser = _fetch

        resp = await self.client.post("/service-ticket", json=_VALID_BODY)
        assert resp.status == 502, f"expected 502, got {resp.status}"
        data = await resp.json()
        assert data["ok"] is False
        assert "no ST" in data["error"]

    async def test_browser_crash_returns_502(self):
        # 取票抛任意非 Expired 异常(浏览器崩/超时/网络层) → 兜底 502(瞬态), 不 500。
        async def _fetch(*_a, **_k):
            raise RuntimeError("browser crashed: Target page closed")

        server.cqu_ticket_browser.fetch_service_ticket_browser = _fetch

        resp = await self.client.post("/service-ticket", json=_VALID_BODY)
        assert resp.status == 502, f"expected 502, got {resp.status}"
        data = await resp.json()
        assert data["ok"] is False

    async def test_missing_service_url_returns_400(self):
        # 缺 serviceUrl → 400, 不进取票。
        called = {"fetch": False}

        async def _fetch(*_a, **_k):
            called["fetch"] = True
            return "ST-should-not-happen"

        server.cqu_ticket_browser.fetch_service_ticket_browser = _fetch
        resp = await self.client.post("/service-ticket", json={"state": _VALID_BODY["state"]})
        assert resp.status == 400, f"expected 400, got {resp.status}"
        assert called["fetch"] is False, "fetch must not run for invalid body"

    async def test_state_not_dict_returns_400(self):
        # state 非 dict(类型不对) → 400, 不进取票。
        called = {"fetch": False}

        async def _fetch(*_a, **_k):
            called["fetch"] = True
            return "ST-should-not-happen"

        server.cqu_ticket_browser.fetch_service_ticket_browser = _fetch
        resp = await self.client.post(
            "/service-ticket",
            json={"serviceUrl": "https://x.cqu.edu.cn/", "state": "not-a-dict"},
        )
        assert resp.status == 400, f"expected 400, got {resp.status}"
        assert called["fetch"] is False

    async def test_invalid_json_returns_400(self):
        # 请求体不是 JSON → 400。
        resp = await self.client.post(
            "/service-ticket", data="not json", headers={"Content-Type": "application/json"}
        )
        assert resp.status == 400, f"expected 400, got {resp.status}"
