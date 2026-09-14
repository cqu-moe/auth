"""CF profile 的 bootId 协议、单任务互斥与 operationTimeoutMs 取消语义。"""

import asyncio
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from aiohttp.test_utils import AioHTTPTestCase

import browser_profile
import server


def _clear_code_state():
    server.CODE_EVENTS.clear()
    server.CODE_VALUES.clear()
    server.REUSABLE_CODE_EVENTS.clear()
    server.REUSABLE_CODE_VALUES.clear()
    server.PERMIT_EVENTS.clear()
    server.PERMIT_VALUES.clear()


class BrowserRuntimeTestCase(AioHTTPTestCase):
    """共用脚手架:CF profile + 每测试重置单任务锁(绑定各自事件循环)。"""

    def setUp(self):
        super().setUp()
        _clear_code_state()
        server.BROWSER_JOB_LOCK = asyncio.Lock()
        self._orig_cloudflare = browser_profile.CLOUDFLARE_PROFILE
        browser_profile.CLOUDFLARE_PROFILE = True
        self._orig_run_login = server.cqu_login.run_login
        self._orig_probe = server.cqu_keepalive.probe_session_browser
        self._orig_should = server.should_use_proxy
        server.should_use_proxy = lambda _profile: False

    def tearDown(self):
        browser_profile.CLOUDFLARE_PROFILE = self._orig_cloudflare
        server.cqu_login.run_login = self._orig_run_login
        server.cqu_keepalive.probe_session_browser = self._orig_probe
        server.should_use_proxy = self._orig_should
        _clear_code_state()
        super().tearDown()

    async def get_application(self):
        return server.build_app()

    def boot_headers(self):
        return {"X-Cqu-Expected-Boot-Id": server.BOOT_ID}


class BootGuardTests(BrowserRuntimeTestCase):
    async def test_stale_boot_code_is_rejected_without_touching_code_dicts(self):
        resp = await self.client.post(
            "/code",
            json={"session": "tok", "code": "123456"},
            headers={"X-Cqu-Expected-Boot-Id": "stale-boot"},
        )
        assert resp.status == 409
        assert await resp.json() == {"ok": False, "error": "BROWSER_INSTANCE_REPLACED"}
        assert server.CODE_VALUES == {}
        assert server.CODE_EVENTS == {}
        assert server.REUSABLE_CODE_VALUES == {}

    async def test_missing_boot_header_is_rejected_on_cloudflare_profile(self):
        resp = await self.client.post("/code", json={"session": "tok", "code": "123456"})
        assert resp.status == 409
        assert server.CODE_VALUES == {}

    async def test_permit_with_stale_boot_is_rejected_before_mutation(self):
        resp = await self.client.post(
            "/code-permit",
            json={"session": "tok"},
            headers={"X-Cqu-Expected-Boot-Id": "stale-boot"},
        )
        assert resp.status == 409
        assert server.PERMIT_VALUES == {}

    async def test_health_reports_boot_profile_and_capabilities(self):
        for _ in range(2):
            resp = await self.client.get("/health")
            assert resp.status == 200
            payload = await resp.json()
            assert payload["apiVersion"] == "direct-harvest-v1"
            assert payload["bootId"] == server.BOOT_ID
            assert payload["browserProfile"] == "cloudflare"
            assert "browser-route-v1" in payload["capabilities"]
            assert "operation-deadline-v1" in payload["capabilities"]
            assert "raw-cdp-login-v1" in payload["capabilities"]


