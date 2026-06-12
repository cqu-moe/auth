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

from aiohttp import web

import cqu_login  # 改造后的登录器, 暴露 run_login(...)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("cqu-login-server")

# session -> Event(被 /code set 唤醒) / session -> 验证码字符串。
CODE_EVENTS: dict[str, asyncio.Event] = {}
CODE_VALUES: dict[str, str] = {}


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

    ev = asyncio.Event()
    CODE_EVENTS[session] = ev

    async def code_waiter() -> str:
        # run_login 在发码后 await 它: 阻塞到 /code 推入并 set Event。
        await ev.wait()
        return CODE_VALUES.pop(session, "")

    log.info("run start session=%s student=%s method=%s", session, student_id, method)
    try:
        result = await cqu_login.run_login(
            student_id=student_id,
            password=password,
            service=service,
            method=method,
            code_provider=code_waiter,
        )
        log.info("run ok session=%s ticket=%s", session, result.get("ticket", "")[:24])
        return web.json_response({"ok": True, **result})
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

    CODE_VALUES[session] = str(code)
    ev = CODE_EVENTS.get(session)
    if ev is not None:
        ev.set()
        log.info("code deposited session=%s (woke in-flight run)", session)
        return web.json_response({"ok": True})
    # 没有在途 /run: 仍存码(竞态: /code 先到), 但提示无等待者。
    log.info("code deposited session=%s (no in-flight run yet)", session)
    return web.json_response({"ok": True, "waiting": False})


async def health_handler(_request: web.Request) -> web.Response:
    return web.json_response({"ok": True})


def build_app() -> web.Application:
    app = web.Application()
    app.add_routes([
        web.post("/run", run_handler),
        web.post("/code", code_handler),
        # CF Containers 默认探测 /ping 判断实例就绪。
        web.get("/ping", health_handler),
        web.get("/health", health_handler),
    ])
    return app


if __name__ == "__main__":
    web.run_app(build_app(), host="0.0.0.0", port=8080)
