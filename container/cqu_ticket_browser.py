"""临时浏览器水化完整 storage_state 取票(替代 httpx,过瑞数 JS 挑战)。"""
import asyncio
import urllib.parse
from patchright.async_api import async_playwright
import cqu_login  # UA / SSO / install_ticket_sniffer / extract_ticket

SSO = cqu_login.SSO
CAS_LOGIN_MARKERS = ("login-page-flowkey", "login-croypto")
# 取票并发上限(护 4G 节点;实测安全)。模块级单例,跨请求共享。
TICKET_SEMAPHORE = asyncio.Semaphore(3)


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


async def fetch_service_ticket_browser(service_url: str, state: dict) -> str:
    """水化完整 storage_state 起临时浏览器 navigate 换 ST。
    成功返回 ST;落 CAS 登录页抛 ExpiredError;否则抛 NoTicketError。"""
    url = build_login_url(service_url)
    async with TICKET_SEMAPHORE:
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True, args=[
                "--headless=new", "--disable-blink-features=AutomationControlled",
                "--no-sandbox", "--disable-dev-shm-usage"], timeout=30000)
            try:
                ctx = await browser.new_context(
                    storage_state=state, user_agent=cqu_login.UA,
                    viewport={"width": 1440, "height": 900},
                    locale="zh-CN", timezone_id="Asia/Shanghai")
                page = await ctx.new_page()
                tickets = []
                cqu_login.install_ticket_sniffer(page, tickets)
                try:
                    await page.goto(url, wait_until="domcontentloaded", timeout=25000)
                    await page.wait_for_timeout(3500)
                except Exception:
                    pass
                ticket = cqu_login.extract_ticket(tickets + [page.url])
                body = ""
                if not ticket:
                    try:
                        body = await page.content()
                    except Exception:
                        body = ""
            finally:
                await browser.close()
    verdict, tk = classify_browser_result(ticket, body)
    if verdict == "ok":
        return tk
    if verdict == "expired":
        raise ExpiredError("fell back to CAS login page")
    raise NoTicketError("no ST, non-login page")