class SingleHeavyJobTests(BrowserRuntimeTestCase):
    async def test_second_heavy_request_gets_busy_while_first_blocks(self):
        release = asyncio.Event()
        finished = asyncio.Event()

        async def fake_run(**kwargs):
            try:
                await release.wait()
                return {"state": {"cookies": [], "origins": []}}
            finally:
                finished.set()

        server.cqu_login.run_login = fake_run
        first = asyncio.create_task(
            self.client.post(
                "/run",
                json={
                    "studentId": "20201234",
                    "password": "pw",
                    "service": "https://my.cqu.edu.cn/",
                    "method": "mail",
                    "session": "tok-a",
                    "operationTimeoutMs": 30_000,
                },
                headers=self.boot_headers(),
            )
        )
        await asyncio.sleep(0.05)
        busy = await self.client.post(
            "/data-harvest",
            json={
                "state": {"cookies": [], "origins": []},
                "navUrl": "https://my.cqu.edu.cn/workspace/curriculum",
                "capture": ["my-table-detail"],
                "fetch": [],
                "operationTimeoutMs": 30_000,
            },
            headers=self.boot_headers(),
        )
        assert busy.status == 503
        assert await busy.json() == {"ok": False, "error": "BROWSER_BUSY"}
        release.set()
        assert (await first).status == 200
        await asyncio.wait_for(finished.wait(), timeout=2)

    async def test_code_and_permit_work_while_heavy_job_waits_for_code(self):
        got_code = asyncio.Event()

        async def fake_run(**kwargs):
            await kwargs["permit_provider"]()
            code = await kwargs["code_provider"]()
            assert code == "654321"
            got_code.set()
            return {"state": {"cookies": [], "origins": []}, "ticket": "ST-x"}

        server.cqu_login.run_login = fake_run
        login = asyncio.create_task(
            self.client.post(
                "/run",
                json={
                    "studentId": "20201234",
                    "password": "pw",
                    "service": "https://my.cqu.edu.cn/",
                    "method": "mail",
                    "session": "tok-b",
                    "operationTimeoutMs": 30_000,
                },
                headers=self.boot_headers(),
            )
        )
        await asyncio.sleep(0.05)
        permit = await self.client.post(
            "/code-permit", json={"session": "tok-b"}, headers=self.boot_headers()
        )
        assert permit.status == 200
        code = await self.client.post(
            "/code", json={"session": "tok-b", "code": "654321"}, headers=self.boot_headers()
        )
        assert code.status == 200
        resp = await asyncio.wait_for(login, timeout=2)
        assert resp.status == 200
        assert await got_code.wait()


class DeadlineTests(BrowserRuntimeTestCase):
    async def test_deadline_cancels_real_work_runs_finally_and_clears_state(self):
        cancelled = asyncio.Event()

        async def blocked_login(**kwargs):
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        server.cqu_login.run_login = blocked_login
        resp = await self.client.post(
            "/run",
            json={
                "studentId": "20201234",
                "password": "pw",
                "service": "https://my.cqu.edu.cn/",
                "method": "mail",
                "session": "tok-c",
                "operationTimeoutMs": 20,
            },
            headers=self.boot_headers(),
        )
        assert resp.status == 503
        assert await resp.json() == {"ok": False, "error": "BROWSER_DEADLINE"}
        assert await asyncio.wait_for(cancelled.wait(), timeout=2)
        assert "tok-c" not in server.CODE_EVENTS
        assert "tok-c" not in server.CODE_VALUES
        assert "tok-c" not in server.REUSABLE_CODE_EVENTS
        assert "tok-c" not in server.REUSABLE_CODE_VALUES
        assert "tok-c" not in server.PERMIT_EVENTS
        assert "tok-c" not in server.PERMIT_VALUES

        async def quick_login(**kwargs):
            return {"state": {"cookies": [], "origins": []}}

        server.cqu_login.run_login = quick_login
        second = await self.client.post(
            "/run",
            json={
                "studentId": "20201234",
                "password": "pw",
                "service": "https://my.cqu.edu.cn/",
                "method": "mail",
                "session": "tok-c2",
                "operationTimeoutMs": 30_000,
            },
            headers=self.boot_headers(),
        )
        assert second.status == 200

    async def test_exception_releases_lock_for_next_heavy_request(self):
        calls = []

        async def flaky_probe(state):
            calls.append(state)
            if len(calls) == 1:
                raise RuntimeError("browser exploded")
            return {"status": "alive", "state": state}

        server.cqu_keepalive.probe_session_browser = flaky_probe
        state = {"cookies": [], "origins": []}
        first = await self.client.post(
            "/keepalive",
            json={"state": state, "operationTimeoutMs": 30_000},
            headers=self.boot_headers(),
        )
        assert first.status == 200
        assert (await first.json())["status"] == "unreachable"
        second = await self.client.post(
            "/keepalive",
            json={"state": state, "operationTimeoutMs": 30_000},
            headers=self.boot_headers(),
        )
        assert second.status == 200
        assert (await second.json())["status"] == "alive"

    async def test_cancelled_waiter_never_releases_another_jobs_lock(self):
        acquired = await server.acquire_browser_job()
        assert acquired is True
        try:
            server.release_browser_job(False)
            assert server.BROWSER_JOB_LOCK.locked() is True
        finally:
            server.release_browser_job(True)
        assert server.BROWSER_JOB_LOCK.locked() is False


