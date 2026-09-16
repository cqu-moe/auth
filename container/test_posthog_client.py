import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from posthog_client import (
    POSTHOG_CLIENT_KEY,
    flush_posthog,
    posthog_exception_middleware,
    safe_capture_exception,
    sanitize_event,
)


class PostHogPrivacyTests(unittest.TestCase):
    def test_sanitize_event_removes_nested_secrets_and_personal_data(self):
        event = sanitize_event({
            "event": "$exception",
            "properties": {
                "service": "auth-python",
                "password": "secret-password",
                "cookie": "secret-cookie",
                "studentId": "2026000000",
                "email": "user@example.com",
                "url": "https://auth.cqu.moe/run?token=secret-token#fragment",
                "exception": {"message": "code=123456 ticket=secret-ticket", "stack": "safe-stack"},
            },
        })

        serialized = repr(event)
        for secret in (
            "secret-password",
            "secret-cookie",
            "2026000000",
            "user@example.com",
            "secret-token",
            "123456",
            "secret-ticket",
        ):
            self.assertNotIn(secret, serialized)
        self.assertEqual(event["properties"]["url"], "https://auth.cqu.moe/run")
        self.assertEqual(event["properties"]["exception"]["stack"], "safe-stack")

    def test_capture_failure_does_not_replace_the_business_exception(self):
        client = Mock()
        client.capture_exception.side_effect = RuntimeError("telemetry unavailable")
        business_error = ValueError("safe business failure")

        safe_capture_exception(client, business_error, {"error_code": "SAFE_FAILURE"})

        client.capture_exception.assert_called_once()


class PostHogLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_middleware_reports_and_reraises_unexpected_exception(self):
        client = Mock()
        request = SimpleNamespace(
            app={POSTHOG_CLIENT_KEY: client},
            method="POST",
            path="/run",
        )
        business_error = RuntimeError("safe synthetic failure")

        async def handler(_request):
            raise business_error

        with self.assertRaises(RuntimeError) as raised:
            await posthog_exception_middleware(request, handler)

        self.assertIs(raised.exception, business_error)
        client.capture_exception.assert_called_once()

    async def test_cleanup_uses_bounded_flush(self):
        client = Mock()
        app = {POSTHOG_CLIENT_KEY: client}

        await flush_posthog(app)

        client.flush.assert_called_once_with(timeout_seconds=2)


if __name__ == "__main__":
    unittest.main()
