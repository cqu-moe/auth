#!/usr/bin/env python3
"""/keepalive 端点契约测 —— 经 aiohttp test client 打 build_app()。不触网。

铁律: 探活也是「连 CQU」, 必先 acquire_qg_proxy() 经青果出站。

三态映射(端点恒返回 200 {ok:true, status, detail}, 由 DO 据 status 决策):
  · probe_session 返回 status=alive       → 200 {ok:true, status:"alive"}。
  · probe_session 返回 status=expired     → 200 {ok:true, status:"expired"}。
  · probe_session 返回 status=unreachable → 200 {ok:true, status:"unreachable"}。

青果失败语义(关键): 拿不到青果 = 探不通(不证明会话过期) → 200 {ok:true,
status:"unreachable"}, 让 DO 按瞬态退避而非误触重登。**不** 5xx —— 探活端点只返回
「探测事实」, DO 凭 status 区分 expired(该重登) vs unreachable(该退避)。

缺字段 / cookies 非 dict → 400(契约破坏, 真客户端错误)。

测试把 server.acquire_qg_proxy 与 server.cqu_keepalive.probe_session 全 monkeypatch,
两条出站(青果提取 + 经青果探活)都不触网。

运行:
    python3 -m pytest container/test_keepalive.py -v
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from aiohttp.test_utils import AioHTTPTestCase  # noqa: E402

import server  # noqa: E402
from qg_proxy import QgExtractError  # noqa: E402

_VALID_BODY = {
    "cookies": {"SOURCEID_TGC": "tgc", "SESSION": "sess", "rg_objectid": "rg"},
}

_FAKE_PROXY = {"server": "http://1.2.3.4:20000", "username": "u", "password": "p"}


class KeepaliveTestCase(AioHTTPTestCase):
    async def get_application(self):
        return server.build_app()

    def setUp(self):
        super().setUp()
        self._orig_acquire = server.acquire_qg_proxy
        self._orig_should = server.should_use_proxy
        self._orig_probe = server.cqu_keepalive.probe_session

    def tearDown(self):
        server.acquire_qg_proxy = self._orig_acquire
        server.should_use_proxy = self._orig_should
        server.cqu_keepalive.probe_session = self._orig_probe
        super().tearDown()

    async def test_alive_maps_to_200_alive(self):
        # probe 判 alive → 200 {ok:true, status:"alive"}; proxy/cookies 原样透传; 走短效包。
        captured = {}
        acquired = {"profile": None}

        async def _ok(profile="short"):
            acquired["profile"] = profile
            return _FAKE_PROXY

        async def _probe(cookies, proxy):
            captured["cookies"] = cookies
            captured["proxy"] = proxy
            return {"status": "alive", "detail": "probe minted ST"}

        server.acquire_qg_proxy = _ok
        server.cqu_keepalive.probe_session = _probe

        resp = await self.client.post("/keepalive", json=_VALID_BODY)
        assert resp.status == 200, f"expected 200, got {resp.status}"
        data = await resp.json()
        assert data["ok"] is True
        assert data["status"] == "alive"
        # 关键: proxy 原样透传, cookies 不被顶替。
        assert captured["proxy"] == _FAKE_PROXY
        assert captured["cookies"] == _VALID_BODY["cookies"]
        # 默认(走青果)→ 探活用短效包(profile="short")。
        assert acquired["profile"] == "short"

    async def test_gray_door_off_direct_connect_no_acquire(self):
        # 灰度门关(should_use_proxy("short")=False) → 节点直连探活: 不调 acquire_qg_proxy,
        # 传给 probe 的 proxy 必须是 None; 仍正常返回探测三态(此处 alive)。
        captured = {}
        called = {"acquire": False}

        def _no_proxy(profile):
            assert profile == "short"
            return False

        async def _track_acquire(profile="short"):
            called["acquire"] = True
            return _FAKE_PROXY

        async def _probe(cookies, proxy):
            captured["proxy"] = proxy
            return {"status": "alive", "detail": "direct-connect probe"}

        server.should_use_proxy = _no_proxy
        server.acquire_qg_proxy = _track_acquire
        server.cqu_keepalive.probe_session = _probe

        resp = await self.client.post("/keepalive", json=_VALID_BODY)
        assert resp.status == 200, f"expected 200, got {resp.status}"
        data = await resp.json()
        assert data["ok"] is True
        assert data["status"] == "alive"
        assert called["acquire"] is False, "must not acquire qg when gray door is off"
        assert captured["proxy"] is None, "direct-connect must pass proxy=None"

    async def test_expired_maps_to_200_expired(self):
        # probe 判 expired(落回 CAS 登录页) → 200 {ok:true, status:"expired"}。
        async def _ok(profile="short"):
            return _FAKE_PROXY

        async def _probe(*_a, **_k):
            return {"status": "expired", "detail": "SESSION_EXPIRED: fell back to CAS login"}

        server.acquire_qg_proxy = _ok
        server.cqu_keepalive.probe_session = _probe

        resp = await self.client.post("/keepalive", json=_VALID_BODY)
        assert resp.status == 200, f"expected 200, got {resp.status}"
        data = await resp.json()
        assert data["ok"] is True
        assert data["status"] == "expired"

    async def test_unreachable_maps_to_200_unreachable(self):
        # probe 判 unreachable(瑞数误判/网络) → 200 {ok:true, status:"unreachable"}。
        async def _ok(profile="short"):
            return _FAKE_PROXY

        async def _probe(*_a, **_k):
            return {"status": "unreachable", "detail": "NO_TICKET: likely WAF/throttle"}

        server.acquire_qg_proxy = _ok
        server.cqu_keepalive.probe_session = _probe

        resp = await self.client.post("/keepalive", json=_VALID_BODY)
        assert resp.status == 200, f"expected 200, got {resp.status}"
        data = await resp.json()
        assert data["ok"] is True
        assert data["status"] == "unreachable"

    async def test_qg_failure_maps_to_200_unreachable_not_5xx(self):
        # 关键: 青果失败 = 探不通 → 200 {ok:true, status:"unreachable"}(不 5xx, 不进 probe)。
        # 让 DO 按瞬态退避, 而非误判会话过期触发重登。
        called = {"probe": False}

        async def _boom(profile="short"):
            raise QgExtractError("QG_ENABLED=0 (应急开关关闭)")

        async def _probe(*_a, **_k):
            called["probe"] = True
            return {"status": "alive", "detail": "should-not-happen"}

        server.acquire_qg_proxy = _boom
        server.cqu_keepalive.probe_session = _probe

        resp = await self.client.post("/keepalive", json=_VALID_BODY)
        assert resp.status == 200, f"expected 200, got {resp.status}"
        data = await resp.json()
        assert data["ok"] is True
        assert data["status"] == "unreachable", "qg failure must map to unreachable, not expired"
        assert "qg proxy unavailable" in data["detail"]
        assert called["probe"] is False, "probe must not run when qg fails"

    async def test_probe_unexpected_exception_maps_to_200_unreachable(self):
        # probe_session 自身抛未预期异常(理论上它内部已收口, 此为纵深兜底) → 200 unreachable,
        # 绝不 500 —— 探活端点对 DO 永远只返回「探测事实」。
        async def _ok(profile="short"):
            return _FAKE_PROXY

        async def _probe(*_a, **_k):
            raise RuntimeError("unexpected boom")

        server.acquire_qg_proxy = _ok
        server.cqu_keepalive.probe_session = _probe

        resp = await self.client.post("/keepalive", json=_VALID_BODY)
        assert resp.status == 200, f"expected 200, got {resp.status}"
        data = await resp.json()
        assert data["ok"] is True
        assert data["status"] == "unreachable"

    async def test_missing_cookies_returns_400_before_qg(self):
        # 缺 cookies 字段 → 400, 仍在 acquire_qg_proxy 之前(不浪费青果提取)。
        called = {"acquire": False}

        async def _track_acquire(profile="short"):
            called["acquire"] = True
            return _FAKE_PROXY

        server.acquire_qg_proxy = _track_acquire
        resp = await self.client.post("/keepalive", json={})
        assert resp.status == 400
        assert called["acquire"] is False, "qg must not be acquired for invalid body"

    async def test_cookies_not_dict_returns_400(self):
        # cookies 非 dict(类型不对) → 400, 不进青果。
        called = {"acquire": False}

        async def _track_acquire(profile="short"):
            called["acquire"] = True
            return _FAKE_PROXY

        server.acquire_qg_proxy = _track_acquire
        resp = await self.client.post("/keepalive", json={"cookies": "not-a-dict"})
        assert resp.status == 400
        assert called["acquire"] is False

    async def test_invalid_json_returns_400(self):
        resp = await self.client.post(
            "/keepalive", data="not json", headers={"Content-Type": "application/json"}
        )
        assert resp.status == 400