class OperationTimeoutValidationTests(BrowserRuntimeTestCase):
    async def test_cloudflare_heavy_requests_require_operation_timeout(self):
        resp = await self.client.post(
            "/keepalive",
            json={"state": {"cookies": [], "origins": []}},
            headers=self.boot_headers(),
        )
        assert resp.status == 400
        assert "operationTimeoutMs" in (await resp.json())["error"]

    async def test_invalid_operation_timeout_values_are_rejected(self):
        state = {"cookies": [], "origins": []}
        for bad in ["2000", 20.5, True, False, 0, -1, 780_001]:
            resp = await self.client.post(
                "/keepalive",
                json={"state": state, "operationTimeoutMs": bad},
                headers=self.boot_headers(),
            )
            assert resp.status == 400, bad

    async def test_nan_operation_timeout_is_rejected(self):
        resp = await self.client.post(
            "/keepalive",
            data='{"state": {"cookies": [], "origins": []}, "operationTimeoutMs": NaN}',
            headers=self.boot_headers(),
        )
        assert resp.status == 400

    async def test_boundary_operation_timeouts_are_accepted(self):
        probe_calls = []

        async def quick_probe(state):
            probe_calls.append(state)
            return {"status": "alive", "state": state}

        server.cqu_keepalive.probe_session_browser = quick_probe
        state = {"cookies": [], "origins": []}
        for good in [1, 780_000]:
            resp = await self.client.post(
                "/keepalive",
                json={"state": state, "operationTimeoutMs": good},
                headers=self.boot_headers(),
            )
            assert resp.status == 200, good
        assert len(probe_calls) == 2


def test_new_process_gets_a_new_boot_id():
    container_dir = os.path.dirname(os.path.abspath(__file__))
    probe = (
        "import sys; sys.path.insert(0, sys.argv[1]); "
        "import server; print(server.BOOT_ID)"
    )
    first = subprocess.run(
        [sys.executable, "-c", probe, container_dir],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    second = subprocess.run(
        [sys.executable, "-c", probe, container_dir],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    assert first != second
    assert len(first) == 32 and len(second) == 32


class DomesticCompatTests(AioHTTPTestCase):
    """国内 default profile:无新头/timeout 字段也兼容旧协议。"""

    async def get_application(self):
        return server.build_app()

    def setUp(self):
        super().setUp()
        _clear_code_state()
        server.BROWSER_JOB_LOCK = asyncio.Lock()
        self._orig_cloudflare = browser_profile.CLOUDFLARE_PROFILE
        browser_profile.CLOUDFLARE_PROFILE = False
        self._orig_run_login = server.cqu_login.run_login
        self._orig_should = server.should_use_proxy
        server.should_use_proxy = lambda _profile: False

    def tearDown(self):
        browser_profile.CLOUDFLARE_PROFILE = self._orig_cloudflare
        server.cqu_login.run_login = self._orig_run_login
        server.should_use_proxy = self._orig_should
        _clear_code_state()
        super().tearDown()

    async def test_run_without_boot_header_or_timeout_keeps_legacy_contract(self):
        async def fake_run(**kwargs):
            await kwargs["permit_provider"]()
            return {"state": {"cookies": [], "origins": []}, "ticket": "ST-legacy"}

        server.cqu_login.run_login = fake_run
        permit = await self.client.post("/code-permit", json={"session": "legacy"})
        assert permit.status == 200
        resp = await self.client.post(
            "/run",
            json={
                "studentId": "20201234",
                "password": "pw",
                "service": "https://my.cqu.edu.cn/",
                "method": "mail",
                "session": "legacy",
            },
        )
        assert resp.status == 200
        payload = await resp.json()
        assert payload["ok"] is True
        assert payload["ticket"] == "ST-legacy"
