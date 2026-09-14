"""Organic harvest:在已登录 + 已过瑞数的临时浏览器里有机 fire 请求并截获响应。

my.cqu.edu.cn 全站瑞数化后,后端纯 HTTP POST 课表被 412 专守;唯一过墙是让真前端在
auth 已登录浏览器里导航 navUrl(页面自动 fire 课表/学期)+ 截获 capture 模式响应 +
对 fetch[] 跑 in-page GET(同源、读豁免)。本模块是 schedule 取数的通用原语,业务无关。

host 红线:navUrl/fetch[].url 解析出的 host 必须精确为直连应用，防 auth
变开放代理(SSRF)。纯函数(host 校验 / recipe 解析 /
capture 匹配)抽出便于单测。
"""
import asyncio
import json
import logging
import random
import re
import urllib.parse
import time
from patchright.async_api import async_playwright
import browser_profile
import cqu_login  # UA / locale 等浏览器对抗参数,与取票统一
import cqu_ticket_browser  # 复用 _close_browser_driver / TICKET_SEMAPHORE / 超时常量

log = logging.getLogger("cqu-data-harvest")

# harvest 只允许 Direct 目标 host(精确等于,绝不 endswith/in)。
HARVEST_HOSTS = {
    "my.cqu.edu.cn": "direct",
}


def classify_harvest_host(url: str) -> str | None:
    """合法 harvest URL 返回 ``direct``，非法返回 None。"""
    if not url or "\\" in url:
        return None
    if any(ord(ch) < 0x20 or ord(ch) > 0x7e for ch in url):
        return None
    try:
        u = urllib.parse.urlparse(url)
    except Exception:
        return None
    if u.scheme != "https" or u.username or u.password:
        return None
    try:
        port = u.port
    except ValueError:
        return None
    if port is not None and port != 443:
        return None
    host = (u.hostname or "").lower()
    if not host or any(
        ch not in "abcdefghijklmnopqrstuvwxyz0123456789.-" for ch in host
    ):
        return None
    return HARVEST_HOSTS.get(host)


def is_harvest_host_allowed(url: str) -> bool:
    """非抛谓词：URL 是否属于 Direct 精确允许 host。"""
    return classify_harvest_host(url) is not None


class HarvestRecipeError(Exception):
    """harvest 配方(navUrl/capture/fetch)非法 —— host 越界 / 缺字段 / method 非 GET。

    server.py 据此回 400(客户端契约错);message 只含红线类型,不回显入参原文。
    """


def parse_harvest_recipe(body: dict) -> dict:
    """校验 + 规范化 {navUrl, capture[], fetch[]}。非法抛 HarvestRecipeError。

    · navUrl: 必填,host 必须过 is_harvest_host_allowed。
    · capture: list[str],每项非空字符串(URL 子串模式,page.on('response') 用 `in` 匹配);
               允许空 list。
    · fetch: list[{method?:"GET", url:str}],method 省略默认 GET、仅允许 GET;url 必须过
             host 白名单;允许空 list。
    纯函数,便于单测。返回的 dict 字段均已规范化,可直接喂给 harvest 主体。
    """
    if not isinstance(body, dict):
        raise HarvestRecipeError("recipe must be an object")

    nav_url = body.get("navUrl")
    nav_kind = classify_harvest_host(nav_url) if isinstance(nav_url, str) else None
    if nav_kind is None:
        raise HarvestRecipeError("navUrl missing or host not allowed")
    nav_host = (urllib.parse.urlparse(nav_url).hostname or "").lower()

    capture = body.get("capture", [])
    if not isinstance(capture, list):
        raise HarvestRecipeError("capture must be a list")
    for pat in capture:
        if not isinstance(pat, str) or not pat:
            raise HarvestRecipeError("capture entries must be non-empty strings")

    raw_fetch = body.get("fetch", [])
    if not isinstance(raw_fetch, list):
        raise HarvestRecipeError("fetch must be a list")
    fetch: list[dict] = []
    for f in raw_fetch:
        if not isinstance(f, dict):
            raise HarvestRecipeError("fetch entries must be objects")
        raw_method = f.get("method")
        # method 缺省/None → 默认 GET;给定值必须是 str(防非字符串走到 .upper() 抛
        # AttributeError → server.py 回 500 而非契约错的 400)。bool 是 int 子类,
        # isinstance(True, str) 已为 False,会一并落入此 400 分支。
        if raw_method is None:
            method = "GET"
        elif isinstance(raw_method, str):
            method = raw_method.upper()
        else:
            raise HarvestRecipeError("fetch method must be GET")
        if method != "GET":  # 含 "" / "post" 等:非 GET 一律拒(不再被 `or` 静默吞成 GET)
            raise HarvestRecipeError("fetch method must be GET")
        url = f.get("url")
        fetch_kind = classify_harvest_host(url) if isinstance(url, str) else None
        if fetch_kind is None:
            raise HarvestRecipeError("fetch url missing or host not allowed")
        fetch_host = (urllib.parse.urlparse(url).hostname or "").lower()
        if fetch_host != nav_host:
            raise HarvestRecipeError("recipe URLs must use the same host")
        fetch.append({"method": "GET", "url": url})

    return {
        "navUrl": nav_url,
        "capture": list(capture),
        "fetch": fetch,
    }


