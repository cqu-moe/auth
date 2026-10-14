#!/usr/bin/env python3
"""
CQU 浏览器登录器 —— aiohttp 服务(CF Containers, 端口 8080)。

两条路由共存于同一进程, 让 /code 能唤醒在途的 /run:
  POST /run  {studentId, password, service, method, session}
      → 起一个按 session 键控的 asyncio.Event, 调 cqu_login.run_login(...),
        其 code_provider 阻塞等该 Event; 成功 200 {ok:true, state, ticket},
        失败 500 {ok:false, error}。finally 清理 Event/Value。
  POST /code {session, code}
      → 存码并 set 对应 session 的 Event, 唤醒在途 /run。返回 {ok:true}。

设计要点(对齐计划 Phase 4 Task 4.1):
  · 模块级 dict 维护 events + values, 按 session 隔离并发登录。
  · run_login 在「原生点发码」之后才 await code_provider, 此时 2FA 邮件已发出;
    DO 收到 CF 转发的 2FA 邮件提码后 POST /code 推入。
"""
import asyncio
import json
import logging
import time
import urllib.parse
import uuid

from aiohttp import web

import browser_profile  # 国内/Cloudflare 两套时限与运行标记
import cqu_login_cdp as cqu_login  # 裸 CDP 登录器；避免 Patchright 注入触发发码空 400。
import cqu_keepalive  # 国内节点浏览器水化探活, 暴露 probe_session_browser(...)
import cqu_ticket_browser  # 浏览器水化取 ST(过瑞数 JS 挑战), 暴露 fetch_service_ticket_browser(...)
import cqu_data_harvest  # 浏览器 organic harvest(navigate+capture+in-page fetch), 暴露 harvest(...)
import cqu_external_search
from qg_proxy import acquire_qg_proxy, QgExtractError, should_use_proxy  # 青果代理 + 灰度门(/run 登录仍用)
from posthog_client import (
    POSTHOG_CLIENT_KEY,
    create_posthog_client,
    flush_posthog,
    mark_business_outcome,
    posthog_exception_middleware,
    safe_capture_exception,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("cqu-login-server")
LOGIN_FAILURES = {
    "PASSWORD_REJECTED": ("first_factor", "School credentials were rejected."),
    "FIRST_FACTOR_UNRECOGNIZED": ("first_factor", "The first-factor result was not recognized."),
    "CAPTCHA_REQUIRED": ("first_factor", "Interactive school verification is required."),
    "OTP_SEND_FAILED": ("sending_code", "The school did not send a verification code."),
    "OTP_SEND_TIMEOUT": ("sending_code", "The verification-code send result is unknown."),
    "OTP_TIMEOUT": ("waiting_code", "The verification code did not arrive before the deadline."),
    "CODE_PERMIT_TIMEOUT": ("waiting_verification_lease", "The verification-code permit was not available before the deadline."),
    "VERIFICATION_COOLDOWN": ("waiting_verification_lease", "Verification is waiting for the permitted retry time."),
    "BROWSER_DEADLINE": ("operation", "The browser operation reached its deadline."),
    "BROWSER_BUSY": ("waiting_capacity", "The browser instance is busy."),
    "BROWSER_INSTANCE_REPLACED": ("launching_browser", "The browser instance was replaced."),
    "CONTAINER_UNAVAILABLE": ("launching_browser", "The browser service is unavailable."),
    "WAF_CHALLENGE": ("first_factor", "The school access challenge did not complete."),
    "TICKET_MISSING": ("validating_session", "No service ticket was observed after verification."),
    "UNKNOWN_LOGIN_ERROR": ("unknown", "The school login did not complete."),
}


def normalize_login_failure(error: object) -> dict:
    raw = str(error).strip()
    code = raw if raw in LOGIN_FAILURES else "UNKNOWN_LOGIN_ERROR"
    if raw == "BROWSER_CLEANUP_FAILED":
        code = "CONTAINER_UNAVAILABLE"
    elif raw.startswith("first-factor failed: credential_rejected:"):
        code = "PASSWORD_REJECTED"
    elif raw.startswith("first-factor failed:"):
        code = "FIRST_FACTOR_UNRECOGNIZED"
    elif raw.startswith("发码失败 status="):
        code = "OTP_SEND_FAILED"
    elif raw.startswith("发码响应超时"):
        code = "OTP_SEND_TIMEOUT"
    elif raw.startswith(("code wait timed out", "等验证码超时", "未取到验证码", "reusable code never arrived")):
        code = "OTP_TIMEOUT"
    elif raw.startswith(("code permit timed out", "code permit phase timed out")):
        code = "CODE_PERMIT_TIMEOUT"
    elif raw.startswith("login timed out"):
        code = "BROWSER_DEADLINE"
    elif raw.startswith("未捕获 ST ticket"):
        code = "TICKET_MISSING"
    phase, detail = LOGIN_FAILURES[code]
    # Keep the legacy error field as a stable alias; never return page text or URLs.
    return {"ok": False, "error": code, "errorCode": code, "phase": phase, "detail": detail}


def login_failure_response(error: object, status: int = 500) -> web.Response:
    payload = normalize_login_failure(error)
    mark_business_outcome("failure", payload["errorCode"])
    log.warning("run terminal phase=%s errorCode=%s", payload["phase"], payload["errorCode"])
    return web.json_response(payload, status=status)


NODE_API_VERSION = "direct-harvest-v1"
NODE_CAPABILITIES = [
    "code-permit",
    "reusable-code",
    "data-harvest",
    "external-search-v1",
    "browser-route-v1",
    "operation-deadline-v1",
    "raw-cdp-login-v1",
    "unified-cdp-v1",
    "login-cancel-v1",
]

# 进程级启动标识:实例停止/崩溃/更新后 Event 字典即清空,DO 必须能识别"同一个容器 ID
# 已经换了 Python 进程",不能把验证码投进没有原登录任务的新进程。仅出现在 health JSON,
# 不加诊断 HTML/state 导出接口。
BOOT_ID = uuid.uuid4().hex

# CF profile 下全进程同一时刻只允许一个重型浏览器操作(basic 1 GiB;/run、
# /service-ticket、/keepalive、/data-harvest 共用)。health/code/permit 不取此锁。
BROWSER_JOB_LOCK = asyncio.Lock()

BOOT_HEADER = "X-Cqu-Expected-Boot-Id"
MIN_OPERATION_TIMEOUT_MS = 1
MAX_OPERATION_TIMEOUT_MS = 780_000


# ── serviceUrl host 白名单(纵深第二层) ──────────────────────────────────────
# host 红线本只在上游 DO.getServiceTicket 一处; 一旦 VPC binding 误配、或将来新增直连本节点
# 的调用方, 红线即失效, 任意 serviceUrl 都会被 build_login_url navigate → CVE-2022-39369 式
# ST-relay(把一次性 ST 中继到别域)。这里加一层节点侧 host 校验作纵深防御, 策略与 DO 侧
# src/services/service-url.ts(validateCquServiceUrl)逐项对齐: 仅放行 https 的 *.cqu.edu.cn。
# 纯函数, 便于单测; 不抛异常。
def is_allowed_service_url(url: str) -> str | None:
    """serviceUrl 是否允许换票: 仅 https 的 *.cqu.edu.cn(host == cqu.edu.cn 或以 .cqu.edu.cn 结尾)。

    通过 → 返回 **canonical URL 字符串**(host 转小写、去默认 :443, path/query/fragment 原样保留);
    不通过 → 返回 None。返回 canonical 而非 bool, 使取票整链口径单一: handler 把 canonical 传给
    浏览器水化导航(service_host_of / should_abort_request 的规范化比对口径与之一致, 不漏 abort)。

    对齐 service-url.ts 的纵深红线(任一不满足即拒, 绝不放行):
      · 反斜杠 → 跨解析器陷阱(\\→/), 拒。
      · 非 ASCII → 杀 IDN 同形 / 全角点(my．cqu) / CRLF, 拒。
      · scheme 必须 https。
      · 不得带 userinfo(username/password / @ 绕过)。
      · 端口只允许省略或 443。
      · host 仅 [a-z0-9.-], 不得有尾点 / 起始点 / 空 label(..)。
      · host 必须**全等** cqu.edu.cn 或以 **.cqu.edu.cn 结尾**(绝不用 in/contains —— cqu.edu.cn.evil.com
        含子串但 NOT 属于 *.cqu.edu.cn, 必须判拒)。
    """
    if not url or "\\" in url:
        return None
    if any(ord(ch) < 0x20 or ord(ch) > 0x7e for ch in url):  # 非 ASCII / 控制符
        return None
    try:
        u = urllib.parse.urlparse(url)
    except Exception:
        return None
    if u.scheme != "https":
        return None
    if u.username or u.password:
        return None
    try:
        port = u.port  # 解析失败(非法端口)抛 ValueError
    except ValueError:
        return None
    if port is not None and port != 443:
        return None
    host = (u.hostname or "").lower()
    if not host:
        return None
    if any(ch not in "abcdefghijklmnopqrstuvwxyz0123456789.-" for ch in host):
        return None
    if host.startswith(".") or host.endswith(".") or ".." in host:
        return None
    if not (host == "cqu.edu.cn" or host.endswith(".cqu.edu.cn")):
        return None
    # 通过 → 重建 canonical: 小写 host、去默认 :443(端口已校验仅 None/443), netloc 不带 userinfo。
    return urllib.parse.urlunparse((u.scheme, host, u.path, u.params, u.query, u.fragment))

# ── 超时链路标定(CQU 邮件慢, 把等码上限抬到 ~10min) ─────────────────────────────
# CQU 2FA 验证码自「点发码」起有效 600s。围绕这条硬上限标定两级超时:
#   · CODE_WAIT_TIMEOUT(570s): 等 /code 推码的上限。刻意停在距 600s 有效期约 30s 之前——
#     即便码临近 deadline 才到, 也还留有余量提交后再过期; 若死等满 600s, 码会恰在到达那一刻失效。
#   · RUN_TOTAL_TIMEOUT(660s): 单次 /run 整体上限, 含第一因素 + 570s 等码 + 提交/开销。
#     须 > CODE_WAIT(570s) + 第一因素/发码开销, 故取 660s。
# 不变式(必须成立):
#   DO 侧 LOGIN_LOCK_TTL_MS(2340s) 覆盖排队后继最坏链路(owner 恢复围栏 1500s
#   接棒后 780s permit phase + 660s 登录预算, 另留恢复余量),
#   RUN_TOTAL_TIMEOUT(660s) > CODE_WAIT_TIMEOUT(570s),
#   且 CODE_WAIT_TIMEOUT(570s) < 码有效期(600s)并留提交余量。
# 改这两值须同步上调 src/services/cqu-2fa/single-flight.ts 的 LOGIN_LOCK_TTL_MS(须 > RUN_TOTAL_TIMEOUT)。
CODE_WAIT_TIMEOUT = 570
# 被提升为 owner 后的登录上限(秒): 含发码 + 等码 + 提交。
RUN_TOTAL_TIMEOUT = 660
# FIFO 排队者的 permit 等待预算独立于其成为 owner 后的登录预算。第一因素可以与
# 当前 owner 并行，PERMIT_PHASE_TIMEOUT 再留 60s 给第一因素/页面渲染开销。
PERMIT_WAIT_TIMEOUT = 720
PERMIT_PHASE_TIMEOUT = 780
# 排队者与 owner 同用这两档预算(#27): DO 侧把每次 /run 的 operationTimeoutMs
# 钳在 13min 调用预算内并带 AbortSignal, 更大的容器侧排队预算永远不可达,
# 只会掩盖真实生效的 DO 截止时间。排队者等 permit 仍由 /code-permit FIFO 控制。

# keepalive 的硬编码探测 URL(my.cqu.edu.cn)必须自身在白名单内 —— 防未来把它改坏后
# /keepalive 仍 navigate 一个不该放行的 host。keepalive 不收外部 serviceUrl, 故无需对入参
# 校验, 只在此处对硬编码常量做一次启动期 sanity(单测亦锁此 invariant)。
# 通过 → canonical URL 字符串(真值); 不通过 → None(下方 assert 触发, 启动期即暴露)。
PROBE_SERVICE_HOST_OK = is_allowed_service_url(cqu_keepalive.PROBE_SERVICE)
assert PROBE_SERVICE_HOST_OK, (
    f"PROBE_SERVICE not in host allowlist: {cqu_keepalive.PROBE_SERVICE!r}"
)

# session -> Event(被 /code set 唤醒)。
CODE_EVENTS: dict[str, asyncio.Event] = {}
# session -> (验证码字符串, 存入时刻 time.time())。存入时刻用于清理过期(孤儿)码, 避免明文码长期驻留。
CODE_VALUES: dict[str, tuple[str, float]] = {}
# `already_valid` 专用预载码。与新邮件码分桶，保证服务端真发新码(sent)时不会误吃旧码。
REUSABLE_CODE_EVENTS: dict[str, asyncio.Event] = {}
REUSABLE_CODE_VALUES: dict[str, tuple[str, float]] = {}
# session -> Event(被 /code-permit set 唤醒)。permit 不含凭据，仅控制何时允许点击发码。
PERMIT_EVENTS: dict[str, asyncio.Event] = {}
# session -> permit 到达时刻；允许 permit 比浏览器注册 Event 更早到。
PERMIT_VALUES: dict[str, float] = {}

# Login tokens are single-use for one Python boot. A receipt outlives the legacy
# 40-minute coordination window so delayed control messages cannot resurrect it.
LOGIN_TOKEN_TTL = 40 * 60
LOGIN_CANCEL_WAIT = 5.0
LOGIN_RUNS: dict[str, dict] = {}
LOGIN_TOMBSTONES: dict[str, dict] = {}


def _sweep_login_tombstones() -> None:
    cutoff = time.monotonic() - LOGIN_TOKEN_TTL
    for session in [
        s
        for s, receipt in LOGIN_TOMBSTONES.items()
        if receipt["retired_at"] < cutoff
    ]:
        LOGIN_TOMBSTONES.pop(session, None)


def _retire_login_run(session: str, task: asyncio.Task) -> None:
    control = LOGIN_RUNS.get(session)
    if control is not None and control["task"] is task:
        LOGIN_RUNS.pop(session, None)
        previous = LOGIN_TOMBSTONES.get(session)
        LOGIN_TOMBSTONES[session] = {
            "retired_at": time.monotonic(),
            "may_have_requested_code": bool(control["may_have_requested_code"])
            or bool(previous and previous["may_have_requested_code"]),
        }


def _login_token_rejection(session: str) -> web.Response | None:
    _sweep_login_tombstones()
    if session in LOGIN_TOMBSTONES:
        return web.json_response({"ok": False, "error": "LOGIN_SESSION_RETIRED"}, status=409)
    if session in LOGIN_RUNS:
        return web.json_response({"ok": False, "error": "LOGIN_SESSION_ACTIVE"}, status=409)
    return None


class CodeWaitTimeout(Exception):
    """内层「等 /code 推码」超时(验证码始终没到), 区别于外层 RUN_TOTAL_TIMEOUT。

    单独成类是为了让日志/HTTP 消息能准确区分两种超时: 邮件一直没来 vs 整体跑太久。
    """


class PermitWaitTimeout(Exception):
    """等待 DO 发放验证码租约 permit 超时。"""


class BrowserBusyError(Exception):
    """本进程已有重型浏览器任务在执行(CF profile 单任务互斥)。"""


class BrowserDeadlineExceeded(Exception):
    """operationTimeoutMs 预算耗尽:真实操作已被取消并清理。"""


class InvalidOperationTimeout(Exception):
    """operationTimeoutMs 入参非法(非整数/越界/该给未给)。"""


def boot_guard_response(request: web.Request) -> web.Response | None:
    """校验 X-Cqu-Expected-Boot-Id;不匹配返回 409 BROWSER_INSTANCE_REPLACED。

    必须在修改任何 Event/码/permit 字典之前调用。CF profile 头必填;国内默认
    profile 缺头仍按旧协议工作(仅当头存在且不匹配才拒绝)。
    """
    expected = request.headers.get(BOOT_HEADER)
    if expected == BOOT_ID:
        return None
    if expected is None and not browser_profile.CLOUDFLARE_PROFILE:
        return None
    log.warning("boot id mismatch (header %s)", "missing" if expected is None else "stale")
    return web.json_response(
        {"ok": False, "error": "BROWSER_INSTANCE_REPLACED"}, status=409
    )


def parse_operation_timeout_ms(body: dict) -> int | None:
    """解析并校验 operationTimeoutMs;缺失返回 None(国内旧协议)。

    JSON 里 NaN/Infinity/小数/字符串/bool 都不是合法的有限整数毫秒,一律 400,
    不做隐式钳制(调用方必须显式给出预算)。
    """
    value = body.get("operationTimeoutMs")
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise InvalidOperationTimeout("invalid operationTimeoutMs")
    if not (MIN_OPERATION_TIMEOUT_MS <= value <= MAX_OPERATION_TIMEOUT_MS):
        raise InvalidOperationTimeout("operationTimeoutMs out of range")
    return value


def parse_seed_state(body: dict) -> dict | None:
    """Validate the optional prior browser state before starting proxy/browser work."""
    value = body.get("seedState")
    if value is None:
        return None
    if not isinstance(value, dict) or not isinstance(value.get("cookies"), list):
        raise ValueError("invalid seedState")
    origins = value.get("origins", [])
    if not isinstance(origins, list):
        raise ValueError("invalid seedState")
    return {"cookies": value["cookies"], "origins": origins}


async def acquire_browser_job() -> bool:
    """尝试占用本进程唯一的重型浏览器槽(仅 CF profile 生效)。

    返回 True 表示本次请求实际获得锁,必须在 finally 调 release_browser_job(True);
    返回 False 表示当前 profile 不启用进程级互斥(国内默认),无需释放。
    被占用时抛 BrowserBusyError(→ 503 BROWSER_BUSY),不在 aiohttp 里排队。
    """
    if not browser_profile.CLOUDFLARE_PROFILE:
        return False
    if BROWSER_JOB_LOCK.locked():
        raise BrowserBusyError()
    await BROWSER_JOB_LOCK.acquire()
    return True


def release_browser_job(acquired: bool) -> None:
    """只释放本请求实际获得的锁;参数校验失败/被拒的请求不得误释放他人锁。"""
    if acquired:
        BROWSER_JOB_LOCK.release()


async def run_bounded(coro, timeout_ms: int | None):
    """在 operationTimeoutMs 预算内执行真实操作;超时先取消协程并等其 finally
    (关浏览器/清资源)真实执行完,再抛 BrowserDeadlineExceeded。不吞外层
    CancelledError(客户端断连/处理器取消仍向上传播,且同样取消内层操作)。"""
    if timeout_ms is None:
        return await coro
    # 不用 wait_for:它把「预算耗尽」与「内层自身抛的 TimeoutError」混成同一种异常,
    # 会把 RUN_TOTAL_TIMEOUT 等业务超时误报成 BROWSER_DEADLINE。先 wait 再判 done。
    task = asyncio.ensure_future(coro)
    try:
        done, _ = await asyncio.wait({task}, timeout=timeout_ms / 1000)
    except BaseException:
        # 外层被取消(客户端断连):同样要取消内层操作,不留后台浏览器继续跑。
        task.cancel()
        try:
            await task
        except BaseException:
            pass
        raise
    if task not in done:
        task.cancel()
        try:
            # 等取消落地:确保内层 finally(关浏览器/清资源)真实执行完再报 deadline。
            await task
        except asyncio.CancelledError:
            if not task.cancelled():
                raise
        except Exception:  # noqa: BLE001 - 清理期异常不掩盖 deadline 事实
            pass
        raise BrowserDeadlineExceeded()
    return await task


def _sweep_stale_codes() -> None:
    """删除早于 CODE_WAIT_TIMEOUT 的孤儿 /code 存码(及其 Event), 防止明文码无界堆积/长期驻留。"""
    now = time.time()
    for sess in [s for s, (_, ts) in CODE_VALUES.items() if now - ts > CODE_WAIT_TIMEOUT]:
        CODE_VALUES.pop(sess, None)
        CODE_EVENTS.pop(sess, None)
    for sess in [
        s
        for s, (_, ts) in REUSABLE_CODE_VALUES.items()
        if now - ts > CODE_WAIT_TIMEOUT
    ]:
        REUSABLE_CODE_VALUES.pop(sess, None)
        REUSABLE_CODE_EVENTS.pop(sess, None)


def _sweep_stale_permits() -> None:
    now = time.time()
    for sess in [
        s for s, ts in PERMIT_VALUES.items() if now - ts > CODE_WAIT_TIMEOUT
    ]:
        PERMIT_VALUES.pop(sess, None)
        PERMIT_EVENTS.pop(sess, None)


async def _run_with_separate_permit_budget(
    login_coro, permit_claimed, permit_phase_timeout=PERMIT_PHASE_TIMEOUT
):
    """排队阶段与 owner 阶段分别计时，避免合法 FIFO waiter 先于 owner 退出。"""
    login_task = asyncio.create_task(login_coro)
    permit_task = asyncio.create_task(permit_claimed.wait())
    try:
        done, _ = await asyncio.wait(
            {login_task, permit_task},
            timeout=permit_phase_timeout,
            return_when=asyncio.FIRST_COMPLETED,
        )
        if login_task in done:
            return await login_task
        if permit_task not in done:
            login_task.cancel()
            await asyncio.gather(login_task, return_exceptions=True)
            raise PermitWaitTimeout(
                f"code permit phase timed out (>{permit_phase_timeout}s)"
            )
        return await asyncio.wait_for(login_task, timeout=RUN_TOTAL_TIMEOUT)
    finally:
        # 任何出口(含外层 operationTimeoutMs 取消/客户端断连)都必须终止 login_task,
        # 否则 HTTP 已返回而后台浏览器协程仍在跑(继续发码/占资源)。
        if not login_task.done():
            login_task.cancel()
            await asyncio.gather(login_task, return_exceptions=True)
        if not permit_task.done():
            permit_task.cancel()
        await asyncio.gather(permit_task, return_exceptions=True)


async def run_handler(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        mark_business_outcome("failure", "INVALID_REQUEST")
        return web.json_response({"ok": False, "error": "invalid JSON body"}, status=400)

    student_id = body.get("studentId")
    password = body.get("password")
    service = body.get("service")
    method = body.get("method", "mail")
    session = body.get("session") or "default"
    if not (student_id and password and service):
        mark_business_outcome("failure", "INVALID_REQUEST")
        return web.json_response(
            {"ok": False, "error": "missing required field: studentId/password/service"},
            status=400,
        )

    try:
        seed_state = parse_seed_state(body)
    except ValueError as error:
        mark_business_outcome("failure", "INVALID_SEED")
        return web.json_response({"ok": False, "error": str(error)}, status=400)

    boot_guard = boot_guard_response(request)
    if boot_guard is not None:
        mark_business_outcome("failure", "BOOT_GUARD")
        return boot_guard
    try:
        operation_timeout_ms = parse_operation_timeout_ms(body)
    except InvalidOperationTimeout as error:
        mark_business_outcome("failure", "INVALID_TIMEOUT")
        return web.json_response({"ok": False, "error": str(error)}, status=400)
    if operation_timeout_ms is None and browser_profile.CLOUDFLARE_PROFILE:
        mark_business_outcome("failure", "INVALID_TIMEOUT")
        return web.json_response(
            {"ok": False, "error": "operationTimeoutMs is required"}, status=400
        )

    # H3 纵深第二层: /run 也是 CAS 铸 ST 入口, 与 /service-ticket /keepalive 对称——service host
    # 必须是 https 的 *.cqu.edu.cn(策略对齐 DO 侧 service-url.ts), 杜绝 CVE-2022-39369 式 ST-relay
    # (红线本只在上游 DO, 此为节点侧纵深防御: VPC 误配 / 将来新增直连本节点的调用方时仍兜得住)。
    # 放在 qg acquire / Event 注册之前: 拒绝路径不白嫖一次青果提取、不注册 Event/Value(无需 finally 清理)。
    # 通过 → canonical(小写 host、去 :443)传给 run_login, 对齐取票整链 canonical 口径单一。
    canonical_service = is_allowed_service_url(service)
    if canonical_service is None:
        log.warning("run rejected serviceUrl (host not allowed)")
        mark_business_outcome("failure", "SERVICE_NOT_ALLOWED")
        return web.json_response({"ok": False, "error": "service not allowed"}, status=400)
    service = canonical_service

    token_rejection = _login_token_rejection(session)
    if token_rejection is not None:
        mark_business_outcome("failure", "LOGIN_RETIRED")
        return token_rejection
    run_task = asyncio.current_task()
    if run_task is None:
        mark_business_outcome("failure", "LOGIN_TASK_UNAVAILABLE")
        return web.json_response({"ok": False, "error": "LOGIN_TASK_UNAVAILABLE"}, status=503)
    LOGIN_RUNS[session] = {
        "task": run_task,
        "cancel_requested": False,
        "may_have_requested_code": False,
    }
    run_task.add_done_callback(lambda task, token=session: _retire_login_run(token, task))

    # 灰度: QG_PROXY_LOGIN/QG_ENABLED 决定 /run 走青果(登录包)还是节点直连。走青果时拿不到 IP
    # → 502 硬依赖回退(绝不悄悄 fallback 直连); 直连时 proxy=None, 由节点境内 IP 连 CQU。
    # 放在 Event 注册之前: 早退路径不注册 Event/Value, 无需 finally 清理。
    proxy = None
    if should_use_proxy("login"):
        try:
            proxy = await acquire_qg_proxy("login")
        except QgExtractError as e:
            mark_business_outcome("failure", "CONTAINER_UNAVAILABLE")
            return login_failure_response("CONTAINER_UNAVAILABLE", status=502)

    # 单任务互斥在所有参数/boot 校验之后、Event 注册之前:被拒请求不创建任何
    # CODE_EVENTS,也不影响在途任务的锁。
    job_acquired = False
    try:
        job_acquired = await acquire_browser_job()
    except BrowserBusyError:
        log.warning("run busy (another heavy browser job holds this instance)")
        mark_business_outcome("failure", "BROWSER_BUSY")
        return login_failure_response("BROWSER_BUSY", status=503)

    ev = asyncio.Event()
    CODE_EVENTS[session] = ev
    # I1: /code 可能在本 Event 注册前略早到达; 若码已在, 立即唤醒, 避免错过唤醒永久阻塞。
    if session in CODE_VALUES:
        ev.set()
    reusable_ev = asyncio.Event()
    REUSABLE_CODE_EVENTS[session] = reusable_ev
    if session in REUSABLE_CODE_VALUES:
        reusable_ev.set()
    permit_ev = asyncio.Event()
    permit_claimed = asyncio.Event()
    PERMIT_EVENTS[session] = permit_ev
    if session in PERMIT_VALUES:
        permit_ev.set()

    async def code_waiter() -> str:
        # run_login 在发码后 await 它: 阻塞到 /code 推入并 set Event, 上限 CODE_WAIT_TIMEOUT。
        # 内层超时抛 CodeWaitTimeout(而非裸 TimeoutError)→ 与外层 RUN_TOTAL_TIMEOUT 区分,
        # 让日志/HTTP 消息能准确指出是「码一直没到」而非「整体跑太久」。
        # run_login 不吞该异常 → 其 finally 关浏览器(凭证不再驻留)。
        try:
            await asyncio.wait_for(ev.wait(), timeout=CODE_WAIT_TIMEOUT)
        except asyncio.TimeoutError as e:
            raise CodeWaitTimeout(
                f"等验证码超时(>{CODE_WAIT_TIMEOUT}s, code never arrived)"
            ) from e
        entry = CODE_VALUES.pop(session, None)
        return entry[0] if entry else ""

    async def reusable_code_waiter() -> str:
        # already_valid 不会再发邮件；优先吃恰好迟到的新鲜投递，否则吃 owner 专属预载码。
        if session not in CODE_VALUES and session not in REUSABLE_CODE_VALUES:
            fresh_wait = asyncio.create_task(ev.wait())
            reusable_wait = asyncio.create_task(reusable_ev.wait())
            try:
                done, pending = await asyncio.wait(
                    {fresh_wait, reusable_wait},
                    timeout=CODE_WAIT_TIMEOUT,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if not done:
                    raise CodeWaitTimeout("reusable code never arrived")
                for task in pending:
                    task.cancel()
                await asyncio.gather(*pending, return_exceptions=True)
            finally:
                for task in (fresh_wait, reusable_wait):
                    if not task.done():
                        task.cancel()
                await asyncio.gather(
                    fresh_wait, reusable_wait, return_exceptions=True
                )
        entry = CODE_VALUES.pop(session, None)
        if entry is None:
            entry = REUSABLE_CODE_VALUES.pop(session, None)
        return entry[0] if entry else ""

    async def permit_waiter() -> None:
        try:
            await asyncio.wait_for(
                permit_ev.wait(), timeout=PERMIT_WAIT_TIMEOUT
            )
        except asyncio.TimeoutError as e:
            raise PermitWaitTimeout(
                f"code permit timed out (>{PERMIT_WAIT_TIMEOUT}s)"
            ) from e
        control = LOGIN_RUNS.get(session)
        if control is not None and control["task"] is run_task:
            # Once the browser receives this return it may immediately click send.
            # Record the risk before yielding control back into the login driver.
            control["may_have_requested_code"] = True
        PERMIT_VALUES.pop(session, None)
        permit_claimed.set()

    log.info("run start method=%s", method)
    try:
        result = await run_bounded(
            _run_with_separate_permit_budget(
                cqu_login.run_login(
                    student_id=student_id,
                    password=password,
                    service=service,
                    method=method,
                    code_provider=code_waiter,
                    reusable_code_provider=reusable_code_waiter,
                    permit_provider=permit_waiter,
                    proxy=proxy,
                    seed_state=seed_state,
                ),
                permit_claimed,
            ),
            operation_timeout_ms,
        )
        # ticket 是 bearer 凭据, 不入日志(session 不是凭据可留); 对齐 DO 审计「绝不记录 ticket/cookies/密码」。
        log.info("run ok")
        mark_business_outcome("success")
        return web.json_response({"ok": True, **result})
    except BrowserDeadlineExceeded:
        # operationTimeoutMs 预算耗尽:内层协程已被取消,其 finally 已关浏览器;
        # 本 handler 的 finally 会清本 token 的全部 Event/Value 并释放重型锁。
        log.warning("run deadline exceeded (operationTimeoutMs=%d)", operation_timeout_ms or -1)
        return login_failure_response("BROWSER_DEADLINE", status=503)
    except CodeWaitTimeout:
        # 内层: 等码超时, 验证码始终没到(邮件未送达 / DO 未推码)。
        log.warning(
            "run timeout (code-wait >%ds, code never arrived)",
            CODE_WAIT_TIMEOUT,
        )
        return login_failure_response("OTP_TIMEOUT", status=504)
    except PermitWaitTimeout:
        log.warning("run timeout (code permit never arrived)")
        return login_failure_response("CODE_PERMIT_TIMEOUT", status=504)
    except asyncio.TimeoutError:
        # 外层: 单次 /run 整体超时(第一因素/发码/提交某段太慢, 非单纯等码)。
        log.warning("run timeout (total >%ds)", RUN_TOTAL_TIMEOUT)
        return login_failure_response("BROWSER_DEADLINE", status=504)
    except Exception as e:  # noqa: BLE001 - surface any login failure to the caller
        failure = normalize_login_failure(e)
        safe_capture_exception(
            request.app.get(POSTHOG_CLIENT_KEY),
            e,
            {"operation": "login", "error_code": failure["errorCode"]},
        )
        return login_failure_response(e, status=500)
    finally:
        CODE_EVENTS.pop(session, None)
        CODE_VALUES.pop(session, None)
        REUSABLE_CODE_EVENTS.pop(session, None)
        REUSABLE_CODE_VALUES.pop(session, None)
        PERMIT_EVENTS.pop(session, None)
        PERMIT_VALUES.pop(session, None)
        release_browser_job(job_acquired)


async def code_handler(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid JSON body"}, status=400)

    boot_guard = boot_guard_response(request)
    if boot_guard is not None:
        return boot_guard

    session = body.get("session") or "default"
    _sweep_login_tombstones()
    if session in LOGIN_TOMBSTONES:
        return web.json_response({"ok": False, "error": "LOGIN_SESSION_RETIRED"}, status=409)
    code = body.get("code")
    reusable = body.get("reusable") is True
    if not code:
        return web.json_response({"ok": False, "error": "missing code"}, status=400)

    # I2: 顺手清掉过期孤儿码, 防止无人认领的明文码无界堆积/长期驻留。
    _sweep_stale_codes()
    if reusable:
        REUSABLE_CODE_VALUES[session] = (str(code), time.time())
        reusable_event = REUSABLE_CODE_EVENTS.get(session)
        if reusable_event is not None:
            reusable_event.set()
            log.info("reusable code deposited (woke in-flight login)")
            return web.json_response({"ok": True})
        log.info("reusable code deposited (no in-flight login yet)")
        return web.json_response({"ok": True, "waiting": False})
    CODE_VALUES[session] = (str(code), time.time())
    ev = CODE_EVENTS.get(session)
    if ev is not None:
        ev.set()
        log.info("code deposited (woke in-flight run)")
        return web.json_response({"ok": True})
    # 没有在途 /run: 仍存码(竞态: /code 先到), 但提示无等待者。
    log.info("code deposited (no in-flight run yet)")
    return web.json_response({"ok": True, "waiting": False})


async def code_permit_handler(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        return web.json_response(
            {"ok": False, "error": "invalid JSON body"}, status=400
        )

    boot_guard = boot_guard_response(request)
    if boot_guard is not None:
        return boot_guard
    session = body.get("session")
    if not session:
        return web.json_response(
            {"ok": False, "error": "missing session"}, status=400
        )

    _sweep_login_tombstones()
    if str(session) in LOGIN_TOMBSTONES:
        return web.json_response({"ok": False, "error": "LOGIN_SESSION_RETIRED"}, status=409)

    _sweep_stale_permits()
    PERMIT_VALUES[str(session)] = time.time()
    event = PERMIT_EVENTS.get(str(session))
    if event is not None:
        event.set()
        log.info("code permit deposited (woke in-flight login)")
        return web.json_response({"ok": True})
    log.info("code permit deposited (no in-flight login yet)")
    return web.json_response({"ok": True, "waiting": False})


async def login_cancel_handler(request: web.Request) -> web.Response:
    """Retire one login token and wait a bounded time for its cleanup to finish."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid JSON body"}, status=400)

    boot_guard = boot_guard_response(request)
    if boot_guard is not None:
        return boot_guard
    session = body.get("session")
    if not isinstance(session, str) or not session:
        return web.json_response({"ok": False, "error": "missing session"}, status=400)

    _sweep_login_tombstones()
    control = LOGIN_RUNS.get(session)
    if control is None:
        receipt = LOGIN_TOMBSTONES.get(session)
        may_have_requested_code = bool(
            receipt and receipt["may_have_requested_code"]
        )
        if receipt is None:
            LOGIN_TOMBSTONES[session] = {
                "retired_at": time.monotonic(),
                "may_have_requested_code": False,
            }
        return web.json_response({
            "ok": True,
            "stopped": True,
            "mayHaveRequestedCode": may_have_requested_code,
        })

    task = control["task"]
    if not control["cancel_requested"]:
        control["cancel_requested"] = True
        LOGIN_TOMBSTONES[session] = {
            "retired_at": time.monotonic(),
            "may_have_requested_code": bool(control["may_have_requested_code"]),
        }
        task.cancel()
    try:
        await asyncio.wait_for(asyncio.shield(task), timeout=LOGIN_CANCEL_WAIT)
    except asyncio.CancelledError:
        pass
    except asyncio.TimeoutError:
        return web.json_response(
            {
                "ok": False,
                "stopped": False,
                "error": "LOGIN_CLEANUP_PENDING",
                "mayHaveRequestedCode": bool(control["may_have_requested_code"]),
            },
            status=503,
        )
    except Exception:
        # The cancelled handler may finish through an existing error response. Its
        # result is irrelevant; task completion proves all handler cleanup ran.
        pass
    if not task.done():
        return web.json_response(
            {
                "ok": False,
                "stopped": False,
                "error": "LOGIN_CLEANUP_PENDING",
                "mayHaveRequestedCode": bool(control["may_have_requested_code"]),
            },
            status=503,
        )
    _retire_login_run(session, task)
    receipt = LOGIN_TOMBSTONES[session]
    return web.json_response({
        "ok": True,
        "stopped": True,
        "mayHaveRequestedCode": bool(receipt["may_have_requested_code"]),
    })


async def service_ticket_handler(request: web.Request) -> web.Response:
    """POST /service-ticket {serviceUrl, state} → 临时浏览器水化完整 storage_state 换一张 ST。

    取票安全闸(serviceUrl host 校验 / quicklogin opt-in / 限流 / 审计)仍在上游 DO,
    这里只负责"换票"。浏览器水化取票过瑞数 JS 挑战(httpx/青果均挡不过,见设计文档)。
    · 成功 → 200 {ok:true, ticket}
    · 会话过期(落回 CAS 登录页, ExpiredError)→ 409,交上游 DO 重登(与旧契约一致)
    · 未取到票(NO_TICKET/浏览器崩/超时)→ 502,让上游退避重试
    """
    try:
        body = await request.json()
    except Exception:
        mark_business_outcome("failure", "INVALID_REQUEST")
        return web.json_response({"ok": False, "error": "invalid JSON body"}, status=400)

    service_url = body.get("serviceUrl")
    state = body.get("state")
    if not service_url or not isinstance(state, dict):
        mark_business_outcome("failure", "INVALID_REQUEST")
        return web.json_response(
            {"ok": False, "error": "missing required field: serviceUrl/state (object)"},
            status=400,
        )

    # 纵深第二层: serviceUrl host 必须是 https 的 *.cqu.edu.cn(策略对齐 DO 侧 service-url.ts),
    # 杜绝 CVE-2022-39369 式 ST-relay。不通过 → 400(客户端契约错), error 不泄露具体红线细节。
    # 通过返回 canonical URL(小写 host、去 :443), 后续浏览器水化导航 / abort 比对全用 canonical 口径单一。
    canonical_url = is_allowed_service_url(service_url)
    if canonical_url is None:
        log.warning("service-ticket rejected serviceUrl (host not allowed)")
        mark_business_outcome("failure", "SERVICE_NOT_ALLOWED")
        return web.json_response({"ok": False, "error": "serviceUrl not allowed"}, status=400)

    try:
        operation_timeout_ms = parse_operation_timeout_ms(body)
    except InvalidOperationTimeout as error:
        mark_business_outcome("failure", "INVALID_TIMEOUT")
        return web.json_response({"ok": False, "error": str(error)}, status=400)
    if operation_timeout_ms is None and browser_profile.CLOUDFLARE_PROFILE:
        mark_business_outcome("failure", "INVALID_TIMEOUT")
        return web.json_response(
            {"ok": False, "error": "operationTimeoutMs is required"}, status=400
        )

    job_acquired = False
    try:
        job_acquired = await acquire_browser_job()
    except BrowserBusyError:
        log.warning("service-ticket busy (another heavy browser job holds this instance)")
        mark_business_outcome("failure", "BROWSER_BUSY")
        return web.json_response({"ok": False, "error": "BROWSER_BUSY"}, status=503)

    try:
        ticket = await run_bounded(
            cqu_ticket_browser.fetch_service_ticket_browser(canonical_url, state),
            operation_timeout_ms,
        )
        # ST 是 bearer 凭据, 只记长度供诊断, 绝不打值。
        log.info("service-ticket ok (len=%d)", len(ticket))
        mark_business_outcome("success")
        return web.json_response({"ok": True, "ticket": ticket})
    except BrowserDeadlineExceeded:
        log.warning("service-ticket deadline exceeded (operationTimeoutMs=%d)", operation_timeout_ms or -1)
        mark_business_outcome("failure", "BROWSER_DEADLINE")
        return web.json_response(
            {"ok": False, "error": "BROWSER_DEADLINE"}, status=503
        )
    except cqu_ticket_browser.ExpiredError as e:
        # 落回 CAS 登录页 = 会话过期 → 409(客户端态, 交 DO 重登)。HTTP 状态码(409)是 DO
        # classifyNodeTicketResponse 分类的唯一依据, body.error 不参与分类——故 error 只回稳定
        # 类型名, 不回 str(e): patchright 抛的异常 message 可能含 cookie/state 明文, 经 200/409/502
        # body 透传到 route 客户端 + log 落 CF observability(下游只截断不脱敏, 救不了)。日志同理只记类型名。
        log.warning("service-ticket expired: %s", type(e).__name__)
        mark_business_outcome("failure", "SESSION_EXPIRED")
        return web.json_response({"ok": False, "error": type(e).__name__}, status=409)
    except Exception as e:  # noqa: BLE001 - NoTicketError/浏览器崩/超时 → 502 瞬态, 让上游退避
        safe_capture_exception(
            request.app.get(POSTHOG_CLIENT_KEY),
            e,
            {"operation": "service_ticket", "error_code": "SERVICE_TICKET_TRANSIENT"},
        )
        # 同上脱敏: error/log 只记 type(e).__name__, 不拼 str(e)(防 cookie/state 明文外泄)。
        # 状态码语义(502)不变 → DO 据状态码分类, 不依赖 body 文案。
        log.warning("service-ticket transient: %s", type(e).__name__)
        mark_business_outcome("failure", "SERVICE_TICKET_TRANSIENT")
        return web.json_response({"ok": False, "error": type(e).__name__}, status=502)
    finally:
        release_browser_job(job_acquired)


async def keepalive_handler(request: web.Request) -> web.Response:
    """POST /keepalive {state} → 临时浏览器水化探活, 返回三态 + 刷新后的 storage_state 给 DO。

    只返回探测事实(alive/expired/unreachable)+ 刷新 state;熔断/退避/重登的状态机在上游 DO。
    探不通绝不误判过期(归 unreachable, DO 退避)。三态恒以 200 返回。
    """
    try:
        body = await request.json()
    except Exception:
        mark_business_outcome("failure", "INVALID_REQUEST")
        return web.json_response({"ok": False, "error": "invalid JSON body"}, status=400)
    state = body.get("state")
    if not isinstance(state, dict):
        mark_business_outcome("failure", "INVALID_REQUEST")
        return web.json_response(
            {"ok": False, "error": "missing required field: state (object)"}, status=400)

    try:
        operation_timeout_ms = parse_operation_timeout_ms(body)
    except InvalidOperationTimeout as error:
        mark_business_outcome("failure", "INVALID_TIMEOUT")
        return web.json_response({"ok": False, "error": str(error)}, status=400)
    if operation_timeout_ms is None and browser_profile.CLOUDFLARE_PROFILE:
        mark_business_outcome("failure", "INVALID_TIMEOUT")
        return web.json_response(
            {"ok": False, "error": "operationTimeoutMs is required"}, status=400
        )

    job_acquired = False
    try:
        job_acquired = await acquire_browser_job()
    except BrowserBusyError:
        log.warning("keepalive busy (another heavy browser job holds this instance)")
        mark_business_outcome("failure", "BROWSER_BUSY")
        return web.json_response({"ok": False, "error": "BROWSER_BUSY"}, status=503)
    try:
        result = await run_bounded(
            cqu_keepalive.probe_session_browser(state), operation_timeout_ms
        )
    except BrowserDeadlineExceeded:
        # deadline 是稳定瞬态基础设施错误,不能被下面的 unreachable 兜底吞成 200。
        log.warning("keepalive deadline exceeded (operationTimeoutMs=%d)", operation_timeout_ms or -1)
        mark_business_outcome("failure", "BROWSER_DEADLINE")
        return web.json_response(
            {"ok": False, "error": "BROWSER_DEADLINE"}, status=503
        )
    except Exception as e:  # noqa: BLE001 - 纵深兜底, 探活对 DO 永远只返回探测事实(200)
        safe_capture_exception(
            request.app.get(POSTHOG_CLIENT_KEY),
            e,
            {"operation": "keepalive", "error_code": "KEEPALIVE_UNREACHABLE"},
        )
        # M9: detail(body)与 log 都只记 type(e).__name__, 不拼 str(e): 异常 message 可能含
        # state/cookie 片段, 经 200 body 回传 DO 并落 CF observability(下游 sanitizeNodeDetail
        # 只截断不脱敏, 救不了)。补齐"body 防了 log 没防"的不一致。
        log.warning("keepalive probe unexpected error (→ unreachable): %s", type(e).__name__)
        result = {"status": "unreachable", "state": state, "detail": type(e).__name__}
    finally:
        release_browser_job(job_acquired)
    log.info("keepalive status=%s detail=%s", result["status"], (result.get("detail", "") or "")[:80])
    mark_business_outcome(
        "success" if result["status"] == "alive" else "failure",
        result["status"].upper(),
    )
    return web.json_response({"ok": True, **result})


async def data_harvest_handler(request: web.Request) -> web.Response:
    """POST /data-harvest {state, navUrl, capture[], fetch[]} → 临时浏览器水化 organic harvest。

    安全闸(navUrl/capture/fetch host 白名单 / 限流 / 审计 / needs_reauth)仍在上游 DO,
    这里负责:① recipe 二次校验(纵深,对齐 service-ticket 的 host 双层防御)② 起浏览器取数。
    · recipe 非法(host 越界 / method 非 GET / 缺字段)→ 400(客户端契约错)
    · 取数成功 → 200 {ok:true, captures, fetches}
    · 浏览器崩/超时/异常 → 502(瞬态, 让上游退避);error 只回 type(e).__name__(脱敏,
      绝不拼 str(e) —— 异常 message 可能含 state/cookie 明文, 经 body 透传 + 落 CF observability)
    """
    try:
        body = await request.json()
    except Exception:
        mark_business_outcome("failure", "INVALID_REQUEST")
        return web.json_response({"ok": False, "error": "invalid JSON body"}, status=400)

    state = body.get("state")
    if not isinstance(state, dict):
        mark_business_outcome("failure", "INVALID_REQUEST")
        return web.json_response(
            {"ok": False, "error": "missing required field: state (object)"}, status=400)

    # 纵深第二层: recipe(navUrl/capture/fetch)只允许 Direct 固定 host。
    # 不通过 → 400, error 不泄露具体红线细节(只回类型名)。
    try:
        recipe = cqu_data_harvest.parse_harvest_recipe(body)
    except cqu_data_harvest.HarvestRecipeError:
        log.warning("data-harvest rejected recipe (host/shape not allowed)")
        mark_business_outcome("failure", "RECIPE_NOT_ALLOWED")
        return web.json_response({"ok": False, "error": "recipe not allowed"}, status=400)

    try:
        operation_timeout_ms = parse_operation_timeout_ms(body)
    except InvalidOperationTimeout as error:
        mark_business_outcome("failure", "INVALID_TIMEOUT")
        return web.json_response({"ok": False, "error": str(error)}, status=400)
    if operation_timeout_ms is None and browser_profile.CLOUDFLARE_PROFILE:
        mark_business_outcome("failure", "INVALID_TIMEOUT")
        return web.json_response(
            {"ok": False, "error": "operationTimeoutMs is required"}, status=400
        )

    job_acquired = False
    try:
        job_acquired = await acquire_browser_job()
    except BrowserBusyError:
        log.warning("data-harvest busy (another heavy browser job holds this instance)")
        mark_business_outcome("failure", "BROWSER_BUSY")
        return web.json_response({"ok": False, "error": "BROWSER_BUSY"}, status=503)

    try:
        result = await run_bounded(
            cqu_data_harvest.harvest(state, recipe), operation_timeout_ms
        )
        diagnostics = cqu_data_harvest.sanitize_harvest_diagnostics(
            result.get("diagnostics", {})
        )
        # Course bodies and refreshed state stay outside the diagnostic log.
        log.info("data-harvest ok (captures=%d fetches=%d) diagnostics %s",
                 len(result.get("captures", [])), len(result.get("fetches", [])),
                 json.dumps(diagnostics, sort_keys=True, separators=(",", ":")))
        if "diagnostics" in result:
            result = {**result, "diagnostics": diagnostics}
        mark_business_outcome("success")
        return web.json_response({"ok": True, **result})
    except BrowserDeadlineExceeded:
        # 稳定 deadline 码优先于 harvest 业务分类,绝不能被包装成 HARVEST_TRANSIENT。
        log.warning("data-harvest deadline exceeded (operationTimeoutMs=%d)", operation_timeout_ms or -1)
        mark_business_outcome("failure", "BROWSER_DEADLINE")
        return web.json_response(
            {"ok": False, "error": "BROWSER_DEADLINE"}, status=503
        )
    except cqu_data_harvest.HarvestExpiredError:
        # 会话过期: navUrl 落回 CAS 登录页, 无 capture 命中 → 409 {"error":"TGT_EXPIRED"}
        # (镜像 /service-ticket 的 ExpiredError→409)。DO classifyNodeHarvestResponse 据 409 判
        # TGT_EXPIRED → setAlarm 触发重登; 否则 harvest 静默返回空数据, 会话永不自愈。
        log.warning("data-harvest expired (session redirected to CAS login) → 409")
        mark_business_outcome("failure", "SESSION_EXPIRED")
        return web.json_response({"ok": False, "error": "TGT_EXPIRED"}, status=409)
    except cqu_data_harvest.HarvestTransientError as e:
        # Exception diagnostics are untrusted at this handler boundary. Rebuild them
        # from the fixed stage/event allowlist before either logging or returning.
        diagnostics = cqu_data_harvest.sanitize_harvest_diagnostics(
            getattr(e, "diagnostics", {})
        )
        log.warning(
            "data-harvest transient diagnostics %s",
            json.dumps(diagnostics, sort_keys=True, separators=(",", ":"), default=str),
        )
        code = getattr(e, "code", None)
        if not isinstance(code, str) or code not in cqu_data_harvest.HARVEST_ERROR_STATUS:
            code = "HARVEST_TRANSIENT"
        mark_business_outcome("failure", code)
        return web.json_response(
            {"ok": False, "error": code, "diagnostics": diagnostics},
            status=cqu_data_harvest.HARVEST_ERROR_STATUS[code],
        )
    except Exception as e:  # noqa: BLE001 - Unknown browser/transport failures are residual.
        safe_capture_exception(
            request.app.get(POSTHOG_CLIENT_KEY),
            e,
            {"operation": "data_harvest", "error_code": "HARVEST_TRANSIENT"},
        )
        log.warning("data-harvest transient: %s", type(e).__name__)
        mark_business_outcome("failure", "HARVEST_TRANSIENT")
        return web.json_response({"ok": False, "error": "HARVEST_TRANSIENT"}, status=503)
    finally:
        release_browser_job(job_acquired)


async def external_search_handler(request: web.Request) -> web.Response:
    """POST /external-search {state, action, business filters} -> typed search payload."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid JSON body"}, status=400)
    if not isinstance(body, dict) or not isinstance(body.get("state"), dict):
        return web.json_response({"ok": False, "error": "missing required field: state (object)"}, status=400)

    try:
        operation_timeout_ms = parse_operation_timeout_ms(body)
    except InvalidOperationTimeout as error:
        return web.json_response({"ok": False, "error": str(error)}, status=400)
    if operation_timeout_ms is None and browser_profile.CLOUDFLARE_PROFILE:
        return web.json_response({"ok": False, "error": "operationTimeoutMs is required"}, status=400)
    try:
        recipe = cqu_external_search.parse_external_search_recipe(body)
    except cqu_external_search.ExternalSearchRecipeError:
        return web.json_response({"ok": False, "error": "recipe not allowed"}, status=400)

    try:
        job_acquired = await acquire_browser_job()
    except BrowserBusyError:
        return web.json_response({"ok": False, "error": "BROWSER_BUSY"}, status=503)
    try:
        result = await run_bounded(
            cqu_external_search.external_search(body["state"], recipe),
            operation_timeout_ms,
        )
        typed = cqu_external_search.sanitize_external_search_result(result)
        return web.json_response({"ok": True, **typed})
    except BrowserDeadlineExceeded:
        return web.json_response({"ok": False, "error": "BROWSER_DEADLINE"}, status=503)
    except cqu_external_search.ExternalSearchTransientError as error:
        code = error.code
        return web.json_response({"ok": False, "error": code}, status=cqu_external_search.ERROR_STATUS[code])
    except Exception as error:
        safe_capture_exception(
            request.app.get(POSTHOG_CLIENT_KEY),
            error,
            {"operation": "external_search", "error_code": "SEARCH_TRANSIENT"},
        )
        return web.json_response({"ok": False, "error": "SEARCH_TRANSIENT"}, status=503)
    finally:
        release_browser_job(job_acquired)


async def health_handler(_request: web.Request) -> web.Response:
    return web.json_response(
        {
            "ok": True,
            "apiVersion": NODE_API_VERSION,
            "capabilities": NODE_CAPABILITIES,
            "bootId": BOOT_ID,
            # 动态取当前 profile,与请求路径的判定同源(测试可注入)。
            "browserProfile": (
                "cloudflare"
                if browser_profile.CLOUDFLARE_PROFILE
                else browser_profile.PROFILE_NAME
            ),
        }
    )


def build_app() -> web.Application:
    app = web.Application(middlewares=[posthog_exception_middleware])
    app[POSTHOG_CLIENT_KEY] = create_posthog_client()
    app.on_cleanup.append(flush_posthog)
    app.add_routes([
        web.post("/run", run_handler),
        web.post("/code", code_handler),
        web.post("/code-permit", code_permit_handler),
        web.post("/login-cancel", login_cancel_handler),
        web.post("/service-ticket", service_ticket_handler),
        web.post("/keepalive", keepalive_handler),
        web.post("/data-harvest", data_harvest_handler),
        web.post("/external-search", external_search_handler),
        # CF Containers 默认探测 /ping 判断实例就绪。
        web.get("/ping", health_handler),
        web.get("/health", health_handler),
    ])
    return app


if __name__ == "__main__":
    web.run_app(build_app(), host="0.0.0.0", port=8080)
