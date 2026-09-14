"""临时浏览器水化完整 storage_state 取票(替代 httpx,过瑞数 JS 挑战)。"""
import asyncio
import urllib.parse
import browser_profile
from patchright.async_api import async_playwright
import cqu_login  # UA / SSO / install_ticket_sniffer / extract_ticket

SSO = cqu_login.SSO
# CAS 服务器自身 host(规范化小写)。瑞数 JS + CAS /login 初始导航都落在它身上,
# 故 should_abort_request 对它一律放行(M2:即便 serviceUrl 的 host 恰为 sso 自身,
# 初始导航也不能被自 abort)。
SSO_HOST = (urllib.parse.urlparse(SSO).hostname or "").lower()
CAS_LOGIN_MARKERS = ("login-page-flowkey", "login-croypto")
# 取票并发上限(护 4G 节点;实测安全)。模块级单例,跨请求共享。
TICKET_SEMAPHORE = asyncio.Semaphore(3)
# 排队等槽的总上限(秒):TICKET_SEMAPHORE 被取票+探活共用,单次持槽上限 = overall_timeout(45s)。
# 瞬时高并发时第 4 个起会在 acquire 上排队;给等槽也加超时上限,排不到就快失败(→ 502,让 DO 退避),
# 长尾快失败优于无界长挂。单请求最坏总时长 ≈ QUEUE_WAIT(排队 35s)+ overall_timeout(持槽 45s)≈ 80s,
# 故 DO 侧 LOGIN_NODE.fetch 的超时须 ≥ ~80s,否则会在节点返回 409/502 前中途 abort(契约须与 DO 对齐)。
QUEUE_WAIT = 35.0
# 主动等票上限(毫秒):goto 后轮询 tickets 列表,拿到票立即返回(消除 happy path 盲等);
# 瑞数遇 cookie 过期会当场重算 + 重定向(实测在 3500ms 下取得 ST),故上限给足。
TICKET_WAIT_MS = 4500
TICKET_POLL_MS = 150


class ExpiredError(Exception):
    pass


class NoTicketError(Exception):
    pass


def build_login_url(service_url: str) -> str:
    return f"{SSO}/login?service={urllib.parse.quote(service_url, safe='')}"


def classify_browser_result(ticket: str, body: str) -> tuple[str, str]:
    """("ok", ST) / ("expired", "") / ("no_ticket", "")。纯函数,便于单测。"""
    if ticket:
        return ("ok", ticket)
    if any(mk in (body or "") for mk in CAS_LOGIN_MARKERS):
        return ("expired", "")
    return ("no_ticket", "")


def service_host_of(service_url: str) -> tuple[str, int | None]:
    """解析目标服务的**规范化** host 键 (host_lower, port)。

    返回元组与浏览器对请求 URL 的规范化口径对齐,使 should_abort_request 比对不漏:
      · host 一律转小写(浏览器把请求 URL host 规范化为小写)。
      · https 默认端口 443 与"省略端口"等价 —— 都归一为 None(否则 :443 ≠ 无端口会漏 abort)。
      · 非默认端口原样保留(如 :8443)。
    解析不出 host(空串 / 无 scheme 的垃圾)返回 ("", None)(空 host → 后续退化为全不拦)。
    纯函数,便于单测。"""
    try:
        u = urllib.parse.urlparse(service_url)
        host = (u.hostname or "").lower()
        try:
            port = u.port
        except ValueError:  # 非法端口 → 当作无端口(host 仍可比对)
            port = None
        if u.scheme == "https" and port == 443:
            port = None  # 默认端口归一,与"无端口"等价
        return host, port
    except Exception:
        return "", None


def should_abort_request(request_url: str, service_host: tuple[str, int | None]) -> bool:
    """该请求是否要 abort:仅当请求落向目标服务 host 时拦(等价旧 httpx follow_redirects=False,
    尽力避免浏览器把一次性 ST 送达目标服务核销 → 取票失败)。

    注:这只是功能正确性纵深,非 ST-relay 安全闸 —— 顶层导航重定向 patchright 不保证拦得住
    (待真节点 e2e 锁定);ST 事实源是 sniffer 从 CAS 302 Location 抓取,不依赖 abort。
    用 service_host_of 的**规范化元组**比对 → 浏览器把请求 URL 小写化、省略默认 443 后仍判一致
    (M1:大写 / 显式 :443 / 无端口三变体口径单一,不漏 abort)。按 host 判定 → 无论直接跳还是
    中间多跳,只要落向目标服务就拦,比"含 ticket= 子串"更稳健。

    例外(M2):请求 host == CAS 自身(sso.cqu.edu.cn)时**绝不 abort** —— 瑞数 JS + CAS /login
    初始导航都落在 sso 上,即便 serviceUrl 的 host 恰为 sso 自身,初始导航也不能被自 abort
    (否则吞异常返回 no_ticket)。service_host 为空(host 解析失败)时退化为全不拦。纯函数。"""
    host, _ = service_host
    if not host:
        return False
    req = service_host_of(request_url)
    if req[0] == SSO_HOST:  # M2:CAS 自身永不拦(放行瑞数 + /login 初始导航)
        return False
    return req == service_host