def capture_match(resp_url: str, patterns: list[str]) -> str | None:
    """resp_url 命中的第一个 capture pattern(子串 in 匹配),无命中返回 None。

    对齐 spike:CAqWHAeT 令牌作 URL 参数注入,故按"端点路径子串"匹配而非全等。
    返回命中的 pattern 本身(作 captures dict 的去重 key)。纯函数。
    """
    if not resp_url:
        return None
    for pat in patterns:
        if pat in resp_url:
            return pat
    return None


def all_captures_present(collected: set[str], expected: list[str]) -> bool:
    """已收集的 pattern 集是否覆盖全部期望 pattern(等齐判定,供主体决定提前结束盲等)。"""
    return all(p in collected for p in expected)


# SSO/CAS 服务器自身 host(规范化小写)。storage_state 过期时 navUrl 会被重定向到这里的登录页。
_SSO_HOST = (urllib.parse.urlparse(cqu_login.SSO).hostname or "").lower()


class HarvestExpiredError(Exception):
    """会话(storage_state)过期 —— navUrl 落回 CAS 登录页, 无 capture 命中、fetch 401/空。

    server.py 据此回 409 {"error":"TGT_EXPIRED"}(对齐 /service-ticket 的 ExpiredError→409),
    让 DO 的 classifyNodeHarvestResponse 映射 TGT_EXPIRED → setAlarm 触发重登; 否则 harvest
    照常 ok:true 返回空数据, 重登路径永不触发, 会话静默失效。
    """


def is_expired_harvest(captures: dict, page_content: str, page_url: str) -> bool:
    """无任何 capture 命中 **且** 页面看起来是 CAS 登录页 → 判会话过期(纯函数, 便于单测)。

    判据(任一即视为登录页):
      · page_content 含 cqu_ticket_browser.CAS_LOGIN_MARKERS 任一标记(与取票过期判定同口径); 或
      · page_url 的 host 精确等于 SSO host(cqu_login.SSO) —— 被重定向到登录入口。
    captures 非空(真过墙拿到数据)一律返回 False, 绝不误判。正常 my.cqu 页(无标记、非 SSO host)
    也返回 False —— 归瞬态由上游退避, 不当过期触发重登。
    """
    if captures:
        return False
    if any(mk in (page_content or "") for mk in cqu_ticket_browser.CAS_LOGIN_MARKERS):
        return True
    host = (urllib.parse.urlparse(page_url or "").hostname or "").lower()
    return host == _SSO_HOST


HARVEST_ERROR_STATUS = {
    "WAF_BOOTSTRAP_TIMEOUT": 503,
    "APP_READY_TIMEOUT": 503,
    "TABLE_CAPTURE_TIMEOUT": 503,
    "TABLE_REQUEST_HUNG": 504,
    "TABLE_BODY_TIMEOUT": 504,
    "TABLE_API_REJECTED": 502,
    "WAF_CHALLENGE": 503,
    "SCHEDULE_NOT_PUBLISHED": 409,
    "HARVEST_TRANSIENT": 503,
}


class HarvestTransientError(Exception):
    """Failed harvest with an allowlisted code and separately sanitized diagnostics."""

    def __init__(self, message: str, diagnostics: dict | None = None, *, code="HARVEST_TRANSIENT"):
        super().__init__(message)
        self.code = code if code in HARVEST_ERROR_STATUS else "HARVEST_TRANSIENT"
        self.diagnostics = diagnostics or {}


def safe_url_for_diagnostics(url: str) -> str:
    """去掉 query/fragment 后的 URL, 避免 CAqWHAeT/ST/ticket 进入日志或错误响应。"""
    try:
        parsed = urllib.parse.urlsplit(url)
        return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))
    except Exception:
        return "unparsable"


def body_summary_for_diagnostics(body: str) -> dict:
    """只描述响应形状,绝不返回响应正文(可能是课表/学籍或瑞数挑战脚本)。"""
    text = body or ""
    stripped = text.lstrip().lower()
    return {
        "bytes": len(text.encode("utf-8", errors="replace")),
        "jsonLike": stripped.startswith(("{", "[")),
        "htmlLike": stripped.startswith(("<!doctype html", "<html")),
        "hasTs": "$_ts" in text,
        "hasCasLogin": "login-croypto" in text or "login-page-flowkey" in text,
    }


