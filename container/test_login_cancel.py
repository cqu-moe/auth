"""Boot-scoped cancellation contract for login runs."""

import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from aiohttp.test_utils import AioHTTPTestCase

import browser_profile
import server


BODY = {
    "studentId": "20201234",
    "password": "pw",
    "service": "https://my.cqu.edu.cn/",
    "method": "mail",
    "session": "cancel-token",
    "operationTimeoutMs": 30_000,
}


class LoginCancelTests(AioHTTPTestCase):
    async def get_application(self):
        return server.build_app()

    def setUp(self):
        super().setUp()
        self.old_profile = browser_profile.CLOUDFLARE_PROFILE
        self.old_run_login = server.cqu_login.run_login
        self.old_should_proxy = server.should_use_proxy
        self.old_acquire_proxy = server.acquire_qg_proxy
        self.old_cancel_wait = server.LOGIN_CANCEL_WAIT
        browser_profile.CLOUDFLARE_PROFILE = True
        server.should_use_proxy = lambda _profile: False
        server.BROWSER_JOB_LOCK = asyncio.Lock()
        server.LOGIN_RUNS.clear()
        server.LOGIN_TOMBSTONES.clear()

    def tearDown(self):
        browser_profile.CLOUDFLARE_PROFILE = self.old_profile
        server.cqu_login.run_login = self.old_run_login
        server.should_use_proxy = self.old_should_proxy
        server.acquire_qg_proxy = self.old_acquire_proxy
        server.LOGIN_CANCEL_WAIT = self.old_cancel_wait
        server.LOGIN_RUNS.clear()
        server.LOGIN_TOMBSTONES.clear()
        super().tearDown()

    def headers(self, boot=None):
        return {server.BOOT_HEADER: boot or server.BOOT_ID}

    async def test_cancel_waits_for_login_finally_before_acknowledging_stopped(self):
        started = asyncio.Event()
        cleanup_started = asyncio.Event()
        allow_cleanup = asyncio.Event()

        async def login(**_kwargs):
            started.set()
            try:
                await asyncio.Future()
            finally:
                cleanup_started.set()
                await allow_cleanup.wait()

        server.cqu_login.run_login = login
        run = asyncio.create_task(self.client.post("/run", json=BODY, headers=self.headers()))
        await started.wait()
        cancel = asyncio.create_task(self.client.post(
            "/login-cancel", json={"session": BODY["session"]}, headers=self.headers()
        ))
        await cleanup_started.wait()
        await asyncio.sleep(0)
        assert not cancel.done()
        allow_cleanup.set()
        response = await cancel
        assert response.status == 200
        assert await response.json() == {
            "ok": True, "stopped": True, "mayHaveRequestedCode": False
        }
        await asyncio.gather(run, return_exceptions=True)
        assert not server.BROWSER_JOB_LOCK.locked()

    async def test_cancel_before_run_retires_token_and_blocks_control_messages(self):
        cancel = await self.client.post(
            "/login-cancel", json={"session": "future"}, headers=self.headers()
        )
        assert cancel.status == 200
        assert await cancel.json() == {
            "ok": True, "stopped": True, "mayHaveRequestedCode": False
        }
        run = await self.client.post("/run", json={**BODY, "session": "future"}, headers=self.headers())
        code = await self.client.post(
            "/code", json={"session": "future", "code": "123456"}, headers=self.headers()
        )
        permit = await self.client.post(
            "/code-permit", json={"session": "future"}, headers=self.headers()
        )
        assert run.status == code.status == permit.status == 409
        assert (await run.json())["error"] == "LOGIN_SESSION_RETIRED"

    async def test_repeated_cancel_is_idempotent(self):
        for _ in range(2):
            response = await self.client.post(
                "/login-cancel", json={"session": "same"}, headers=self.headers()
            )
            assert response.status == 200
            assert await response.json() == {
                "ok": True, "stopped": True, "mayHaveRequestedCode": False
            }

    async def test_cancel_does_not_interrupt_another_login_token(self):
        first = asyncio.create_task(asyncio.sleep(30))
        other = asyncio.create_task(asyncio.sleep(30))
        server.LOGIN_RUNS["first"] = {
            "task": first, "cancel_requested": False, "may_have_requested_code": False
        }
        server.LOGIN_RUNS["other"] = {
            "task": other, "cancel_requested": False, "may_have_requested_code": False
        }
        response = await self.client.post(
            "/login-cancel", json={"session": "first"}, headers=self.headers()
        )
        assert response.status == 200
        assert first.cancelled()
        assert not other.done()
        other.cancel()
        await asyncio.gather(other, return_exceptions=True)

    async def test_stale_boot_cancel_does_not_retire_or_cancel(self):
        response = await self.client.post(
            "/login-cancel", json={"session": "future"}, headers=self.headers("old-boot")
        )
        assert response.status == 409
        assert "future" not in server.LOGIN_TOMBSTONES

    async def test_duplicate_run_token_cannot_start_twice(self):
        started = asyncio.Event()
        release = asyncio.Event()
        starts = 0

        async def login(**_kwargs):
            nonlocal starts
            starts += 1
            started.set()
            await release.wait()
            return {"state": {"cookies": [], "origins": []}}

        server.cqu_login.run_login = login
        first = asyncio.create_task(self.client.post("/run", json=BODY, headers=self.headers()))
        await started.wait()
        duplicate = await self.client.post("/run", json=BODY, headers=self.headers())
        assert duplicate.status == 409
        assert (await duplicate.json())["error"] == "LOGIN_SESSION_ACTIVE"
        assert starts == 1
        release.set()
        assert (await first).status == 200
        replay = await self.client.post("/run", json=BODY, headers=self.headers())
        assert replay.status == 409
        assert (await replay.json())["error"] == "LOGIN_SESSION_RETIRED"

    async def test_cancel_interrupts_pending_proxy_acquire_only_for_matching_token(self):
        proxy_started = asyncio.Event()
        other_started = asyncio.Event()

        server.should_use_proxy = lambda _profile: True

        async def acquire(_profile="login"):
            proxy_started.set()
            await asyncio.Future()

        async def login(**_kwargs):
            other_started.set()
            await asyncio.Future()

        server.acquire_qg_proxy = acquire
        server.cqu_login.run_login = login
        pending = asyncio.create_task(self.client.post("/run", json=BODY, headers=self.headers()))
        await proxy_started.wait()
        response = await self.client.post(
            "/login-cancel", json={"session": BODY["session"]}, headers=self.headers()
        )
        assert response.status == 200
        assert await response.json() == {
            "ok": True, "stopped": True, "mayHaveRequestedCode": False
        }
        await asyncio.gather(pending, return_exceptions=True)
        assert not other_started.is_set()

    async def test_cleanup_timeout_does_not_claim_stopped_and_retry_can_finish(self):
        started = asyncio.Event()
        cleanup_started = asyncio.Event()
        allow_cleanup = asyncio.Event()
        server.LOGIN_CANCEL_WAIT = 0.01

        async def login(**_kwargs):
            started.set()
            try:
                await asyncio.Future()
            finally:
                cleanup_started.set()
                await allow_cleanup.wait()

        server.cqu_login.run_login = login
        run = asyncio.create_task(self.client.post("/run", json=BODY, headers=self.headers()))
        await started.wait()
        first = await self.client.post(
            "/login-cancel", json={"session": BODY["session"]}, headers=self.headers()
        )
        assert first.status == 503
        assert await first.json() == {
            "ok": False,
            "stopped": False,
            "error": "LOGIN_CLEANUP_PENDING",
            "mayHaveRequestedCode": False,
        }
        assert cleanup_started.is_set()
        assert not run.done()
        server.LOGIN_CANCEL_WAIT = 1
        retry = asyncio.create_task(self.client.post(
            "/login-cancel", json={"session": BODY["session"]}, headers=self.headers()
        ))
        await asyncio.sleep(0)
        assert not retry.done()
        allow_cleanup.set()
        retry_response = await retry
        assert retry_response.status == 200
        assert await retry_response.json() == {
            "ok": True, "stopped": True, "mayHaveRequestedCode": False
        }
        await asyncio.gather(run, return_exceptions=True)

    async def test_cancel_after_permit_claim_reports_code_request_risk(self):
        login_started = asyncio.Event()
        permit_returned = asyncio.Event()

        async def login(**kwargs):
            login_started.set()
            await kwargs["permit_provider"]()
            permit_returned.set()
            await asyncio.Future()

        server.cqu_login.run_login = login
        run = asyncio.create_task(self.client.post("/run", json=BODY, headers=self.headers()))
        await login_started.wait()
        permit = await self.client.post(
            "/code-permit", json={"session": BODY["session"]}, headers=self.headers()
        )
        assert permit.status == 200
        await permit_returned.wait()
        cancel = await self.client.post(
            "/login-cancel", json={"session": BODY["session"]}, headers=self.headers()
        )
        assert await cancel.json() == {
            "ok": True, "stopped": True, "mayHaveRequestedCode": True
        }
        repeated = await self.client.post(
            "/login-cancel", json={"session": BODY["session"]}, headers=self.headers()
        )
        assert await repeated.json() == {
            "ok": True, "stopped": True, "mayHaveRequestedCode": True
        }
        await asyncio.gather(run, return_exceptions=True)

    async def test_health_advertises_login_cancel(self):
        response = await self.client.get("/health")
        assert "login-cancel-v1" in (await response.json())["capabilities"]
