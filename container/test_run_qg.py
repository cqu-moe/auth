#!/usr/bin/env python3
"""/run 接入青果(硬依赖)契约测 —— 经 aiohttp test client 打 build_app()。不触网。

铁律: 所有连 CQU 出站经青果。/run 必须先 acquire_qg_proxy() 拿代理:
  · 青果提取失败(QgExtractError) → /run 返回 502 {ok:false}, 不进入 run_login(硬依赖回退)。
  · 青果成功 → proxy dict 原样透传给 cqu_login.run_login(..., proxy=proxy)。

测试把 server.acquire_qg_proxy 与 server.cqu_login.run_login 全 monkeypatch 掉,
两条出站(青果提取 + patchright 登录)都不触网。

运行:
    python3 -m pytest container/test_run_qg.py -v
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from aiohttp.test_utils import AioHTTPTestCase  # noqa: E402

import server  # noqa: E402
from qg_proxy import QgExtractError  # noqa: E402

_VALID_BODY = {
    "studentId": "20201234",
    "password": "pw",
    "service": "https://example.cqu.edu.cn/",
    "method": "mail",
    "session": "sess-1",
}

_FAKE_PROXY = {"server": "http://1.2.3.4:20000", "username": "u", "password": "p"}


class RunQgTestCase(AioHTTPTestCase):
    async def get_application(self):
        return server.build_app()

    def setUp(self):
        super().setUp()
        # 每个用例前清空模块级 session 状态, 避免串扰。
        server.CODE_EVENTS.clear()
        server.CODE_VALUES.clear()
        server.LOGIN_RUNS.clear()
        server.LOGIN_TOMBSTONES.clear()
        self._orig_acquire = server.acquire_qg_proxy
        self._orig_should = server.should_use_proxy
        self._orig_run_login = server.cqu_login.run_login

    def tearDown(self):
        server.acquire_qg_proxy = self._orig_acquire
        server.should_use_proxy = self._orig_should
        server.cqu_login.run_login = self._orig_run_login
        server.LOGIN_RUNS.clear()
        server.LOGIN_TOMBSTONES.clear()
        super().tearDown()

    async def test_qg_extract_failure_returns_502(self):
        # 青果提取失败 → /run 早退 502, 绝不进入 run_login。
        called = {"run_login": False}

        async def _boom(profile="short"):
            raise QgExtractError("QG_ENABLED=0 (应急开关关闭)")

        async def _run_login(**_kwargs):
            called["run_login"] = True
            return {"ticket": "should-not-happen"}

        server.acquire_qg_proxy = _boom
        server.cqu_login.run_login = _run_login

        with self.assertLogs("cqu-login-server", level="INFO") as logs:
            resp = await self.client.post("/run", json=_VALID_BODY)
        assert resp.status == 502, f"expected 502, got {resp.status}"
        data = await resp.json()
        assert data["ok"] is False
        assert "qg proxy unavailable" in data["error"]
        assert called["run_login"] is False, "run_login must not run when qg fails"
        # 502 早退不得泄漏已注册的 Event/Value。
        assert _VALID_BODY["session"] not in server.CODE_EVENTS
        assert _VALID_BODY["session"] not in server.CODE_VALUES
        assert _VALID_BODY["session"] not in "\n".join(logs.output)

    async def test_qg_success_passes_proxy_to_run_login(self):
        # 青果成功 → proxy dict 原样透传给 run_login; 走 login 包(profile="login")。
        captured = {}
        acquired = {"profile": None}

        async def _ok(profile="short"):
            acquired["profile"] = profile
            return _FAKE_PROXY

        async def _run_login(**kwargs):
            captured.update(kwargs)
            # 新契约: run_login 返回完整 storage_state(顶层含 cookies 列表 + origins/localStorage)。
            return {"ticket": "ST-fake", "state": {"cookies": [], "origins": []}}

        server.acquire_qg_proxy = _ok
        server.cqu_login.run_login = _run_login

        resp = await self.client.post("/run", json=_VALID_BODY)
        assert resp.status == 200, f"expected 200, got {resp.status}"
        data = await resp.json()
        assert data["ok"] is True
        assert data["ticket"] == "ST-fake"
        # 新契约: run_login 返回 state(完整 storage_state), 经 handler 原样透传; 顶层含 cookies 列表。
        assert "state" in data
        assert "cookies" in data["state"]
        # 关键断言: run_login 收到 proxy=<那个假 proxy>。
        assert captured.get("proxy") == _FAKE_PROXY
        # 默认(走青果)→ 用登录包(profile="login")。
        assert acquired["profile"] == "login"
        # 透传基本参数也对(确保没把 proxy 顶替掉别的参数)。
        assert captured.get("student_id") == _VALID_BODY["studentId"]
        assert captured.get("service") == _VALID_BODY["service"]
        assert callable(captured.get("permit_provider"))
        # 成功路径 finally 清理。
        assert _VALID_BODY["session"] not in server.CODE_EVENTS
        assert _VALID_BODY["session"] not in server.CODE_VALUES

    async def test_valid_seed_state_is_passed_to_run_login(self):
        captured = {}
        seed_state = {
            "cookies": [{"name": "trust", "value": "opaque"}],
            "origins": [],
        }

        async def _run_login(**kwargs):
            captured.update(kwargs)
            return {"ticket": "ST-seeded", "state": {"cookies": [], "origins": []}}

        server.should_use_proxy = lambda _profile: False
        server.cqu_login.run_login = _run_login

        resp = await self.client.post(
            "/run", json={**_VALID_BODY, "seedState": seed_state}
        )

        assert resp.status == 200
        assert captured.get("seed_state") == seed_state

    async def test_invalid_seed_state_returns_400_before_browser_or_proxy(self):
        called = {"run_login": False, "acquire": False}

        async def _acquire(_profile="short"):
            called["acquire"] = True
            return _FAKE_PROXY

        async def _run_login(**_kwargs):
            called["run_login"] = True
            return {"ticket": "ST-impossible", "state": {"cookies": [], "origins": []}}

        server.acquire_qg_proxy = _acquire
        server.cqu_login.run_login = _run_login

        for invalid in ([], {}, {"cookies": "not-a-list"}, {"cookies": [], "origins": {}}):
            resp = await self.client.post(
                "/run", json={**_VALID_BODY, "seedState": invalid}
            )
            assert resp.status == 400
            assert (await resp.json())["error"] == "invalid seedState"

        assert called == {"run_login": False, "acquire": False}

    async def test_gray_door_off_direct_connect_no_acquire(self):
        # 灰度门关(should_use_proxy("login")=False) → 节点直连: 不调 acquire_qg_proxy,
        # 传给 run_login 的 proxy 必须是 None。
        captured = {}
        called = {"acquire": False}

        def _no_proxy(profile):
            assert profile == "login"
            return False

        async def _track_acquire(profile="short"):
            called["acquire"] = True
            return _FAKE_PROXY

        async def _run_login(**kwargs):
            captured.update(kwargs)
            # 新契约: run_login 返回完整 storage_state(顶层含 cookies 列表 + origins/localStorage)。
            return {"ticket": "ST-direct", "state": {"cookies": [], "origins": []}}

        server.should_use_proxy = _no_proxy
        server.acquire_qg_proxy = _track_acquire
        server.cqu_login.run_login = _run_login

        resp = await self.client.post("/run", json=_VALID_BODY)
        assert resp.status == 200, f"expected 200, got {resp.status}"
        data = await resp.json()
        assert data["ok"] is True
        assert called["acquire"] is False, "must not acquire qg when gray door is off"
        assert captured.get("proxy") is None, "direct-connect must pass proxy=None"

    async def test_missing_field_returns_400_before_qg(self):
        # 缺字段 400 仍在 acquire_qg_proxy 之前(校验顺序), 不浪费一次青果提取。
        called = {"acquire": False}

        async def _track_acquire(profile="short"):
            called["acquire"] = True
            return _FAKE_PROXY

        server.acquire_qg_proxy = _track_acquire
        resp = await self.client.post("/run", json={"studentId": "x"})
        assert resp.status == 400
        assert called["acquire"] is False, "qg must not be acquired for invalid body"

    async def test_disallowed_service_returns_400_without_run_login(self):
        # H3: /run 也是 CAS 铸 ST 入口, 与 /service-ticket /keepalive 对称——入参 service host 必须
        # 是 https 的 *.cqu.edu.cn(纵深第二层, 防 VPC 误配/将来直连绕过红线 → CVE-2022-39369 式
        # ST-relay)。别域/后缀伪装/非 https → 400, 绝不进 run_login, 也绝不白嫖一次青果提取。
        called = {"run_login": False, "acquire": False}

        async def _track_acquire(profile="short"):
            called["acquire"] = True
            return _FAKE_PROXY

        async def _run_login(**_kwargs):
            called["run_login"] = True
            return {"ticket": "ST-should-not-happen", "state": {"cookies": [], "origins": []}}

        server.acquire_qg_proxy = _track_acquire
        server.cqu_login.run_login = _run_login

        for bad_service in (
            "https://evil.com/cas",                 # 别域
            "https://cqu.edu.cn.evil.com/cas",      # 后缀伪装
            "http://my.cqu.edu.cn/cas",             # 非 https
        ):
            body = {**_VALID_BODY, "service": bad_service}
            resp = await self.client.post("/run", json=body)
            assert resp.status == 400, f"{bad_service}: expected 400, got {resp.status}"
            data = await resp.json()
            assert data["ok"] is False
        assert called["run_login"] is False, "run_login must not run for disallowed service"
        assert called["acquire"] is False, "qg must not be acquired for disallowed service"
        # 拒绝路径不得泄漏已注册的 Event/Value。
        assert _VALID_BODY["session"] not in server.CODE_EVENTS
        assert _VALID_BODY["session"] not in server.CODE_VALUES

    async def test_allowed_service_passes_canonical_to_run_login(self):
        # H3: 合法 *.cqu.edu.cn service 不被该校验拦; 且传给 run_login 的是 canonical(小写 host、
        # 去默认 :443)——对齐 T1 整链 canonical 口径(is_allowed_service_url 返 canonical 值)。
        captured = {}

        async def _ok(profile="short"):
            return _FAKE_PROXY

        async def _run_login(**kwargs):
            captured.update(kwargs)
            return {"ticket": "ST-fake", "state": {"cookies": [], "origins": []}}

        server.acquire_qg_proxy = _ok
        server.cqu_login.run_login = _run_login

        body = {**_VALID_BODY, "service": "https://MY.CQU.EDU.CN:443/authserver/cas"}
        resp = await self.client.post("/run", json=body)
        assert resp.status == 200, f"expected 200, got {resp.status}"
        data = await resp.json()
        assert data["ok"] is True
        # 传给 run_login 的 service 是 canonical, 不是客户端原样的大写 + :443。
        assert captured.get("service") == "https://my.cqu.edu.cn/authserver/cas", (
            f"expected canonical service, got {captured.get('service')!r}"
        )