def collect_ticket_url(request_url: str, tickets: list[str]) -> None:
    """带 ticket=ST- 的 URL 收进 tickets(供 extract_ticket 抽 ST)。纯函数,便于单测。"""
    if "ticket=ST-" in (request_url or ""):
        tickets.append(request_url)


async def _wait_for_ticket(page, tickets: list[str]) -> None:
    """goto 后主动等票:轮询 route/sniffer 双路填的 tickets + 当前 page.url,任一现票即返回
    (消除 happy path 盲等);至多等 TICKET_WAIT_MS,给瑞数遇 cookie 过期当场重算 + 重定向留足上限。
    不靠 page.wait_for_url("**ticket=ST-*"):带 ticket= 的回调若被 _route abort 则不会成为 page.url
    (abort 尽力但不保证拦顶层导航),ST 事实源是 sniffer 从 302 Location 抓取并落 tickets 列表,
    故轮询该列表才稳——无论 abort 是否拦住,sniffer 都已收到票。"""
    waited = 0
    while waited < TICKET_WAIT_MS:
        if cqu_login.extract_ticket(tickets + [page.url]):
            return
        await page.wait_for_timeout(TICKET_POLL_MS)
        waited += TICKET_POLL_MS


async def _close_browser_driver(browser, pw) -> None:
    """限时关浏览器 + 停驱动(best-effort,各自独立兜底)。

    刻意放在持槽窗口**之外**(见 _hydrate_navigate):一旦外层 overall_timeout 到点,
    _run 被取消、其内部已无 close/stop 步骤,槽即刻释放;cleanup 在 release 之后单独跑,
    故 wedged 的 close(≤10s)/stop(≤5s)不再加性叠在持槽时长上(持槽回到 ≤ overall_timeout)。
    close/stop 各包 wait_for 硬上限,wedged 句柄也不会无界 await。"""
    if browser is not None:
        try:
            await asyncio.wait_for(browser.close(), timeout=10)
        except Exception:
            pass
    if pw is not None:
        try:
            await asyncio.wait_for(pw.stop(), timeout=5)
        except Exception:
            pass


