"""Isolated aTrust browser login for personal timetable harvest.

The entry, rewritten SSO host, and final application host are code-owned
constants. The flow exports only a browser storage state: the Service Ticket
is consumed by the aTrust passport and is never returned to callers.
"""

import urllib.parse

from patchright.async_api import async_playwright

import cqu_login


ATRUST_APP_URL = (
    "https://my-cqu-edu-cn-s.atrust.cqu.edu.cn/workspace/curriculum"
)
ATRUST_PORTAL_HOST = "atrust.cqu.edu.cn"
ATRUST_SSO_HOST = "sso-cqu-edu-cn-s.atrust.cqu.edu.cn"
ATRUST_APP_HOST = "my-cqu-edu-cn-s.atrust.cqu.edu.cn"


class AtrustPasswordRejectedError(RuntimeError):
    """The rewritten CAS page explicitly rejected the stored credentials."""


def _safe_host(url: str) -> str:
    if not isinstance(url, str) or "\\" in url:
        return ""
    if any(ord(ch) < 0x20 or ord(ch) > 0x7E for ch in url):
        return ""
    try:
        parsed = urllib.parse.urlparse(url)
    except Exception:
        return ""
    if parsed.scheme != "https" or parsed.username or parsed.password:
        return ""
    try:
        if parsed.port not in (None, 443):
            return ""
    except ValueError:
        return ""
    return (parsed.hostname or "").lower()


def is_rewritten_sso_url(url: str) -> bool:
    return _safe_host(url) == ATRUST_SSO_HOST


def is_atrust_login_done(url: str) -> bool:
    return _safe_host(url) == ATRUST_APP_HOST


def classify_first_factor_failure(verdict: str) -> str:
    text = str(verdict or "").lower()
    if any(marker in text for marker in ("用户名或密码", "密码错误", "password")):
        return "password_rejected"
    return "transient"


async def click_unified_identity(page) -> None:
    """Open the fixed entry and select the exact visible CAS option."""
    await page.goto(ATRUST_APP_URL, wait_until="domcontentloaded", timeout=40_000)
    for _ in range(40):
        candidates = page.locator("li.server-container .server-name")
        for index in range(await candidates.count()):
            candidate = candidates.nth(index)
            if (await candidate.inner_text()).strip() == "统一身份认证":
                await candidate.click(timeout=5_000)
                return
        exact = page.get_by_text("统一身份认证", exact=True)
        if await exact.count():
            await exact.first.click(timeout=5_000)
            return
        await page.wait_for_timeout(500)
    raise RuntimeError("ATRUST_PORTAL_OPTION_MISSING")


async def wait_for_rewritten_sso(page) -> None:
    for _ in range(40):
        if is_rewritten_sso_url(page.url) and await page.locator(
            "#login-croypto"
        ).count():
            return
        await page.wait_for_timeout(500)
    raise RuntimeError("ATRUST_SSO_NOT_READY")


async def wait_for_atrust_app(page) -> None:
    for _ in range(60):
        if is_atrust_login_done(page.url):
            return
        await page.wait_for_timeout(500)
    raise RuntimeError("ATRUST_APP_NOT_REACHED")


async def run_atrust_login(
    student_id,
    password,
    method="mail",
    code_provider=None,
    permit_provider=None,
    proxy=None,
):
    """Log into the fixed aTrust-published CQU app and return only storage state."""
    if method not in cqu_login.METHOD:
        raise ValueError(f"unsupported method: {method!r} (expected 'sms' or 'mail')")
    if code_provider is None:
        raise ValueError("code_provider is required for run_atrust_login")
    if permit_provider is None:
        raise ValueError("permit_provider is required for run_atrust_login")

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(
            headless=True,
            args=[
                "--headless=new",
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-dev-shm-usage",
            ],
            proxy=proxy,
            timeout=30_000,
        )
        context = await browser.new_context(
            user_agent=cqu_login.UA,
            viewport={"width": 1440, "height": 900},
            locale="zh-CN",
            timezone_id="Asia/Shanghai",
        )
        page = await context.new_page()
        page.set_default_timeout(15_000)
        send_state = {"status": None, "body": None}
        cqu_login.install_send_code_sniffer(page, send_state, method)

        try:
            await click_unified_identity(page)
            await wait_for_rewritten_sso(page)
            login_url = page.url
            verdict = await cqu_login.do_first_factor(
                page,
                login_url,
                student_id,
                password,
                debug_screenshot=False,
            )
            if verdict == "2fa":
                await cqu_login.switch_2fa_tab(page, method)
                await permit_provider()
                if not await cqu_login.request_code(page, send_state):
                    raise RuntimeError("ATRUST_CODE_BUTTON_MISSING")
                send_verdict = cqu_login.classify_send_code(
                    send_state["status"], send_state["body"]
                )
                if send_verdict == "failed":
                    raise RuntimeError("ATRUST_CODE_REQUEST_FAILED")
                code = (await code_provider() or "").strip()
                if not code:
                    raise RuntimeError("ATRUST_CODE_MISSING")
                await cqu_login.submit_code(
                    page, login_url, student_id, code, method
                )
            elif verdict != "success":
                if classify_first_factor_failure(verdict) == "password_rejected":
                    raise AtrustPasswordRejectedError("PASSWORD_REJECTED")
                raise RuntimeError("ATRUST_FIRST_FACTOR_FAILED")

            await wait_for_atrust_app(page)
            state = await context.storage_state()
            return {"state": state}
        finally:
            await browser.close()
