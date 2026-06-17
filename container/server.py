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
import logging
import time

from aiohttp import web

import cqu_login  # 改造后的登录器, 暴露 run_login(...)
import cqu_keepalive  # 国内节点浏览器水化探活, 暴露 probe_session_browser(...)
import cqu_ticket_browser  # 浏览器水化取 ST(过瑞数 JS 挑战), 暴露 fetch_service_ticket_browser(...)
from qg_proxy import acquire_qg_proxy, QgExtractError, should_use_proxy  # 青果代理 + 灰度门(/run 登录仍用)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("cqu-login-server")

# ── 超时链路标定(CQU 邮件慢, 把等码上限抬到 ~10min) ─────────────────────────────
# CQU 2FA 验证码自「点发码」起有效 600s。围绕这条硬上限标定两级超时:
#   · CODE_WAIT_TIMEOUT(570s): 等 /code 推码的上限。刻意停在距 600s 有效期约 30s 之前——
#     即便码临近 deadline 才到, 也还留有余量提交后再过期; 若死等满 600s, 码会恰在到达那一刻失效。
#   · RUN_TOTAL_TIMEOUT(660s): 单次 /run 整体上限, 含第一因素 + 570s 等码 + 提交/开销。
#     须 > CODE_WAIT(570s) + 第一因素/发码开销, 故取 660s。
# 不变式(必须成立):
#   LOGIN_LOCK_TTL_MS(720s) > RUN_TOTAL_TIMEOUT(660s) > CODE_WAIT_TIMEOUT(570s),
#   且 CODE_WAIT_TIMEOUT(570s) < 码有效期(600s)并留提交余量。
# 改这两值须同步上调 src/services/cqu-2fa/single-flight.ts 的 LOGIN_LOCK_TTL_MS(须 > RUN_TOTAL_TIMEOUT)。
CODE_WAIT_TIMEOUT = 570
# 单次 /run 的整体上限(秒): 含发码 + 等码 + 提交, 超时返回 504 而非永久挂住凭证路径。
RUN_TOTAL_TIMEOUT = 660

# session -> Event(被 /code set 唤醒)。
CODE_EVENTS: dict[str, asyncio.Event] = {}
# session -> (验证码字符串, 存入时刻 time.time())。存入时刻用于清理过期(孤儿)码, 避免明文码长期驻留。
CODE_VALUES: dict[str, tuple[str, float]] = {}


class CodeWaitTimeout(Exception):
    """内层「等 /code 推码」超时(验证码始终没到), 区别于外层 RUN_TOTAL_TIMEOUT。

    单独成类是为了让日志/HTTP 消息能准确区分两种超时: 邮件一直没来 vs 整体跑太久。
    """


def _sweep_stale_codes() -> None:
    """删除早于 CODE_WAIT_TIMEOUT 的孤儿 /code 存码(及其 Event), 防止明文码无界堆积/长期驻留。"""
    now = time.time()
    for sess in [s for s, (_, ts) in CODE_VALUES.items() if now - ts > CODE_WAIT_TIMEOUT]:
        CODE_VALUES.pop(sess, None)
        CODE_EVENTS.pop(sess, None)


