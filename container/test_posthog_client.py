import unittest
from types import SimpleNamespace
from unittest.mock import ANY, Mock, patch

from aiohttp import web
import asyncio

from posthog_client import (
    POSTHOG_CLIENT_KEY,
    flush_posthog,
    mark_business_outcome,
    posthog_exception_middleware,
    safe_capture_exception,
    sanitize_event,
)


class PostHogPrivacyTests(unittest.TestCase):
    def test_sanitize_event_uses_the_v2_property_allowlist(self):
        event = sanitize_event({
            "event": "$exception",
            "properties": {
                "product": "auth",
                "password": "secret-password",
                "cookie": "secret-cookie",
                "studentId": "2026000000",
                "email": "user@example.com",
                "url": "https://auth.cqu.moe/run?token=secret-token#fragment",
                "exception": {"message": "code=123456 ticket=secret-ticket", "stack": "safe-stack"},
                "$exception_message": "password=secret-password",
                "$exception_stack_trace": "Error: ticket=secret-ticket",
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
        self.assertEqual(
            event["properties"],
            {"product": "auth", "$geoip_disable": True, "$exception_list": [{
                "type": "Error", "value": "Browser operation failed",
                "mechanism": {"type": "generic", "handled": True},
            }]},
        )

    def test_exception_capture_uses_synthetic_message_without_original_traceback(self):
        client = Mock()
        try:
            raise ValueError("password=secret-password ticket=secret-ticket")
        except ValueError as error:
            safe_capture_exception(client, error, {"error_code": "SAFE_FAILURE"})

        args, kwargs = client.capture_exception.call_args
        _, safe_error, traceback = args[0]
        serialized = repr((args, kwargs))
        self.assertIsNone(traceback)
        self.assertEqual(str(safe_error), "[redacted]")
        self.assertNotIn("secret-password", serialized)
        self.assertNotIn("secret-ticket", serialized)
        self.assertEqual(kwargs["properties"]["$exception_type"], "ValueError")

    def test_empty_timeout_preserves_safe_error_tracking_contract(self):
        client = Mock()
        safe_capture_exception(client, TimeoutError(), {"error_class": "untrusted"})
        args, kwargs = client.capture_exception.call_args
        kind, error, traceback = args[0]
        self.assertIs(kind, RuntimeError)
        self.assertEqual(str(error), "[redacted]")
        self.assertIsNone(traceback)
        self.assertIsNone(error.__cause__)
        self.assertIsNone(error.__context__)
        self.assertEqual(kwargs["properties"]["$exception_type"], "TimeoutError")
        self.assertNotIn("error_class", kwargs["properties"])
        event = sanitize_event({"event": "$exception", "properties": kwargs["properties"]})
        self.assertEqual(event["properties"]["$exception_list"], [{
            "type": "TimeoutError", "value": "Browser operation failed",
            "mechanism": {"type": "generic", "handled": True},
        }])

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
        self.assertEqual(client.capture.call_args.kwargs["properties"]["outcome"], "failure")

    async def test_browser_operation_reports_duration_without_response_secrets(self):
        client = Mock()
        request = SimpleNamespace(app={POSTHOG_CLIENT_KEY: client}, method="POST", path="/data-harvest")
        response = web.json_response({"ok": True, "state": {"cookies": [{"value": "private-cookie"}]}, "captures": [{"studentId": "private-student"}]})

        async def handler(_request):
            return response

        env_values = {"ENVIRONMENT": "development", "RELEASE": "development"}
        with patch("posthog_client.os.getenv", side_effect=lambda name, default=None: env_values.get(name, default)), \
             patch("posthog_client.monotonic", side_effect=[100.0, 101.25], create=True):
            self.assertIs(await posthog_exception_middleware(request, handler), response)
        client.capture.assert_called_once()
        args, kwargs = client.capture.call_args
        self.assertEqual(args, ("browser_operation_completed",))
        self.assertEqual(kwargs["properties"], {
            "telemetry_version": 2,
            "product": "auth",
            "surface": "container",
            "environment": "development",
            "release": "development",
            "actor_type": "system",
            "trigger": "automatic",
            "operation": "harvest",
            "operation_id": ANY,
            "outcome": "unverified",
            "business_outcome": "unverified",
            "http_outcome": "success",
            "duration_ms": 1250,
            "duration_basis": "request",
            "http_status": 200,
            "$process_person_profile": False,
        })
        self.assertNotIn("private", repr(kwargs))

    async def test_business_marker_is_reported_separately_from_http_outcome(self):
        client = Mock()
        request = SimpleNamespace(app={POSTHOG_CLIENT_KEY: client}, method="POST", path="/run")
        response = web.json_response({"ok": False, "errorCode": "SCHOOL_UNREACHABLE"}, status=200)

        async def handler(_request):
            mark_business_outcome("failure", "SCHOOL_UNREACHABLE")
            return response

        with patch("posthog_client.monotonic", side_effect=[100.0, 100.25], create=True):
            self.assertIs(await posthog_exception_middleware(request, handler), response)

        properties = client.capture.call_args.kwargs["properties"]
        self.assertEqual(properties["http_outcome"], "success")
        self.assertEqual(properties["business_outcome"], "failure")
        self.assertEqual(properties["error_code"], "SCHOOL_UNREACHABLE")

    async def test_cancelled_browser_operation_is_recorded_without_swallowing_cancellation(self):
        client = Mock()
        request = SimpleNamespace(app={POSTHOG_CLIENT_KEY: client}, method="POST", path="/run")

        async def handler(_request):
            raise asyncio.CancelledError()

        with self.assertRaises(asyncio.CancelledError):
            await posthog_exception_middleware(request, handler)
        client.capture.assert_called_once()
        self.assertEqual(client.capture.call_args.kwargs["properties"]["http_outcome"], "canceled")

    async def test_operation_telemetry_failure_preserves_business_response(self):
        client = Mock()
        client.capture.side_effect = RuntimeError("telemetry unavailable")
        request = SimpleNamespace(app={POSTHOG_CLIENT_KEY: client}, method="POST", path="/run")
        response = web.json_response({"ok": False, "errorCode": "WAF_CHALLENGE"}, status=503)

        async def handler(_request):
            return response

        self.assertIs(await posthog_exception_middleware(request, handler), response)
        client.capture.assert_called_once()
        self.assertEqual(client.capture.call_args.kwargs["properties"]["http_outcome"], "failure")

    async def test_health_and_control_requests_do_not_emit_browser_operations(self):
        client = Mock()
        async def handler(_request):
            return web.json_response({"ok": True})
        for endpoint in ("/health", "/ping", "/code", "/code-permit"):
            request = SimpleNamespace(app={POSTHOG_CLIENT_KEY: client}, method="POST", path=endpoint)
            await posthog_exception_middleware(request, handler)
        client.capture.assert_not_called()

    async def test_cleanup_uses_bounded_flush(self):
        client = Mock()
        app = {POSTHOG_CLIENT_KEY: client}

        await flush_posthog(app)

        client.flush.assert_called_once_with(timeout_seconds=2)


if __name__ == "__main__":
    unittest.main()
