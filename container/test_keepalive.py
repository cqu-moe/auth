#!/usr/bin/env python3
"""/keepalive 端点契约测 —— 经 aiohttp test client 打 build_app()。不触网。

新契约(浏览器水化探活, 砍青果):
  · POST /keepalive {state} → 临时浏览器水化完整 storage_state, navigate 探活,
    返回三态事实 + 刷新后的 storage_state 给 DO。端点不碰青果。

三态映射(端点恒返回 200 {ok:true, status, state, detail}, 由 DO 据 status 决策):
  · probe_session_browser 返回 status=alive       → 200 {ok:true, status:"alive", state}。
  · probe_session_browser 返回 status=expired     → 200 {ok:true, status:"expired"}。
  · probe_session_browser 返回 status=unreachable → 200 {ok:true, status:"unreachable"}。

探不通绝不误判过期(归 unreachable, DO 退避)。probe 自身抛异常 → 纵深兜底归 unreachable(仍 200)。

缺 state / state 非 dict → 400(契约破坏, 真客户端错误)。

测试 monkeypatch server.cqu_keepalive.probe_session_browser, 不起浏览器、不触网。

运行:
    python3 -m pytest container/test_keepalive.py -v
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from aiohttp.test_utils import AioHTTPTestCase  # noqa: E402

import server  # noqa: E402

# storage_state 形态(cookies + origins), 探活回吐刷新后的它给 DO 保鲜瑞数 cookie。
_VALID_BODY = {"state": {"cookies": [], "origins": []}}
_REFRESHED_STATE = {"cookies": [{"name": "x", "value": "y"}], "origins": []}


class KeepaliveTestCase(AioHTTPTestCase):
    async def get_application(self):
        return server.build_app()

    def setUp(self):
        super().setUp()
        self._orig_probe = server.cqu_keepalive.probe_session_browser

    def tearDown(self):
        server.cqu_keepalive.probe_session_browser = self._orig_probe
        super().tearDown()

    async def test_alive_maps_to_200_alive_with_state(self):
        # probe 判 alive → 200 {ok:true, status:"alive", state:<刷新后>}; state 原样透传给 probe。
        captured = {}

        async def _probe(state):
            captured["state"] = state
            return {"status": "alive", "state": _REFRESHED_STATE, "detail": "ok"}

        server.cqu_keepalive.probe_session_browser = _probe

        resp = await self.client.post("/keepalive", json=_VALID_BODY)
        assert resp.status == 200, f"expected 200, got {resp.status}"
        data = await resp.json()
        assert data["ok"] is True
        assert data["status"] == "alive"
        # 关键: 回吐刷新后的 state 给 DO 保鲜; 入参 state 原样透传。
        assert data["state"] == _REFRESHED_STATE
        assert captured["state"] == _VALID_BODY["state"]

    async def test_expired_maps_to_200_expired(self):
        # probe 判 expired(落回 CAS 登录页) → 200 {ok:true, status:"expired"}。
        async def _probe(_state):
            return {"status": "expired", "state": _state, "detail": "expired"}

        server.cqu_keepalive.probe_session_browser = _probe

        resp = await self.client.post("/keepalive", json=_VALID_BODY)
        assert resp.status == 200, f"expected 200, got {resp.status}"
        data = await resp.json()
        assert data["ok"] is True
        assert data["status"] == "expired"

    async def test_unreachable_maps_to_200_unreachable(self):
        # probe 判 unreachable(瑞数误判/探不通) → 200 {ok:true, status:"unreachable"}, 回吐原 state。
        async def _probe(_state):
            return {"status": "unreachable", "state": _state, "detail": "no_ticket"}

        server.cqu_keepalive.probe_session_browser = _probe

        resp = await self.client.post("/keepalive", json=_VALID_BODY)
        assert resp.status == 200, f"expected 200, got {resp.status}"
        data = await resp.json()
        assert data["ok"] is True
        assert data["status"] == "unreachable"

    async def test_probe_unexpected_exception_maps_to_200_unreachable(self):
        # probe_session_browser 自身抛未预期异常(内部已收口, 此为纵深兜底) → 200 unreachable,
        # 绝不 500, 绝不误判过期 —— 探活端点对 DO 永远只返回「探测事实」。
        # 外层兜底 detail 只放异常类型名, 绝不回显 str(e)(防 state/cookie 片段经异常 message 漏进 DO 日志)。
        secret = "SOURCEID_TGC=SUPER-SECRET-TGC-VALUE"

        async def _probe(_state):
            raise RuntimeError(secret)

        server.cqu_keepalive.probe_session_browser = _probe

        resp = await self.client.post("/keepalive", json=_VALID_BODY)
        assert resp.status == 200, f"expected 200, got {resp.status}"
        data = await resp.json()
        assert data["ok"] is True
        assert data["status"] == "unreachable"
        # 脱敏红线: detail 恰为类型名, 不含 str(e) 里的敏感子串。
        assert data["detail"] == "RuntimeError"
        assert secret not in data["detail"]

    async def test_probe_unexpected_exception_log_does_not_leak_state(self):
        # M9: 外层兜底 catch 的 body 已脱敏(detail=类型名, 见上), 但 log.warning 旧实现仍
        # `%s, e` 打原始异常对象 —— 异常 message 可能含 state/cookie 片段, 经 CF observability 泄露。
        # 补齐"body 防了 log 没防"的不一致: 该 log 只记 type(e).__name__。
        secret = "SOURCEID_TGC=SUPER-SECRET-TGC-VALUE; SESSION=leak789"

        async def _probe(_state):
            raise RuntimeError(secret)

        server.cqu_keepalive.probe_session_browser = _probe

        with self.assertLogs("cqu-login-server", level="INFO") as cm:
            resp = await self.client.post("/keepalive", json=_VALID_BODY)
        assert resp.status == 200, f"expected 200, got {resp.status}"
        joined = "\n".join(cm.output)
        assert "SUPER-SECRET-TGC-VALUE" not in joined, f"state leaked into logs: {cm.output}"
        assert "leak789" not in joined, f"state leaked into logs: {cm.output}"
        assert "SOURCEID_TGC" not in joined, f"cookie name leaked into logs: {cm.output}"

    async def test_missing_state_returns_400(self):
        # 缺 state 字段 → 400, 不进 probe。
        called = {"probe": False}

        async def _probe(_state):
            called["probe"] = True
            return {"status": "alive", "state": _state, "detail": "x"}

        server.cqu_keepalive.probe_session_browser = _probe
        resp = await self.client.post("/keepalive", json={})
        assert resp.status == 400
        assert called["probe"] is False, "probe must not run for invalid body"

    async def test_state_not_dict_returns_400(self):
        # state 非 dict(类型不对) → 400, 不进 probe。
        called = {"probe": False}

        async def _probe(_state):
            called["probe"] = True
            return {"status": "alive", "state": _state, "detail": "x"}

        server.cqu_keepalive.probe_session_browser = _probe
        resp = await self.client.post("/keepalive", json={"state": "not-a-dict"})
        assert resp.status == 400
        assert called["probe"] is False

    async def test_invalid_json_returns_400(self):
        resp = await self.client.post(
            "/keepalive", data="not json", headers={"Content-Type": "application/json"}
        )
        assert resp.status == 400