async def _hydrate_navigate(service_url: str, state: dict, *, capture_state: bool = False,
                            overall_timeout: float | None = None) -> tuple[str, str, dict | None]:
    """水化完整 storage_state 起临时浏览器 navigate /login?service=X。

    ST 事实源是 sniffer 从 CAS 302 的 `Location` 头抓取(install_ticket_sniffer)+ route 收集带
    ticket= 的请求 URL;abort 不是取票 load-bearing 路径。abort 仅**尽力**拦页面后续向目标服务
    发起的请求(等价旧 httpx 的 follow_redirects=False,避免把一次性 ST 送达目标服务核销 → 取票失败);
    顶层导航的重定向 patchright 不保证拦得住(待真节点 e2e 锁定),故只当功能正确性纵深、非安全闸
    (真正的 ST-relay 红线是上游 + 节点 is_allowed_service_url 的 *.cqu.edu.cn 白名单)。

    持槽时长 = overall_timeout 一项(close/stop cleanup 已移出持槽窗口,见 _close_browser_driver):
      · 等槽(QUEUE_WAIT)与整段执行(overall_timeout)各包超时,防排队无界长挂 / wedged 永占槽。
      · 单请求最坏总时长 ≈ QUEUE_WAIT(排队)+ overall_timeout(持槽)+ cleanup(≤15s,release 后,
        不占槽);DO 侧 fetch 超时须覆盖该量级。

    取票(/service-ticket)与探活(/keepalive)共用此 helper —— 统一瑞数对抗参数、消除重复。
    capture_state=True 时额外导出刷新后的 storage_state(keepalive 保鲜用)。
    返回 (ticket, body, refreshed_state|None)。排队等槽超时(QUEUE_WAIT)直接抛(→ 502)。
    """
    url = build_login_url(service_url)
    service_host = service_host_of(service_url)
    if overall_timeout is None:
        overall_timeout = browser_profile.HYDRATE_OVERALL_TIMEOUT_S
    # 句柄提到外层:_run 被外层 overall_timeout 取消时,仍能在 release 后于 finally 里清理
    # (M3:start() 握手期被取消、pw 仍 None 时,_close_browser_driver 对 None 也安全跳过)。
    handles: dict = {"pw": None, "browser": None}

    async def _run() -> tuple[str, str, dict | None]:
        # 显式 start/stop 驱动(不用 `async with async_playwright()`):__aexit__ 的 stop_async()
        # 无超时,wedged 驱动会一直 await,而此时仍占着 TICKET_SEMAPHORE 槽 → 逐步耗尽。
        # M3:start() 在驱动握手期被取消时,取消可能落在 pw 赋值前,故先记句柄再用;cleanup 在
        # release 后的 finally 兜底(对 pw=None 安全跳过),不靠 _run 内部 finally,避免 cleanup 占槽。
        pw = await async_playwright().start()
        handles["pw"] = pw
        browser = await pw.chromium.launch(headless=True, args=[
            "--headless=new", "--disable-blink-features=AutomationControlled",
            "--no-sandbox", "--disable-dev-shm-usage"], timeout=browser_profile.TICKET_LAUNCH_TIMEOUT_MS)
        handles["browser"] = browser
        ctx = await browser.new_context(
            storage_state=state,
            viewport={"width": 1440, "height": 900},
            locale="zh-CN", timezone_id="Asia/Shanghai")
        tickets: list[str] = []

        async def _route(route):
            # 收票 + 按目标服务 host abort(纯函数判定,handler 只是薄壳):
            # 落向目标服务 host 的请求尽力拦,避免把一次性 ST 送达核销;其余放行,
            # 保留 **/* 全量 continue_ 让瑞数 JS 完整加载(实测 R1/R2 可用)。
            u = route.request.url
            collect_ticket_url(u, tickets)
            try:
                if should_abort_request(u, service_host):
                    await route.abort()
                else:
                    await route.continue_()
            except Exception:
                pass

        await ctx.route("**/*", _route)
        page = await ctx.new_page()
        await cqu_login.apply_browser_identity(ctx, page, browser.version)
        cqu_login.install_ticket_sniffer(page, tickets)  # 事实源:从 CAS 302 Location 抓 ST
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=browser_profile.TICKET_NAV_TIMEOUT_MS)
            await _wait_for_ticket(page, tickets)
        except Exception:
            pass
        ticket = cqu_login.extract_ticket(tickets + [page.url])
        body = ""
        if not ticket:
            try:
                body = await page.content()
            except Exception:
                body = ""
        refreshed = await ctx.storage_state() if capture_state else None
        return ticket, body, refreshed

    # 等槽也纳入超时:排队超过 QUEUE_WAIT 直接快失败(→ 502 让 DO 退避),不无界长挂。
    await asyncio.wait_for(TICKET_SEMAPHORE.acquire(), timeout=QUEUE_WAIT)
    try:
        return await asyncio.wait_for(_run(), timeout=overall_timeout)
    finally:
        # 先释放槽,再清理浏览器/驱动:cleanup(close/stop)不再算进持槽时长,持槽 ≤ overall_timeout。
        # cleanup 自身各包 wait_for 硬上限,不会无界 await;对 None 句柄(start 期被取消)安全跳过。
        TICKET_SEMAPHORE.release()
        await _close_browser_driver(handles["browser"], handles["pw"])


async def fetch_service_ticket_browser(service_url: str, state: dict) -> str:
    """水化完整 storage_state 起临时浏览器换 ST(不消费单次 ST,见 _hydrate_navigate)。
    成功返回 ST;落 CAS 登录页抛 ExpiredError;否则抛 NoTicketError。"""
    ticket, body, _ = await _hydrate_navigate(service_url, state, capture_state=False)
    verdict, tk = classify_browser_result(ticket, body)
    if verdict == "ok":
        return tk
    if verdict == "expired":
        raise ExpiredError("fell back to CAS login page")
    raise NoTicketError("no ST, non-login page")
