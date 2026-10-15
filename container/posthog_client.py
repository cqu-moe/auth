import asyncio
import math
import os
import re
import uuid
from contextvars import ContextVar
from typing import Any, Mapping
from time import monotonic

from aiohttp import web
from posthog import Posthog


POSTHOG_CLIENT_KEY = web.AppKey("posthog_client", object)
BROWSER_OPERATIONS = {
    "/run": "login",
    "/service-ticket": "ticket",
    "/keepalive": "keepalive",
    "/data-harvest": "harvest",
    "/external-search": "external_search",
    "/external-directory": "external_directory",
    "/external-capture": "external_capture",
}
REDACTED = "[redacted]"
EMAIL = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE)
LABELED_SECRET = re.compile(
    r"\b(password|cookie|authorization|token|student_?id|email|otp|code|ticket)\s*[:=]\s*[^\s,;&]+",
    re.IGNORECASE,
)
BEARER = re.compile(r"\bBearer\s+[^\s,;&]+", re.IGNORECASE)
PROPERTY_ALLOWLIST = {
    "telemetry_version",
    "is_test",
    "product",
    "surface",
    "environment",
    "release",
    "actor_type",
    "trigger",
    "operation",
    "operation_id",
    "stage",
    "outcome",
    "business_outcome",
    "http_outcome",
    "http_status",
    "duration_ms",
    "duration_basis",
    "error_code",
    "warning_code",
    "method",
    "route",
    "$process_person_profile",
    "$exception_type",
    "$exception_level",
    "$exception_is_synthetic",
    "$exception_timestamp",
    "$level",
    "$lib",
    "$lib_version",
    "$sdk",
}
_BUSINESS_OUTCOME: ContextVar[tuple[str, str | None] | None] = ContextVar(
    "cqu_posthog_business_outcome", default=None
)


def mark_business_outcome(outcome: str, error_code: str | None = None) -> None:
    """Record a bounded business result without copying a response body."""
    if outcome not in {"success", "failure", "partial", "canceled", "needs_input", "unverified"}:
        outcome = "unverified"
    _BUSINESS_OUTCOME.set((outcome, error_code))


def _sensitive_key(key: str) -> bool:
    normalized = re.sub(r"[^a-z0-9]", "", key.lower())
    return (
        normalized
        in {
            "password",
            "authorization",
            "studentid",
            "email",
            "otp",
            "code",
            "ticket",
            "schedule",
            "subscriptionurl",
        }
        or normalized.endswith(("password", "cookie", "token"))
        or (normalized.endswith("code") and normalized != "errorcode")
    )


def _redact_text(value: str) -> str:
    value = EMAIL.sub(REDACTED, value)
    value = LABELED_SECRET.sub(lambda match: f"{match.group(1)}={REDACTED}", value)
    return BEARER.sub(f"Bearer {REDACTED}", value)


def _bounded_exception_class(error: BaseException) -> str:
    normalized = re.sub(r"[^A-Za-z0-9_$]", "", type(error).__name__)
    return normalized if re.fullmatch(r"[A-Z][A-Za-z0-9_$]{0,63}", normalized) else "Error"


def _sanitize_url(value: str) -> str:
    try:
        from urllib.parse import urlsplit, urlunsplit

        parsed = urlsplit(value)
        return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))
    except ValueError:
        return _redact_text(value.split("?", 1)[0].split("#", 1)[0])


def _sanitize(value: Any, key: str = "") -> Any:
    if _sensitive_key(key):
        return REDACTED
    if isinstance(value, str):
        normalized = re.sub(r"[^a-z0-9]", "", key.lower())
        return _sanitize_url(value) if "url" in normalized or "referrer" in normalized else _redact_text(value)
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    return REDACTED


def sanitize_event(event: dict | None) -> dict | None:
    if event is None:
        return None
    properties = event.get("properties")
    if not isinstance(properties, Mapping):
        return event
    event["properties"] = {**_sanitize_properties(properties), "$geoip_disable": True}
    if event.get("event") == "$exception":
        error_type = event["properties"].get("$exception_type", "Error")
        if not isinstance(error_type, str) or not re.fullmatch(r"[A-Z][A-Za-z0-9_$]{0,63}", error_type):
            error_type = "Error"
        event["properties"]["$exception_list"] = [{
            "type": error_type,
            "value": "Browser operation failed",
            "mechanism": {"type": "generic", "handled": True},
        }]
    return event