STAGE_NAMES = frozenset({
    "NAV_START",
    "FIRST_RESPONSE",
    "DYNAMIC_COOKIES_PRESENT",
    "APP_DOCUMENT_REACHED",
    "APP_JS_RESPONSE",
    "ROUTE_CHUNK_RESPONSE",
    "APP_READY_API",
    "JUDGE_RESPONSE",
    "TABLE_REQUEST_SEEN",
    "TABLE_RESPONSE_SEEN",
    "TABLE_BODY_READY",
    "GET_FETCH_START",
    "GET_FETCH_END",
    "DONE",
    "NAV_FAILURE",
    "TABLE_BODY_FAILURE",
    "GET_FETCH_FAILURE",
    "HARVEST_FAILURE",
})

_RESOURCE_TYPES = frozenset({
    "document", "stylesheet", "image", "media", "font", "script",
    "texttrack", "xhr", "fetch", "eventsource", "websocket", "manifest",
    "other",
})
_CONTENT_TYPE_RE = re.compile(r"[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+")
_APP_READY_PATH_MARKERS = (
    "/session/info-detail",
    "/session/list",
    "/cur-week",
)
_JUDGE_PATH_MARKER = "/judge-release-schedule-stu"
_TABLE_PATH_MARKER = "/my-table-detail"
_DYNAMIC_COOKIE_PAIRS = {
    "my.cqu.edu.cn": ("CtLgrmkSWHBZS", "CtLgrmkSWHBZT"),
    "sso.cqu.edu.cn": ("CtLgrmkSWHBZO", "CtLgrmkSWHBZP"),
}


