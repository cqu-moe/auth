"""使用共享 Chromium/CDP 恢复会话并取得未核销的 CAS ST。"""
import asyncio
import urllib.parse
import browser_profile
from chromium_session import ChromiumSession
import cqu_login

SSO = cqu_login.SSO
# CAS 服务器自身 host(规范化小写)。瑞数 JS + CAS /login 初始导航都落在它身上,
# 故 should_abort_request 对它一律放行(M2:即便 serviceUrl 的 host 恰为 sso 自身,
# 初始导航也不能被自 abort)。
SSO_HOST = (urllib.parse.urlparse(SSO).hostname or "").lower()
CAS_LOGIN_MARKERS = ("login-page-flowkey", "login-croypto")
# 取票并发上限(护 4G 节点;实测安全)。模块级单例,跨请求共享。
TICKET_SEMAPHORE = asyncio.Semaphore(3)
# 排队、执行、清理分别有界；CF profile 另由 server 的全进程重型任务锁限制并发。
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
    """Fetch 在请求发出前拦住目标服务，保留 CAS 自身的页面和资源请求。

    host 使用浏览器规范化口径；外部目标的允许范围仍由 server/DO 校验。
    """
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


async def _hydrate_navigate(service_url: str, state: dict, *, capture_state: bool = False,
                            overall_timeout: float | None = None) -> tuple[str, str, dict | None]:
    """Mint with the shared CDP runtime, stopping the callback before ST consumption."""
    if overall_timeout is None:
        overall_timeout = browser_profile.HYDRATE_OVERALL_TIMEOUT_S
    service_host = service_host_of(service_url)
    browser = ChromiumSession(seed_state=state)
    await asyncio.wait_for(TICKET_SEMAPHORE.acquire(), timeout=QUEUE_WAIT)
    try:
        async with asyncio.timeout(overall_timeout):
            await browser.__aenter__()
            await browser.intercept_requests(lambda url: should_abort_request(url, service_host))
            try:
                await browser.navigate(build_login_url(service_url), wait_until="commit",
                                       timeout_s=browser_profile.TICKET_NAV_TIMEOUT_MS / 1000)
            except (RuntimeError, TimeoutError):
                pass
            deadline = asyncio.get_running_loop().time() + TICKET_WAIT_MS / 1000
            while not cqu_login.extract_ticket(browser.tickets) and asyncio.get_running_loop().time() < deadline:
                await asyncio.sleep(TICKET_POLL_MS / 1000)
            ticket = cqu_login.extract_ticket(browser.tickets)
            body = "" if ticket else await browser.content()
            refreshed = await browser.storage_state() if capture_state else None
            return ticket, body, refreshed
    finally:
        TICKET_SEMAPHORE.release()
        await browser.close()


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
