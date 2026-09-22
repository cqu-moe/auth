"""Actual raw-CDP error strings cross the production /run response boundary."""
import json
from pathlib import Path

from test_browser_runtime import BrowserRuntimeTestCase
import server

FIXTURES = json.loads((Path(__file__).parent / "fixtures/login-failures.json").read_text())


class LoginFailureContractTests(BrowserRuntimeTestCase):
    async def test_cleanup_failure_reports_temporary_container_unavailability(self):
        async def failed_login(**_kwargs):
            raise RuntimeError("BROWSER_CLEANUP_FAILED")

        server.cqu_login.run_login = failed_login
        response = await self.client.post(
            "/run",
            json={"studentId": "synthetic-student", "password": "synthetic-password",
                  "service": "https://my.cqu.edu.cn/", "method": "mail",
                  "session": "cleanup-failure", "operationTimeoutMs": 1000},
            headers=self.boot_headers(),
        )
        payload = await response.json()
        assert payload["error"] == payload["errorCode"] == "CONTAINER_UNAVAILABLE"
        assert payload["phase"] == "launching_browser"

    async def test_raw_cdp_failures_produce_safe_structured_responses(self):
        for fixture in FIXTURES:
            with self.subTest(case=fixture["id"]):
                async def failed_login(**_kwargs):
                    raise RuntimeError(fixture["raw"])

                server.cqu_login.run_login = failed_login
                response = await self.client.post(
                    "/run",
                    json={"studentId": "synthetic-student", "password": "synthetic-password",
                          "service": "https://my.cqu.edu.cn/", "method": "mail",
                          "session": f"fixture-{fixture['id']}", "operationTimeoutMs": 1000},
                    headers=self.boot_headers(),
                )
                assert await response.json() == fixture["response"]

    async def test_unknown_failure_does_not_echo_sensitive_details_or_log_them(self):
        raw = "synthetic-password token=synthetic-token https://example.invalid/?ticket=synthetic-ticket"

        async def failed_login(**_kwargs):
            raise RuntimeError(raw)

        server.cqu_login.run_login = failed_login
        with self.assertLogs(server.log, level="WARNING") as logs:
            response = await self.client.post(
                "/run",
                json={"studentId": "synthetic-student", "password": "synthetic-password",
                      "service": "https://my.cqu.edu.cn/", "method": "mail",
                      "session": "safe-unknown", "operationTimeoutMs": 1000},
                headers=self.boot_headers(),
            )
        payload = await response.json()
        assert payload["errorCode"] == "UNKNOWN_LOGIN_ERROR"
        for sensitive in ("synthetic-password", "synthetic-token", "synthetic-ticket", "example.invalid"):
            assert sensitive not in json.dumps(payload)
            assert sensitive not in " ".join(logs.output)