async def run_handler(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid JSON body"}, status=400)

    student_id = body.get("studentId")
    password = body.get("password")
    service = body.get("service")
    method = body.get("method", "mail")
    session = body.get("session") or "default"

    if not (student_id and password and service):
        return web.json_response(
            {"ok": False, "error": "missing required field: studentId/password/service"},
            status=400,
        )

    # 灰度: QG_PROXY_LOGIN/QG_ENABLED 决定 /run 走青果(登录包)还是节点直连。走青果时拿不到 IP
    # → 502 硬依赖回退(绝不悄悄 fallback 直连); 直连时 proxy=None, 由节点境内 IP 连 CQU。
    # 放在 Event 注册之前: 早退路径不注册 Event/Value, 无需 finally 清理。
    proxy = None
    if should_use_proxy("login"):
        try:
            proxy = await acquire_qg_proxy("login")
        except QgExtractError as e:
            log.warning("run abort session=%s qg extract failed: %s", session, e)
            return web.json_response(
                {"ok": False, "error": f"qg proxy unavailable: {e}"}, status=502
            )

    ev = asyncio.Event()
    CODE_EVENTS[session] = ev
    # I1: /code 可能在本 Event 注册前略早到达; 若码已在, 立即唤醒, 避免错过唤醒永久阻塞。
    if session in CODE_VALUES:
        ev.set()

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

    log.info("run start session=%s student=%s method=%s", session, student_id, method)
    try:
        result = await asyncio.wait_for(
            cqu_login.run_login(
                student_id=student_id,
                password=password,
                service=service,
                method=method,
                code_provider=code_waiter,
                proxy=proxy,
            ),
            timeout=RUN_TOTAL_TIMEOUT,
        )
        # ticket 是 bearer 凭据, 不入日志(session 不是凭据可留); 对齐 DO 审计「绝不记录 ticket/cookies/密码」。
        log.info("run ok session=%s", session)
        return web.json_response({"ok": True, **result})
    except CodeWaitTimeout:
        # 内层: 等码超时, 验证码始终没到(邮件未送达 / DO 未推码)。
        log.warning(
            "run timeout session=%s (code-wait >%ds, code never arrived)",
            session, CODE_WAIT_TIMEOUT,
        )
        return web.json_response(
            {"ok": False, "error": f"code wait timed out (>{CODE_WAIT_TIMEOUT}s, code never arrived)"},
            status=504,
        )
    except asyncio.TimeoutError:
        # 外层: 单次 /run 整体超时(第一因素/发码/提交某段太慢, 非单纯等码)。
        log.warning("run timeout session=%s (total >%ds)", session, RUN_TOTAL_TIMEOUT)
        return web.json_response(
            {"ok": False, "error": f"login timed out (>{RUN_TOTAL_TIMEOUT}s)"},
            status=504,
        )
    except Exception as e:  # noqa: BLE001 - surface any login failure to the caller
        log.warning("run fail session=%s error=%s", session, e)
        return web.json_response({"ok": False, "error": str(e)}, status=500)
    finally:
        CODE_EVENTS.pop(session, None)
        CODE_VALUES.pop(session, None)


async def code_handler(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid JSON body"}, status=400)

    session = body.get("session") or "default"
    code = body.get("code")
    if not code:
        return web.json_response({"ok": False, "error": "missing code"}, status=400)

    # I2: 顺手清掉过期孤儿码, 防止无人认领的明文码无界堆积/长期驻留。
    _sweep_stale_codes()
    CODE_VALUES[session] = (str(code), time.time())
    ev = CODE_EVENTS.get(session)
    if ev is not None:
        ev.set()
        log.info("code deposited session=%s (woke in-flight run)", session)
        return web.json_response({"ok": True})
    # 没有在途 /run: 仍存码(竞态: /code 先到), 但提示无等待者。
    log.info("code deposited session=%s (no in-flight run yet)", session)
    return web.json_response({"ok": True, "waiting": False})


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
        return web.json_response({"ok": False, "error": "invalid JSON body"}, status=400)

    service_url = body.get("serviceUrl")
    state = body.get("state")
    if not service_url or not isinstance(state, dict):
        return web.json_response(
            {"ok": False, "error": "missing required field: serviceUrl/state (object)"},
            status=400,
        )

    try:
        ticket = await cqu_ticket_browser.fetch_service_ticket_browser(service_url, state)
        # ST 是 bearer 凭据, 只记长度供诊断, 绝不打值。
        log.info("service-ticket ok (len=%d)", len(ticket))
        return web.json_response({"ok": True, "ticket": ticket})
    except cqu_ticket_browser.ExpiredError as e:
        # 落回 CAS 登录页 = 会话过期 → 409(客户端态, 交 DO 重登)。
        log.warning("service-ticket expired: %s", e)
        return web.json_response({"ok": False, "error": str(e)}, status=409)
    except Exception as e:  # noqa: BLE001 - NoTicketError/浏览器崩/超时 → 502 瞬态, 让上游退避
        log.warning("service-ticket transient: %s", e)
        return web.json_response({"ok": False, "error": str(e)}, status=502)


async def keepalive_handler(request: web.Request) -> web.Response:
    """POST /keepalive {state} → 临时浏览器水化探活, 返回三态 + 刷新后的 storage_state 给 DO。

    只返回探测事实(alive/expired/unreachable)+ 刷新 state;熔断/退避/重登的状态机在上游 DO。
    探不通绝不误判过期(归 unreachable, DO 退避)。三态恒以 200 返回。
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid JSON body"}, status=400)
    state = body.get("state")
    if not isinstance(state, dict):
        return web.json_response(
            {"ok": False, "error": "missing required field: state (object)"}, status=400)
    try:
        result = await cqu_keepalive.probe_session_browser(state)
    except Exception as e:  # noqa: BLE001 - 纵深兜底, 探活对 DO 永远只返回探测事实(200)
        log.warning("keepalive probe unexpected error (→ unreachable): %s", e)
        result = {"status": "unreachable", "state": state, "detail": f"{type(e).__name__}: {e}"}
    log.info("keepalive status=%s detail=%s", result["status"], (result.get("detail", "") or "")[:80])
    return web.json_response({"ok": True, **result})


async def health_handler(_request: web.Request) -> web.Response:
    return web.json_response({"ok": True})


def build_app() -> web.Application:
    app = web.Application()
    app.add_routes([
        web.post("/run", run_handler),
        web.post("/code", code_handler),
        web.post("/service-ticket", service_ticket_handler),
        web.post("/keepalive", keepalive_handler),
        # CF Containers 默认探测 /ping 判断实例就绪。
        web.get("/ping", health_handler),
        web.get("/health", health_handler),
    ])
    return app


if __name__ == "__main__":
    web.run_app(build_app(), host="0.0.0.0", port=8080)