def _sanitize_properties(properties: Mapping[Any, Any]) -> dict[str, Any]:
    return {
        key: _sanitize(value, key)
        for key, value in properties.items()
        if key in PROPERTY_ALLOWLIST
    }


def _environment() -> str:
    value = os.getenv("ENVIRONMENT", "development").strip()
    return value if value in {"production", "development", "test"} else "development"


def create_posthog_client() -> Posthog | None:
    token = os.getenv("POSTHOG_PROJECT_TOKEN", "").strip()
    if not token or (_environment() != "production" and os.getenv("POSTHOG_ENABLED") != "true"):
        return None
    return Posthog(
        project_api_key=token,
        host=os.getenv("POSTHOG_HOST", "https://p.cqu.moe"),
        enable_exception_autocapture=False,
        before_send=sanitize_event,
        max_queue_size=1000,
        max_retries=1,
        timeout=2,
        privacy_mode=True,
        disable_geoip=True,
        super_properties={
            "telemetry_version": 2,
            "product": "auth",
            "surface": "container",
            "environment": _environment(),
            "is_test": _environment() != "production",
            "release": os.getenv("RELEASE", "development"),
            "actor_type": "system",
            "trigger": "automatic",
        },
    )


def safe_capture_exception(
    client: Posthog | None,
    error: BaseException,
    properties: dict[str, Any] | None = None,
) -> None:
    if client is None:
        return
    try:
        # Keep the SDK exception API, but replace the message and traceback before
        # capture. The static property allowlist is the second structural barrier.
        safe_error = RuntimeError(REDACTED)
        client.capture_exception(
            (RuntimeError, safe_error, None),
            distinct_id=f"request:{uuid.uuid4().hex}",
            properties={
                **_sanitize_properties(properties or {}),
                "$exception_type": _bounded_exception_class(error),
                "$process_person_profile": False,
            },
        )
    except Exception:
        pass


@web.middleware
async def posthog_exception_middleware(request: web.Request, handler):
    started_at = monotonic()
    response = None
    outcome = "failure"
    _BUSINESS_OUTCOME.set(None)
    try:
        response = await handler(request)
        outcome = "success" if 200 <= response.status < 400 else "failure"
        return response
    except asyncio.CancelledError:
        outcome = "canceled"
        raise
    except web.HTTPException as error:
        response = error
        raise
    except Exception as error:
        safe_capture_exception(
            request.app.get(POSTHOG_CLIENT_KEY),
            error,
            {"method": request.method, "route": request.path},
        )
        raise
    finally:
        client = request.app.get(POSTHOG_CLIENT_KEY)
        operation = BROWSER_OPERATIONS.get(request.path)
        if client is not None and operation and request.method == "POST":
            try:
                business = _BUSINESS_OUTCOME.get()
                fallback = outcome if outcome in {"failure", "canceled"} else "unverified"
                business_outcome, error_code = business if business else (fallback, None)
                client.capture(
                    "browser_operation_completed",
                    distinct_id=f"request:{uuid.uuid4().hex}",
                    properties={
                        "telemetry_version": 2,
                        "product": "auth",
                        "surface": "container",
                        "environment": _environment(),
                        "release": os.getenv("RELEASE", "development"),
                        "actor_type": "system",
                        "trigger": "automatic",
                        "operation": operation,
                        "operation_id": uuid.uuid4().hex,
                        "outcome": business_outcome,
                        "business_outcome": business_outcome,
                        "http_outcome": outcome,
                        "duration_ms": round((monotonic() - started_at) * 1000),
                        "duration_basis": "request",
                        "http_status": response.status if response is not None else None,
                        **({"error_code": error_code} if error_code else {}),
                        "$process_person_profile": False,
                    },
                )
            except Exception:
                pass


async def flush_posthog(app: web.Application) -> None:
    client = app.get(POSTHOG_CLIENT_KEY)
    if client is None:
        return
    try:
        await asyncio.to_thread(client.flush, timeout_seconds=2)
    except Exception:
        pass
