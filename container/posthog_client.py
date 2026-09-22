import asyncio
import os
import re
import uuid
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
}
REDACTED = "[redacted]"
EMAIL = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE)
LABELED_SECRET = re.compile(
    r"\b(password|cookie|authorization|token|student_?id|email|otp|code|ticket)\s*[:=]\s*[^\s,;&]+",
    re.IGNORECASE,
)
BEARER = re.compile(r"\bBearer\s+[^\s,;&]+", re.IGNORECASE)


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
    if isinstance(value, list):
        return [_sanitize(item) for item in value]
    if isinstance(value, tuple):
        return tuple(_sanitize(item) for item in value)
    if isinstance(value, Mapping):
        return {child_key: _sanitize(child_value, str(child_key)) for child_key, child_value in value.items()}
    return value


def sanitize_event(event: dict | None) -> dict | None:
    if event is None:
        return None
    return _sanitize(event)


def create_posthog_client() -> Posthog | None:
    token = os.getenv("POSTHOG_PROJECT_TOKEN", "").strip()
    if not token:
        return None
    return Posthog(
        project_api_key=token,
        host=os.getenv("POSTHOG_HOST", "https://p.cqu.moe"),
        enable_exception_autocapture=True,
        before_send=sanitize_event,
        max_queue_size=1000,
        max_retries=1,
        timeout=2,
        privacy_mode=True,
        disable_geoip=True,
        super_properties={
            "service": "auth-python",
            "environment": os.getenv("ENVIRONMENT", "development"),
            "release": os.getenv("RELEASE", "development"),
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
        safe_error = RuntimeError(_redact_text(str(error)))
        client.capture_exception(
            (RuntimeError, safe_error, error.__traceback__),
            distinct_id=f"request:{uuid.uuid4().hex}",
            properties={
                **_sanitize(properties or {}),
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
    try:
        response = await handler(request)
        outcome = "success" if 200 <= response.status < 400 else "failure"
        return response
    except asyncio.CancelledError:
        outcome = "cancelled"
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
                client.capture(
                    "browser_operation_completed",
                    distinct_id=f"request:{uuid.uuid4().hex}",
                    properties={
                        "operation": operation,
                        "http_outcome": outcome,
                        "duration_ms": round((monotonic() - started_at) * 1000),
                        "http_status": response.status if response is not None else None,
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
