#!/usr/bin/env python3
"""/service-ticket 端点契约测 —— 经 aiohttp test client 打 build_app()。不触网。

铁律: 取 ST 也是「连 CQU」, 必先 acquire_qg_proxy() 经青果出站:
  · 青果提取失败(QgExtractError) → 502 {ok:false}, 不进入 fetch_service_ticket(硬依赖回退)。
  · 青果成功 → proxy dict 原样透传给 cqu_ticket.fetch_service_ticket(...)。

取票结果映射:
  · 成功 → 200 {ok:true, ticket}。
  · 会话过期(TicketError code=SESSION_EXPIRED) → 409 {ok:false}。
  · 其余取票失败(NO_TICKET / 网络层) → 502 {ok:false}。

测试把 server.acquire_qg_proxy 与 server.cqu_ticket.fetch_service_ticket 全 monkeypatch,
两条出站(青果提取 + 经青果取票)都不触网。

运行:
    python3 -m pytest container/test_service_ticket.py -v
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from aiohttp.test_utils import AioHTTPTestCase  # noqa: E402

import server  # noqa: E402
from cqu_ticket import TicketError  # noqa: E402
from qg_proxy import QgExtractError  # noqa: E402

_VALID_BODY = {
    "serviceUrl": "https://my.cqu.edu.cn/authserver/authentication/cas",
    "cookies": {"SOURCEID_TGC": "tgc", "SESSION": "sess", "rg_objectid": "rg"},
}

_FAKE_PROXY = {"server": "http://1.2.3.4:20000", "username": "u", "password": "p"}


class ServiceTicketTestCase(AioHTTPTestCase):
    async def get_application(self):
        return server.build_app()

    def setUp(self):
        super().setUp()
        self._orig_acquire = server.acquire_qg_proxy
        self._orig_fetch = server.cqu_ticket.fetch_service_ticket

    def tearDown(self):
        server.acquire_qg_proxy = self._orig_acquire
        server.cqu_ticket.fetch_service_ticket = self._orig_fetch
        super().tearDown()

    async def test_qg_extract_failure_returns_502(self):
        # 青果提取失败 → 502 早退, 绝不进入 fetch_service_ticket。
        called = {"fetch": False}

        async def _boom():
            raise QgExtractError("QG_ENABLED=0 (应急开关关闭)")

        async def _fetch(*_a, **_k):
            called["fetch"] = True
            return "ST-should-not-happen"

        server.acquire_qg_proxy = _boom
        server.cqu_ticket.fetch_service_ticket = _fetch

        resp = await self.client.post("/service-ticket", json=_VALID_BODY)
        assert resp.status == 502, f"expected 502, got {resp.status}"
        data = await resp.json()
        assert data["ok"] is False
        assert "qg proxy unavailable" in data["error"]
        assert called["fetch"] is False, "fetch must not run when qg fails"

    async def test_success_returns_ticket_and_passes_proxy(self):
        # 青果成功 → proxy 原样透传 fetch; 成功 200 {ok, ticket}。
        captured = {}

        async def _ok():
            return _FAKE_PROXY

        async def _fetch(service_url, cookies, proxy):
            captured["service_url"] = service_url
            captured["cookies"] = cookies
            captured["proxy"] = proxy
            return "ST-realticket-xyz"

        server.acquire_qg_proxy = _ok
        server.cqu_ticket.fetch_service_ticket = _fetch

        resp = await self.client.post("/service-ticket", json=_VALID_BODY)
        assert resp.status == 200, f"expected 200, got {resp.status}"
        data = await resp.json()
        assert data["ok"] is True
        assert data["ticket"] == "ST-realticket-xyz"
        # 关键: proxy 原样透传, serviceUrl/cookies 不被顶替。
        assert captured["proxy"] == _FAKE_PROXY
        assert captured["service_url"] == _VALID_BODY["serviceUrl"]
        assert captured["cookies"] == _VALID_BODY["cookies"]

    async def test_session_expired_returns_409(self):
        # 取票判会话过期(SESSION_EXPIRED) → 409(客户端态: cookie 失效, 交重登)。
        async def _ok():
            return _FAKE_PROXY

        async def _fetch(*_a, **_k):
            raise TicketError("SESSION_EXPIRED", "fell back to CAS login page")

        server.acquire_qg_proxy = _ok
        server.cqu_ticket.fetch_service_ticket = _fetch

        resp = await self.client.post("/service-ticket", json=_VALID_BODY)
        assert resp.status == 409, f"expected 409, got {resp.status}"
        data = await resp.json()
        assert data["ok"] is False
        assert "CAS login page" in data["error"]

    async def test_no_ticket_returns_502(self):
        # 取票未抓到 ST 且非登录页(疑似瑞数误判) → 502(瞬态, 上游退避重试)。
        async def _ok():
            return _FAKE_PROXY

        async def _fetch(*_a, **_k):
            raise TicketError("NO_TICKET", "no ST in redirect chain")

        server.acquire_qg_proxy = _ok
        server.cqu_ticket.fetch_service_ticket = _fetch

        resp = await self.client.post("/service-ticket", json=_VALID_BODY)
        assert resp.status == 502, f"expected 502, got {resp.status}"
        data = await resp.json()
        assert data["ok"] is False
        assert "no ST" in data["error"]

    async def test_network_error_returns_502(self):
        # fetch 抛非 TicketError(网络层等) → 兜底 502(瞬态), 不 500。
        async def _ok():
            return _FAKE_PROXY

        async def _fetch(*_a, **_k):
            raise RuntimeError("connection reset by peer")

        server.acquire_qg_proxy = _ok
        server.cqu_ticket.fetch_service_ticket = _fetch

        resp = await self.client.post("/service-ticket", json=_VALID_BODY)
        assert resp.status == 502, f"expected 502, got {resp.status}"
        data = await resp.json()
        assert data["ok"] is False

    async def test_missing_field_returns_400_before_qg(self):
        # 缺字段 400 仍在 acquire_qg_proxy 之前, 不浪费一次青果提取。
        called = {"acquire": False}

        async def _track_acquire():
            called["acquire"] = True
            return _FAKE_PROXY

        server.acquire_qg_proxy = _track_acquire
        # 缺 cookies。
        resp = await self.client.post("/service-ticket", json={"serviceUrl": "https://x.cqu.edu.cn/"})
        assert resp.status == 400
        assert called["acquire"] is False, "qg must not be acquired for invalid body"

    async def test_cookies_not_dict_returns_400(self):
        # cookies 非 dict(类型不对) → 400, 不进青果。
        called = {"acquire": False}

        async def _track_acquire():
            called["acquire"] = True
            return _FAKE_PROXY

        server.acquire_qg_proxy = _track_acquire
        resp = await self.client.post(
            "/service-ticket",
            json={"serviceUrl": "https://x.cqu.edu.cn/", "cookies": "not-a-dict"},
        )
        assert resp.status == 400
        assert called["acquire"] is False
