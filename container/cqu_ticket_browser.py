"""临时浏览器水化完整 storage_state 取票(替代 httpx,过瑞数 JS 挑战)。"""
import asyncio
import urllib.parse
from patchright.async_api import async_playwright
import cqu_login  # UA / SSO / install_ticket_sniffer / extract_ticket

SSO = cqu_login.SSO
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


def service_host_of(service_url: str) -> str:
    """解析目标服务 host(netloc,含端口)。解析不出返回 ""。纯函数,便于单测。"""
    try:
        return urllib.parse.urlparse(service_url).netloc
    except Exception:
        return ""


def should_abort_request(request_url: str, service_host: str) -> bool:
    """该请求是否要 abort:仅当请求 host == 目标服务 host 时拦(等价旧 httpx follow_redirects=False,
    绝不让浏览器把一次性 ST 送达目标服务核销)。按 host 判定 → 无论直接跳还是中间多跳,只要落向
    目标服务就拦,比"含 ticket= 子串"更稳健。service_host 为空时退化为全不拦。纯函数,便于单测。"""
    if not service_host:
        return False
    return service_host_of(request_url) == service_host


def collect_ticket_url(request_url: str, tickets: list[str]) -> None:
    """带 ticket=ST- 的 URL 收进 tickets(供 extract_ticket 抽 ST)。纯函数,便于单测。"""
    if "ticket=ST-" in (request_url or ""):
        tickets.append(request_url)


async def _wait_for_ticket(page, tickets: list[str]) -> None:
    """goto 后主动等票:轮询 route/sniffer 双路填的 tickets + 当前 page.url,任一现票即返回
    (消除 happy path 盲等);至多等 TICKET_WAIT_MS,给瑞数遇 cookie 过期当场重算 + 重定向留足上限。
    不用 page.wait_for_url("**ticket=ST-*"):带 ticket= 的回调请求落向目标服务 host 被 _route abort,
    永远不会成为 page.url,ST 主要落在 route/sniffer 收集的 tickets 列表里,故轮询该列表才抓得到。"""
    waited = 0
    while waited < TICKET_WAIT_MS:
        if cqu_login.extract_ticket(tickets + [page.url]):
            return
        await page.wait_for_timeout(TICKET_POLL_MS)
        waited += TICKET_POLL_MS


async def _hydrate_navigate(service_url: str, state: dict, *, capture_state: bool = False,
                            overall_timeout: float = 45.0) -> tuple[str, str, dict | None]:
    """水化完整 storage_state 起临时浏览器 navigate /login?service=X,**拦截落向目标服务 host 的
    请求并 abort**(绝不把单次 ST 送达目标服务消费,等价旧 httpx 的 follow_redirects=False),从
    被拦 URL + 302 Location 收 ST,goto 后主动等票(拿到即返回)。等槽 / 整段 / 关浏览器 / 停驱动
    四处都包超时兜底,防 wedged 浏览器永占 TICKET_SEMAPHORE 槽或排队无界长挂。

    取票(/service-ticket)与探活(/keepalive)共用此 helper —— 统一瑞数对抗参数、消除重复。
    capture_state=True 时额外导出刷新后的 storage_state(keepalive 保鲜用)。
    返回 (ticket, body, refreshed_state|None)。排队等槽超时(QUEUE_WAIT)直接抛(→ 502)。
    """
    url = build_login_url(service_url)
    service_host = service_host_of(service_url)

    async def _run() -> tuple[str, str, dict | None]:
        # 显式 start/stop 驱动(不用 `async with async_playwright()`):__aexit__ 的 stop_async()
        # 无超时,wedged 驱动会一直 await,而此时仍占着 TICKET_SEMAPHORE 槽 → 逐步耗尽。
        pw = await async_playwright().start()
        try:
            browser = await pw.chromium.launch(headless=True, args=[
                "--headless=new", "--disable-blink-features=AutomationControlled",
                "--no-sandbox", "--disable-dev-shm-usage"], timeout=30000)
            try:
                ctx = await browser.new_context(
                    storage_state=state, user_agent=cqu_login.UA,
                    viewport={"width": 1440, "height": 900},
                    locale="zh-CN", timezone_id="Asia/Shanghai")
                tickets: list[str] = []

                async def _route(route):
                    # 收票 + 按目标服务 host abort(纯函数判定,handler 只是薄壳):
                    # 落向目标服务 host 的请求一律拦,绝不把一次性 ST 送达核销;其余放行,
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
                cqu_login.install_ticket_sniffer(page, tickets)  # 双保险:也从 302 Location 抓 ST
                try:
                    await page.goto(url, wait_until="domcontentloaded", timeout=25000)
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
            finally:
                # 限时关浏览器:wedged 的 close 不再拖死取消/占槽。
                # 注:close(10s)/stop(5s) 的硬上限只在非超时路径成立;一旦外层 overall_timeout 到点,
                # 这两个 finally 在已被取消的上下文里执行、预算被外层超时吞并(勿再按 45+10+5 估算总时长)。
                try:
                    await asyncio.wait_for(browser.close(), timeout=10)
                except Exception:
                    pass
        finally:
            # 限时停驱动:wedged 的 stop IPC 不再无界 await 占槽。
            try:
                await asyncio.wait_for(pw.stop(), timeout=5)
            except Exception:
                pass

    # 等槽也纳入超时:排队超过 QUEUE_WAIT 直接快失败(→ 502 让 DO 退避),不无界长挂。
    await asyncio.wait_for(TICKET_SEMAPHORE.acquire(), timeout=QUEUE_WAIT)
    try:
        return await asyncio.wait_for(_run(), timeout=overall_timeout)
    finally:
        TICKET_SEMAPHORE.release()


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
