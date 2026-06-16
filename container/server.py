#!/usr/bin/env python3
"""
CQU 浏览器登录器 —— aiohttp 服务(CF Containers, 端口 8080)。

两条路由共存于同一进程, 让 /code 能唤醒在途的 /run:
  POST /run  {studentId, password, service, method, session}
      → 起一个按 session 键控的 asyncio.Event, 调 cqu_login.run_login(...),
        其 code_provider 阻塞等该 Event; 成功 200 {ok:true, cookies, ticket},
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
import cqu_keepalive  # 国内节点探活(经青果探测 CQU 会话), 暴露 probe_session(...)
import cqu_ticket  # 国内节点取 ST(经青果换票), 暴露 fetch_service_ticket(...)
from cqu_ticket import TicketError  # 取 ST 失败语义(SESSION_EXPIRED / NO_TICKET 等)
from qg_proxy import acquire_qg_proxy, QgExtractError  # 青果短效代理(连 CQU 出站硬依赖)

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

    # 铁律: 所有连 CQU 出站经青果。拿不到青果 IP 即判失败(硬依赖回退), 返回 502 让上游退避——
    # 绝不无代理裸连 CQU。放在 Event 注册之前: 502 早退路径不注册 Event/Value, 无需 finally 清理。
    try:
        proxy = await acquire_qg_proxy()
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
        log.info("run ok session=%s ticket=%s", session, result.get("ticket", "")[:24])
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
    """POST /service-ticket {serviceUrl, cookies} → 经青果去 CQU 换一张 ST。

    职责: 只负责「换票」这一跳。取票的安全闸(serviceUrl host 校验 / quicklogin
    opt-in / 限流 / 审计)仍在上游 DO, 这里拿到的 serviceUrl 已被 DO 校验过。

    · 铁律: 连 CQU 出站必经青果。acquire_qg_proxy() 失败 → 502(硬依赖回退, 同 /run),
      绝不无代理裸连 CQU。
    · 成功: 200 {ok:true, ticket}。
    · 会话过期(落回 CAS 登录页): 409 {ok:false, error} —— 语义是「该 cookie 的 CAS
      会话已失效」, 客户端错误而非服务端故障, 交上游 DO/容器重登; 用 409 Conflict
      让 DO 能据状态码与「瞬态封锁」区分(后者走 502 退避重试)。
    · 未取到票(疑似瑞数误判/未知页)/ 缺 cookie: 502 {ok:false, error}, 让上游退避重试。
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid JSON body"}, status=400)

    service_url = body.get("serviceUrl")
    cookies = body.get("cookies")
    if not service_url or not isinstance(cookies, dict):
        return web.json_response(
            {"ok": False, "error": "missing required field: serviceUrl/cookies"},
            status=400,
        )

    # 硬依赖: 拿不到青果即判失败, 502 让上游退避 —— 绝不无代理裸连 CQU。
    try:
        proxy = await acquire_qg_proxy()
    except QgExtractError as e:
        log.warning("service-ticket abort qg extract failed: %s", e)
        return web.json_response(
            {"ok": False, "error": f"qg proxy unavailable: {e}"}, status=502
        )

    try:
        ticket = await cqu_ticket.fetch_service_ticket(service_url, cookies, proxy)
        log.info("service-ticket ok ticket=%s", ticket[:24])
        return web.json_response({"ok": True, "ticket": ticket})
    except TicketError as e:
        # 会话过期 → 409(客户端态: cookie 失效, 交重登); 其余取票失败 → 502(瞬态, 退避重试)。
        status = 409 if e.code == "SESSION_EXPIRED" else 502
        log.warning("service-ticket fail code=%s status=%d error=%s", e.code, status, e)
        return web.json_response({"ok": False, "error": str(e)}, status=status)
    except Exception as e:  # noqa: BLE001 - 网络层/未预期错误也按瞬态上抛, 让上游退避
        log.warning("service-ticket error %s", e)
        return web.json_response({"ok": False, "error": str(e)}, status=502)


async def keepalive_handler(request: web.Request) -> web.Response:
    """POST /keepalive {cookies} → 经青果探测 CQU 会话是否还活, 返回三态事实给 DO。

    职责: 只返回「探测事实」(alive/expired/unreachable), 不做决策。熔断/退避/重登的
    状态机全留在上游 DO(runKeepAlive/alarm), 本端点只如实回报探测结果。

    · 铁律: 探活也是「连 CQU」, 必经青果。但青果失败的语义与 /run、/service-ticket 不同 ——
      探活拿不到青果 = 「探不通」(并不证明会话过期), 故归 **unreachable** 而非 5xx:
      返回 200 {ok:true, status:"unreachable"}, 让 DO 按瞬态退避(快重试/指数退避),
      绝不让 DO 误判会话过期而触发容器重登(误判重登会触瑞数风控 + 烧容器, 代价远高)。
    · 探测结果三态恒以 200 {ok:true, status, detail} 返回 —— DO 凭 status 区分:
      "expired"(该重登) vs "unreachable"(该退避) vs "alive"(健康)。
    · 缺 cookies / cookies 非 dict → 400(契约破坏, 真客户端错误)。
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid JSON body"}, status=400)

    cookies = body.get("cookies")
    if not isinstance(cookies, dict):
        return web.json_response(
            {"ok": False, "error": "missing required field: cookies (object)"},
            status=400,
        )

    # 探活拿不到青果 = 探不通 → unreachable(让 DO 退避), 绝不 5xx、绝不当会话过期。
    # 这是 keepalive 与 /run、/service-ticket(青果失败 → 5xx)的关键语义差异。
    try:
        proxy = await acquire_qg_proxy()
    except QgExtractError as e:
        log.warning("keepalive qg extract failed (→ unreachable): %s", e)
        return web.json_response(
            {"ok": True, "status": "unreachable", "detail": f"qg proxy unavailable: {e}"}
        )

    # probe_session 内部已把网络层/未知异常收口成 unreachable; 此处再兜底一层,
    # 确保探活端点对 DO 永远只返回「探测事实」(200), 绝不 500 伪装成服务端崩溃。
    try:
        result = await cqu_keepalive.probe_session(cookies, proxy)
    except Exception as e:  # noqa: BLE001 - 纵深兜底: 任何未预期错误也归 unreachable
        log.warning("keepalive probe unexpected error (→ unreachable): %s", e)
        result = {"status": "unreachable", "detail": f"{type(e).__name__}: {e}"}

    log.info("keepalive status=%s detail=%s", result["status"], result.get("detail", "")[:80])
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
