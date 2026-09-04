import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from aiohttp.test_utils import AioHTTPTestCase

import server


_BODY = {
    "studentId": "20201234",
    "password": "pw",
    "method": "mail",
    "session": "sensitive-session-token",
}


class AtrustLoginServerTestCase(AioHTTPTestCase):
    async def get_application(self):
        return server.build_app()

    def setUp(self):
        super().setUp()
        server.CODE_EVENTS.clear()
        server.CODE_VALUES.clear()
        server.PERMIT_EVENTS.clear()
        server.PERMIT_VALUES.clear()
        server.REUSABLE_CODE_EVENTS.clear()
        server.REUSABLE_CODE_VALUES.clear()
        self._orig_run = server.cqu_atrust.run_atrust_login
        self._orig_should = server.should_use_proxy
        self._orig_acquire = server.acquire_qg_proxy
        server.should_use_proxy = lambda _profile: False

    def tearDown(self):
        server.cqu_atrust.run_atrust_login = self._orig_run
        server.should_use_proxy = self._orig_should
        server.acquire_qg_proxy = self._orig_acquire
        server.CODE_EVENTS.clear()
        server.CODE_VALUES.clear()
        server.PERMIT_EVENTS.clear()
        server.PERMIT_VALUES.clear()
        server.REUSABLE_CODE_EVENTS.clear()
        server.REUSABLE_CODE_VALUES.clear()
        super().tearDown()

    async def test_early_permit_is_consumed_and_fixed_login_contract_returns_state_only(self):
        captured = {}

        async def fake_run(**kwargs):
            captured.update(kwargs)
            await kwargs["permit_provider"]()
            return {"state": {"cookies": [], "origins": []}}

        server.cqu_atrust.run_atrust_login = fake_run

        permit = await self.client.post(
            "/code-permit", json={"session": _BODY["session"]}
        )
        assert permit.status == 200

        resp = await self.client.post(
            "/atrust-login",
            json={
                **_BODY,
                "service": "https://evil.example/capture",
                "entryUrl": "https://evil.example/entry",
            },
        )
        assert resp.status == 200
        assert await resp.json() == {
            "ok": True,
            "state": {"cookies": [], "origins": []},
        }
        assert captured["student_id"] == _BODY["studentId"]
        assert captured["proxy"] is None
        assert "service" not in captured
        assert "entryUrl" not in captured
        assert _BODY["session"] not in server.PERMIT_EVENTS
        assert _BODY["session"] not in server.PERMIT_VALUES
        assert _BODY["session"] not in server.CODE_EVENTS
        assert _BODY["session"] not in server.CODE_VALUES

    async def test_missing_credentials_returns_400(self):
        resp = await self.client.post(
            "/atrust-login", json={"studentId": "20201234"}
        )
        assert resp.status == 400

    async def test_password_rejection_uses_controlled_error(self):
        async def rejected(**_kwargs):
            raise server.cqu_atrust.AtrustPasswordRejectedError(
                "private diagnostic must not escape"
            )

        server.cqu_atrust.run_atrust_login = rejected
        resp = await self.client.post("/atrust-login", json=_BODY)
        assert resp.status == 401
        assert await resp.json() == {"ok": False, "error": "PASSWORD_REJECTED"}

    async def test_transient_error_and_logs_do_not_expose_token_or_exception_text(self):
        async def failed(**_kwargs):
            raise RuntimeError("password=SECRET cookie=SECRET")

        server.cqu_atrust.run_atrust_login = failed
        with self.assertLogs("cqu-login-server", level="INFO") as logs:
            resp = await self.client.post("/atrust-login", json=_BODY)
        assert resp.status == 502
        assert await resp.json() == {"ok": False, "error": "ATRUST_TRANSIENT"}
        joined = "\n".join(logs.output)
        assert _BODY["session"] not in joined
        assert "SECRET" not in joined

    async def test_code_permit_requires_session(self):
        resp = await self.client.post("/code-permit", json={})
        assert resp.status == 400

    async def test_health_advertises_the_node_api_version_before_worker_cutover(self):
        resp = await self.client.get("/health")
        assert resp.status == 200
        body = await resp.json()
        assert body["ok"] is True
        assert body["apiVersion"] == "atrust-harvest-v1"
        assert set(body["capabilities"]) >= {
            "atrust-login",
            "code-permit",
            "reusable-code",
            "data-harvest",
        }

    async def test_early_reusable_code_is_reserved_for_already_valid_flow(self):
        async def fake_run(**kwargs):
            await kwargs["permit_provider"]()
            code = await kwargs["reusable_code_provider"]()
            assert code == "123456"
            return {"state": {"cookies": [], "origins": []}}

        server.cqu_atrust.run_atrust_login = fake_run

        code = await self.client.post(
            "/code",
            json={
                "session": _BODY["session"],
                "code": "123456",
                "reusable": True,
            },
        )
        assert code.status == 200
        permit = await self.client.post(
            "/code-permit", json={"session": _BODY["session"]}
        )
        assert permit.status == 200

        resp = await self.client.post("/atrust-login", json=_BODY)
        assert resp.status == 200
        assert await resp.json() == {
            "ok": True,
            "state": {"cookies": [], "origins": []},
        }
        assert _BODY["session"] not in server.REUSABLE_CODE_VALUES


def test_fifo_wait_budget_is_separate_from_the_promoted_owners_login_budget():
    assert server.PERMIT_WAIT_TIMEOUT > server.RUN_TOTAL_TIMEOUT
    assert server.PERMIT_PHASE_TIMEOUT > server.PERMIT_WAIT_TIMEOUT