def _safe_content_type(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    mime = value.split(";", 1)[0].strip().lower()
    if len(mime) > 80 or _CONTENT_TYPE_RE.fullmatch(mime) is None:
        return None
    return mime


def _safe_diagnostic_url(value: object) -> str | None:
    if not isinstance(value, str) or len(value) > 2048:
        return None
    safe = safe_url_for_diagnostics(value)
    try:
        parsed = urllib.parse.urlsplit(safe)
    except Exception:
        return None
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None
    if parsed.username or parsed.password or len(safe) > 500:
        return None
    return safe


def _sanitize_stage_event(event: object) -> dict | None:
    if not isinstance(event, dict) or event.get("stage") not in STAGE_NAMES:
        return None
    safe = {"stage": event["stage"]}
    elapsed_ms = event.get("elapsedMs")
    if isinstance(elapsed_ms, int) and not isinstance(elapsed_ms, bool) and elapsed_ms >= 0:
        safe["elapsedMs"] = elapsed_ms
    url = _safe_diagnostic_url(event.get("url"))
    if url is not None:
        safe["url"] = url
    status = event.get("status")
    if isinstance(status, int) and not isinstance(status, bool) and 100 <= status <= 599:
        safe["status"] = status
    resource_type = event.get("resourceType")
    if resource_type in _RESOURCE_TYPES:
        safe["resourceType"] = resource_type
    content_type = _safe_content_type(event.get("contentType"))
    if content_type is not None:
        safe["contentType"] = content_type
    body_bytes = event.get("bodyBytes")
    if isinstance(body_bytes, int) and not isinstance(body_bytes, bool) and body_bytes >= 0:
        safe["bodyBytes"] = body_bytes
    for marker in ("jsonLike", "htmlLike", "hasTs", "hasCasLogin"):
        if isinstance(event.get(marker), bool):
            safe[marker] = event[marker]
    return safe


def sanitize_harvest_diagnostics(diagnostics: object) -> dict:
    """Handler/log boundary: only the typed stage timeline may leave this module."""
    if not isinstance(diagnostics, dict) or not isinstance(diagnostics.get("timeline"), list):
        return {"timeline": []}
    timeline = []
    seen_stages: set[str] = set()
    for raw_event in diagnostics["timeline"]:
        event = _sanitize_stage_event(raw_event)
        if event is None or event["stage"] in seen_stages:
            continue
        timeline.append(event)
        seen_stages.add(event["stage"])
        if len(timeline) >= 80:
            break
    return {"timeline": timeline}


class StageTrace:
    """Bounded, allowlisted direct-harvest timeline with an injectable clock."""

    def __init__(self, clock=time.monotonic, max_events: int = 80):
        self._clock = clock
        self._started_at = clock()
        self._max_events = max_events
        self.events: list[dict] = []
        self._recorded_stages: set[str] = set()

    def has_stage(self, stage: str) -> bool:
        return any(event["stage"] == stage for event in self.events)

    def record(
        self,
        stage: str,
        *,
        url: str | None = None,
        status: int | None = None,
        resource_type: str | None = None,
        content_type: str | None = None,
        body: str | None = None,
        **_discarded: object,
    ) -> None:
        if stage not in STAGE_NAMES:
            raise ValueError("stage not allowed")
        if stage in self._recorded_stages:
            return
        if len(self.events) >= self._max_events:
            return
        raw_event: dict = {
            "stage": stage,
            "elapsedMs": max(0, int((self._clock() - self._started_at) * 1000)),
        }
        if url is not None:
            raw_event["url"] = url
        if status is not None:
            raw_event["status"] = status
        if resource_type is not None:
            raw_event["resourceType"] = resource_type
        if content_type is not None:
            raw_event["contentType"] = content_type
        if body is not None:
            summary = body_summary_for_diagnostics(body)
            raw_event.update({
                "bodyBytes": summary["bytes"],
                "jsonLike": summary["jsonLike"],
                "htmlLike": summary["htmlLike"],
                "hasTs": summary["hasTs"],
                "hasCasLogin": summary["hasCasLogin"],
            })
        event = _sanitize_stage_event(raw_event)
        if event is not None:
            self.events.append(event)
            self._recorded_stages.add(stage)

    def diagnostics(self) -> dict:
        return {"timeline": self.events}


def dynamic_cookie_pair_present(cookies: object, hostname: str) -> bool:
    """Check cookie names/presence only; no cookie value ever enters diagnostics."""
    pair = _DYNAMIC_COOKIE_PAIRS.get((hostname or "").lower())
    if pair is None or not isinstance(cookies, list):
        return False
    present = {
        cookie.get("name")
        for cookie in cookies
        if isinstance(cookie, dict) and isinstance(cookie.get("value"), str)
        and bool(cookie["value"])
    }
    return all(name in present for name in pair)


def _response_metadata(response) -> dict:
    request = getattr(response, "request", None)
    headers = getattr(response, "headers", {})
    return {
        "url": getattr(response, "url", ""),
        "status": getattr(response, "status", None),
        "resource_type": getattr(request, "resource_type", None),
        "content_type": headers.get("content-type", "") if isinstance(headers, dict) else "",
    }


class ResponseStageCollector:
    """Synchronous response classifier plus owned asynchronous capture-body readers."""

    def __init__(self, trace: StageTrace, patterns: list[str], captured: dict):
        self._trace = trace
        self._patterns = patterns
        self._captured = captured
        self._tasks: set[asyncio.Task] = set()
        self._closed = False
        self.required_statuses: set[int] = set()
        self.table_statuses: set[int] = set()

    def on_request(self, request) -> None:
        if self._closed:
            return
        url = getattr(request, "url", "")
        if (classify_harvest_host(url) == "direct"
                and _TABLE_PATH_MARKER in urllib.parse.urlsplit(url).path.lower()):
            self._trace.record("TABLE_REQUEST_SEEN", url=url,
                               resource_type=getattr(request, "resource_type", None))

    def on_response(self, response) -> None:
        if self._closed:
            return
        metadata = _response_metadata(response)
        url = metadata["url"]
        path = urllib.parse.urlsplit(url).path.lower()
        resource_type = metadata["resource_type"]
        if not self._trace.has_stage("FIRST_RESPONSE"):
            self._trace.record("FIRST_RESPONSE", **metadata)
        if classify_harvest_host(url) != "direct":
            return
        successful = isinstance(metadata["status"], int) and 200 <= metadata["status"] < 300
        if successful and resource_type == "document" and path.startswith("/workspace/"):
            self._trace.record("APP_DOCUMENT_REACHED", **metadata)
        if resource_type == "script" and "/workspace/static/js/app." in path:
            self._trace.record("APP_JS_RESPONSE", **metadata)
        if resource_type == "script" and "/workspace/static/js/chunk-" in path:
            self._trace.record("ROUTE_CHUNK_RESPONSE", **metadata)
        if successful and any(marker in path for marker in _APP_READY_PATH_MARKERS):
            self._trace.record("APP_READY_API", **metadata)
        if successful and _JUDGE_PATH_MARKER in path:
            self._trace.record("JUDGE_RESPONSE", **metadata)

        pattern = capture_match(url, self._patterns)
        is_table_response = _TABLE_PATH_MARKER in path
        required_table = is_table_response and requires_table_capture(self._patterns)
        if (pattern is not None or required_table) and not (
            resource_type == "document" and path.startswith("/workspace/")
        ):
            if isinstance(metadata["status"], int):
                self.required_statuses.add(metadata["status"])
                if is_table_response:
                    self.table_statuses.add(metadata["status"])
        if is_table_response:
            # This must stay synchronous and before create_task/response.text().
            self._trace.record("TABLE_RESPONSE_SEEN", **metadata)
        if pattern is not None or is_table_response:
            task = asyncio.create_task(self._read_capture_body(response, pattern, metadata))
            self._tasks.add(task)

    async def _read_capture_body(
        self, response, pattern: str | None, metadata: dict,
    ) -> None:
        try:
            body = await response.text()
        except asyncio.CancelledError:
            raise
        except Exception:
            if _TABLE_PATH_MARKER in urllib.parse.urlsplit(metadata["url"]).path.lower():
                self._trace.record("TABLE_BODY_FAILURE", **metadata)
            return
        if _TABLE_PATH_MARKER in urllib.parse.urlsplit(metadata["url"]).path.lower():
            self._trace.record("TABLE_BODY_READY", body=body, **metadata)
        if pattern is not None:
            self._captured[pattern] = {
                "url": metadata["url"],
                "status": metadata["status"],
                "contentType": metadata["content_type"],
                "body": body,
            }

    async def close(self) -> None:
        self._closed = True
        if not self._tasks:
            return
        # Let already-readable bodies settle, then cancel and join anything hung.
        await asyncio.sleep(0)
        for task in self._tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()

    async def settle_pending(self, deadline: float, *, clock=time.monotonic) -> None:
        """Give response bodies already in flight a bounded chance to finish."""
        pending = [task for task in self._tasks if not task.done()]
        if not pending:
            return
        timeout = min(CAPTURE_BODY_SETTLE_S, max(0.0, deadline - clock()))
        if timeout <= 0:
            return
        await asyncio.wait(pending, timeout=timeout)


def _has_2xx(statuses: list[int]) -> bool:
    """fetch_statuses 里是否有任一 2xx(in-page GET 真拿到数据)。失败 fetch 记 status 0, 非 2xx。"""
    return any(200 <= s < 300 for s in statuses)


def classify_harvest_outcome(
    captured_keys: set[str],
    patterns: list[str],
    page_content: str,
    page_url: str,
    fetch_statuses: list[int] | None = None,
) -> str:
    """navigate + capture-wait + fetch[] 后的三态判定(纯函数, 便于单测): "ok"/"expired"/"transient"。

    对 capture 配方与 **fetch-only 配方(patterns 为空)** 都鲁棒(P2 修复):fetch-only 时旧逻辑
    "patterns 空即 ok" 会把"goto 超时/会话过期(重定向 CAS)/fetch 全 401"也当 ok 空成功返回,
    DO 永不触发重登、调用方误以为"今天没课"。现按以下顺序判:

    1. **永远先判过期**: is_expired_harvest(captured, page_content, page_url) 为真 → "expired"
       (落回 CAS 登录页/SSO host 一律过期, 不论是否期望 capture; captured 非空时该函数恒 False)。
    2. **capture 配方**(patterns 非空): 全齐 → "ok"; 否则 → "transient"(瞬态退避)。
    3. **fetch-only 配方**(patterns 为空): 至少一个 fetch 返 2xx → "ok"(真拿到数据);
       否则(空列表/全部非 2xx/全失败)→ "transient"(没拿到任何可用数据, 退避而非假成功)。

    fetch_statuses 为各 in-page fetch 的 HTTP status(失败记 0); 仅 fetch-only 分支用到,
    capture 配方传 None/省略即可(保持既有调用与单测不变)。
    """
    captured = {k: True for k in captured_keys}  # is_expired_harvest 只看 truthy/empty
    if is_expired_harvest(captured, page_content, page_url):
        return "expired"
    if patterns:
        return "ok" if all_captures_present(captured_keys, patterns) else "transient"
    # fetch-only: 只有至少一个 2xx 才算真成功, 否则瞬态退避。
    return "ok" if _has_2xx(fetch_statuses or []) else "transient"


# Generic capture recipes retain their profile-specific wait.
CAPTURE_WAIT_MS = browser_profile.CAPTURE_WAIT_MS
CAPTURE_POLL_MS = 150
DYNAMIC_COOKIE_WAIT_MS = browser_profile.DYNAMIC_COOKIE_WAIT_MS
APP_READY_WAIT_MS = browser_profile.APP_READY_WAIT_MS
JUDGE_WAIT_MS = browser_profile.JUDGE_WAIT_MS
TABLE_WAIT_MS = browser_profile.TABLE_WAIT_MS
# 单个 in-page fetch 的超时(ms):同源 GET 读豁免,正常亚秒级。
INPAGE_FETCH_TIMEOUT_MS = browser_profile.INPAGE_FETCH_TIMEOUT_MS
# harvest 整段执行上限(秒):navigate 过瑞数 + 等 capture + 跑 fetch[]。复用取票 overall_timeout 量级。
HARVEST_OVERALL_TIMEOUT = browser_profile.HARVEST_OVERALL_TIMEOUT_S
STATE_EXPORT_TIMEOUT_S = 5.0
STATE_EXPORT_DEADLINE_MARGIN_S = 1.0
CAPTURE_BODY_SETTLE_S = browser_profile.CAPTURE_BODY_SETTLE_S


def requires_table_capture(patterns: list[str]) -> bool:
    return any(_TABLE_PATH_MARKER in pattern.lower() for pattern in patterns)


def harvest_failure_code(
    trace: StageTrace, patterns: list[str], captured: dict,
    required_statuses, fetch_statuses: list[int], *, table_statuses=(),
) -> str | None:
    """Classify observed failures before missing-stage timeouts; CAS expiry is handled first."""
    statuses = [*required_statuses, *fetch_statuses]
    if 412 in statuses:
        return "WAF_CHALLENGE"
    if requires_table_capture(patterns):
        if any(status != 0 and not 200 <= status < 300 for status in table_statuses):
            return "TABLE_API_REJECTED"
        if trace.has_stage("TABLE_RESPONSE_SEEN") and not trace.has_stage("TABLE_BODY_READY"):
            return "TABLE_BODY_TIMEOUT"
        if trace.has_stage("TABLE_REQUEST_SEEN") and not trace.has_stage("TABLE_RESPONSE_SEEN"):
            return "TABLE_REQUEST_HUNG"
    if 0 in statuses:
        return "HARVEST_TRANSIENT"
    if all_captures_present(set(captured), patterns):
        if any(not 200 <= status < 300 for status in statuses):
            return "HARVEST_TRANSIENT"
        return None
    if requires_table_capture(patterns):
        if not trace.has_stage("DYNAMIC_COOKIES_PRESENT") and not trace.has_stage(
            "APP_DOCUMENT_REACHED"
        ):
            return "WAF_BOOTSTRAP_TIMEOUT"
        if not all(trace.has_stage(stage) for stage in (
            "APP_DOCUMENT_REACHED", "APP_READY_API", "JUDGE_RESPONSE",
        )):
            return "APP_READY_TIMEOUT"
        if not trace.has_stage("TABLE_RESPONSE_SEEN"):
            return "TABLE_CAPTURE_TIMEOUT"
    if any(not 200 <= status < 300 for status in statuses):
        return "HARVEST_TRANSIENT"
    return "HARVEST_TRANSIENT"


async def wait_for_harvest_captures(
    page, context, nav_url: str, patterns: list[str], captured: dict,
    trace: StageTrace, *, started_at: float, deadline: float,
    clock=time.monotonic, uniform=random.uniform,
) -> None:
    """Observe one collector under navigation milestones and one table envelope.

    Returning with missing captures leaves classification to harvest's existing
    failure gate. A table request or response already in flight prevents reload.
    """
    def complete():
        return all_captures_present(set(captured), patterns)

    async def wait_until(predicate, until):
        until = min(until, deadline)
        while not complete() and not predicate() and clock() < until:
            await page.wait_for_timeout(min(CAPTURE_POLL_MS, (until - clock()) * 1000))
        return complete() or predicate()

    if complete():
        return
    if not requires_table_capture(patterns):
        await wait_until(complete, clock() + CAPTURE_WAIT_MS / 1000)
        return

    hostname = (urllib.parse.urlsplit(nav_url).hostname or "").lower()
    cookie_deadline = min(started_at + DYNAMIC_COOKIE_WAIT_MS / 1000, deadline)
    while not trace.has_stage("DYNAMIC_COOKIES_PRESENT") and not complete():
        try:
            # URL scoping prevents an unrelated host's same-named cookies
            # from satisfying Direct readiness.
            cookies = await context.cookies([nav_url])
        except Exception:
            cookies = []
        if dynamic_cookie_pair_present(cookies, hostname):
            trace.record("DYNAMIC_COOKIES_PRESENT", url=nav_url)
            break
        if clock() >= cookie_deadline:
            break
        await page.wait_for_timeout(min(CAPTURE_POLL_MS, (cookie_deadline - clock()) * 1000))

    for stage, milestone_ms in (("APP_DOCUMENT_REACHED", APP_READY_WAIT_MS),
                                ("APP_READY_API", APP_READY_WAIT_MS),
                                ("JUDGE_RESPONSE", JUDGE_WAIT_MS)):
        if not await wait_until(lambda: trace.has_stage(stage), started_at + milestone_ms / 1000):
            return
    if complete():
        return

    table_deadline = min(clock() + TABLE_WAIT_MS / 1000, deadline)
    table_started = lambda: (
        trace.has_stage("TABLE_REQUEST_SEEN") or trace.has_stage("TABLE_RESPONSE_SEEN")
    )

    async def wait_for_table():
        await wait_until(lambda: trace.has_stage("TABLE_BODY_FAILURE"), table_deadline)

    if table_started():
        await wait_for_table()
        return
    await wait_until(table_started, min(clock() + uniform(15, 25), table_deadline))
    if complete():
        return
    if table_started():
        await wait_for_table()
        return
    await wait_until(table_started, min(clock() + uniform(4, 8), table_deadline))
    if complete():
        return
    if table_started():
        await wait_for_table()
        return
    remaining_ms = (table_deadline - clock()) * 1000
    if remaining_ms <= 0:
        return
    try:
        await page.reload(
            wait_until="commit",
            timeout=min(browser_profile.HARVEST_NAV_TIMEOUT_MS, remaining_ms),
        )
    except Exception:
        trace.record("NAV_FAILURE", url=nav_url, resource_type="document")
    await wait_until(
        lambda: trace.has_stage("TABLE_BODY_FAILURE"),
        min(clock() + 45, table_deadline),
    )


async def run_serial_inpage_gets(
    page, fetch_list: list[dict], trace: StageTrace, fetches: list[dict], *,
    uniform=random.uniform, sleep=asyncio.sleep,
) -> None:
    """Run recipe GETs one at a time, pacing only the gaps between them.

    The injectable clock-facing dependencies keep the bounded jitter deterministic
    in tests; they are deliberately not used for VM/bootstrap or recovery timing.
    """
    for index, f in enumerate(fetch_list):
        url = f["url"]
        trace.record("GET_FETCH_START", url=url, resource_type="fetch")
        try:
            result = await page.evaluate(
                """async ({ u, t }) => {
                    let tok = '';
                    try { tok = (localStorage.getItem('cqu_edu_ACCESS_TOKEN') || '').replace(/^"|"$/g, ''); } catch (e) {}
                    const headers = { 'Accept': 'application/json' };
                    if (tok) headers['Authorization'] = 'Bearer ' + tok;
                    const r = await fetch(u, { credentials: 'include', headers, signal: AbortSignal.timeout(t) });
                    return { status: r.status, body: await r.text() };
                }""",
                {"u": url, "t": INPAGE_FETCH_TIMEOUT_MS},
            )
            fetches.append({
                "url": url,
                "status": result["status"],
                "body": result["body"],
            })
            trace.record(
                "GET_FETCH_END",
                url=url,
                status=result["status"],
                resource_type="fetch",
                body=result["body"],
            )
        except Exception:
            fetches.append({"url": url, "status": 0, "body": ""})
            trace.record(
                "GET_FETCH_FAILURE", url=url, status=0, resource_type="fetch",
            )

        if index < len(fetch_list) - 1:
            await sleep(uniform(0.250, 0.800))


async def harvest(state: dict, recipe: dict) -> dict:
    """在水化 state 的临时浏览器里 navigate recipe.navUrl(过瑞数,页面有机 fire 课表/学期),
    截获命中 capture 模式的响应 + 跑 fetch[] in-page GET,返回 {captures, fetches}。

    recipe 已由 parse_harvest_recipe 校验/规范化(host 全过白名单)。浏览器对抗参数(launch
    args / UA / locale / timezone / 显式 start-stop 驱动 / 限时 cleanup)复用 cqu_ticket_browser
    的 _hydrate_navigate 骨架,统一瑞数对抗。返回结构对 server/schedule 稳定。

    captures[i] = {url, status, contentType, body};fetches[i] = {url, status, body}。
    body 是文本(JSON 由上层 schedule 解析)。绝不记录 cookie/state/token 明文。
    """
    nav_url = recipe["navUrl"]
    patterns: list[str] = recipe["capture"]
    fetch_list: list[dict] = recipe["fetch"]
    handles: dict = {"pw": None, "browser": None}
    trace = StageTrace()
    diagnostics = trace.diagnostics()
    captured: dict[str, dict] = {}
    fetches: list[dict] = []
    response_collector = ResponseStageCollector(trace, patterns, captured)

    def failure_code():
        table_statuses = response_collector.table_statuses | {
            f["status"] for f in fetches
            if _TABLE_PATH_MARKER in urllib.parse.urlsplit(f["url"]).path.lower()
        }
        return harvest_failure_code(
            trace, patterns, captured, response_collector.required_statuses,
            [f["status"] for f in fetches], table_statuses=table_statuses,
        )

    async def _run(work_deadline: float) -> dict:
        pw = await async_playwright().start()
        handles["pw"] = pw
        browser = await pw.chromium.launch(headless=True, args=[
            "--headless=new", "--disable-blink-features=AutomationControlled",
            "--no-sandbox", "--disable-dev-shm-usage"],
            timeout=browser_profile.BROWSER_LAUNCH_TIMEOUT_MS)
        handles["browser"] = browser
        ctx = await browser.new_context(
            storage_state=state,
            viewport={"width": 1440, "height": 900},
            locale="zh-CN", timezone_id="Asia/Shanghai")
        page = await ctx.new_page()
        await cqu_login.apply_browser_identity(ctx, page, browser.version)
        page.on("request", response_collector.on_request)
        page.on("response", response_collector.on_response)

        try:
            navigation_started_at = time.monotonic()
            trace.record("NAV_START", url=nav_url, resource_type="document")
            try:
                await page.goto(
                    nav_url,
                    wait_until="commit" if requires_table_capture(patterns) else "domcontentloaded",
                    timeout=browser_profile.HARVEST_NAV_TIMEOUT_MS,
                )
            except Exception:
                trace.record("NAV_FAILURE", url=nav_url, resource_type="document")

            await wait_for_harvest_captures(
                page, ctx, nav_url, patterns, captured, trace,
                started_at=navigation_started_at, deadline=work_deadline,
            )
            await response_collector.settle_pending(work_deadline)

            # A capture recipe cannot be rescued by supplemental GETs. Fail at
            # the browser stage before issuing Bearer requests while the app may
            # still be completing its token-index bootstrap.
            prefetch_code = failure_code() if patterns else None
            if prefetch_code is not None:
                page_content = "" if captured else await page.content()
                outcome = classify_harvest_outcome(
                    set(captured), patterns, page_content, page.url, [],
                )
                if outcome == "expired":
                    trace.record("HARVEST_FAILURE", url=page.url)
                    raise HarvestExpiredError(
                        "navUrl redirected to CAS login (session expired)"
                    )
                trace.record("HARVEST_FAILURE", url=page.url)
                raise HarvestTransientError(
                    "required capture unavailable before supplemental fetch",
                    diagnostics,
                    code=prefetch_code,
                )

            await run_serial_inpage_gets(page, fetch_list, trace, fetches)

            fetch_statuses = [f["status"] for f in fetches]
            page_content = "" if captured else await page.content()
            outcome = classify_harvest_outcome(
                set(captured), patterns, page_content, page.url, fetch_statuses,
            )
            if outcome == "expired":
                trace.record("HARVEST_FAILURE", url=page.url)
                raise HarvestExpiredError("navUrl redirected to CAS login (session expired)")
            code = failure_code()
            if code is not None or outcome == "transient":
                trace.record("HARVEST_FAILURE", url=page.url)
                raise HarvestTransientError(
                    "no usable harvest data (navigation/WAF/network/session transient)",
                    diagnostics,
                    code=code or "HARVEST_TRANSIENT",
                )

            trace.record("DONE", url=page.url)
            captures = [captured[p] for p in patterns if p in captured]
            result = {
                "captures": captures,
                "fetches": fetches,
                "diagnostics": diagnostics,
            }
            # Export only after complete successful captures and supplemental GETs.
            if (all(200 <= capture["status"] < 300 for capture in captures)
                    and all(200 <= status < 300 for status in fetch_statuses)):
                export_deadline = min(
                    time.monotonic() + STATE_EXPORT_TIMEOUT_S,
                    work_deadline - STATE_EXPORT_DEADLINE_MARGIN_S,
                )
                if export_deadline > time.monotonic():
                    try:
                        async with asyncio.timeout_at(export_deadline):
                            result["state"] = await ctx.storage_state()
                    except Exception:
                        # Timeout/internal export errors cannot discard complete data.
                        # CancelledError still propagates to the owning operation.
                        log.warning("harvest state refresh skipped (export failed)")
            return result
        finally:
            # No response-body task may outlive the browser/context cleanup below.
            await response_collector.close()

    await asyncio.wait_for(
        cqu_ticket_browser.TICKET_SEMAPHORE.acquire(),
        timeout=cqu_ticket_browser.QUEUE_WAIT,
    )
    try:
        try:
            work_timeout = asyncio.timeout(HARVEST_OVERALL_TIMEOUT)
            try:
                async with work_timeout:
                    return await _run(work_timeout.when())
            except TimeoutError:
                if not work_timeout.expired():
                    raise
                # Only our work cap is classified here. External cancellation still
                # reaches run_bounded, which owns BROWSER_DEADLINE precedence.
                code = failure_code() if trace.has_stage("NAV_START") else None
                raise HarvestTransientError(
                    "harvest work budget exhausted", diagnostics,
                    code=code or "HARVEST_TRANSIENT",
                ) from None
        except Exception:
            if not trace.has_stage("HARVEST_FAILURE"):
                trace.record("HARVEST_FAILURE")
            safe_diagnostics = sanitize_harvest_diagnostics(diagnostics)
            log.warning(
                "harvest exception diagnostics %s",
                json.dumps(safe_diagnostics, sort_keys=True, separators=(",", ":")),
            )
            raise
    finally:
        cqu_ticket_browser.TICKET_SEMAPHORE.release()
        await cqu_ticket_browser._close_browser_driver(handles["browser"], handles["pw"])
