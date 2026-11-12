"""CQU credential/verification flow on the shared Chromium/CDP runtime."""

import asyncio
import json
import random
import time
import urllib.parse

import browser_profile
import cqu_login
from chromium_session import (
    ChromiumSession, CdpSession, build_chrome_args, cookie_to_cdp,
    cookies_to_storage_state, _first_page_websocket,
)

async def interaction_jitter(*, uniform=random.uniform, sleep=asyncio.sleep) -> None:
    """Add a short human-scale pause immediately before a visible interaction."""
    await sleep(uniform(0.5, 1.0))


def parse_json_body(raw: bytes) -> dict | None:
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


async def _wait_login_ready(cdp: CdpSession, tickets=()) -> tuple[str | None, str | None]:
    deadline = time.monotonic() + max(
        browser_profile.LOGIN_COOKIE_WAIT_MS,
        browser_profile.LOGIN_FORM_WAIT_MS,
    ) / 1000
    while time.monotonic() < deadline:
        if cqu_login.extract_ticket(tickets):
            return None, None
        try:
            values = await cdp.evaluate(
                "({croypto:document.querySelector('#login-croypto')?.innerText?.trim()||'',"
                "execution:document.querySelector('#login-page-flowkey')?.innerText?.trim()||''})",
                timeout=5,
            )
            raw_cookies = await cdp.call(
                "Network.getCookies", {"urls": [cqu_login.SSO]}, timeout=5
            )
            cookies_ready = cqu_login._dynamic_cookie_pair_present(
                raw_cookies.get("cookies", [])
            )
            if cookies_ready and values["croypto"] and values["execution"]:
                return values["croypto"], values["execution"]
        except ConnectionError:
            raise RuntimeError("CONTAINER_UNAVAILABLE") from None
        except Exception:
            pass
        await asyncio.sleep(browser_profile.LOGIN_READY_POLL_MS / 1000)
    raise TimeoutError("CDP login form or dynamic cookie pair did not become ready")


async def _submit_form(cdp: CdpSession, fields: dict) -> None:
    encoded = json.dumps(fields)
    await cdp.evaluate(
        """(() => {
          const fields = %s;
          const form = document.createElement('form');
          form.action = 'login';
          form.method = 'POST';
          for (const [name, value] of Object.entries(fields)) {
            const input = document.createElement('input');
            input.type = 'hidden'; input.name = name; input.value = value;
            form.appendChild(input);
          }
          document.body.appendChild(form); form.submit(); return true;
        })()""" % encoded
    )


async def _wait_first_factor(cdp: CdpSession, tickets: list[str]) -> str:
    deadline = time.monotonic() + browser_profile.FORMNAV_TIMEOUT_MS / 1000
    last_poll_error = ""
    while time.monotonic() < deadline:
        if cqu_login.extract_ticket(tickets):
            return "success"
        try:
            state = await cdp.evaluate(
                "({url:location.href,text:document.body?.innerText||'',"
                "captcha:[...document.querySelectorAll('input')].some(e=>"
                "(e.placeholder||'').includes('校验码') && e.checkVisibility()),"
                "error:document.querySelector('#login-error-code')?.innerText?.trim()||''})",
                timeout=5,
            )
            tickets.append(state.get("url", ""))
            if state.get("captcha"):
                return "captcha"
            if "二次身份验证" in state.get("text", ""):
                return "2fa"
            error = state.get("error", "")
            if error:
                markers = ("用户名或密码", "密码错误", "账号已锁定", "帐号已锁定", "冻结")
                prefix = "credential_rejected" if any(item in error for item in markers) else "transient"
                return f"{prefix}:{error[:80]}"
        except ConnectionError:
            raise RuntimeError("CONTAINER_UNAVAILABLE") from None
        except Exception as poll_error:
            # A dead target raises ConnectionError above; keep any other fault so a
            # page that never becomes recognizable names its cause instead of timing
            # out blank.
            last_poll_error = f"{type(poll_error).__name__}: {poll_error}"
        await asyncio.sleep(0.1)
    if last_poll_error:
        return "transient:unrecognized_page " + json.dumps(
            {"lastPollError": last_poll_error}, ensure_ascii=False, separators=(",", ":")
        )
    return "transient:unrecognized_page"


async def _switch_mail_tab(browser: ChromiumSession) -> None:
    cdp = browser.cdp
    await asyncio.sleep(browser_profile.TWO_FACTOR_SETTLE_WAIT_MS / 1000)
    await interaction_jitter()
    await browser.click_text('.ant-tabs-tab', '邮件验证码',
                             timeout_s=browser_profile.TAB_CLICK_TIMEOUT_MS / 1000)
    await cdp.wait_js("document.body?.innerText.includes('已绑定密保邮箱')", 15)
    await asyncio.sleep(browser_profile.TWO_FACTOR_SETTLE_WAIT_MS / 1000)


async def _click_send_code(browser: ChromiumSession) -> None:
    await interaction_jitter()
    await browser.click_text('.font-class-text-button,button,span,a', '获取验证码',
                             timeout_s=browser_profile.TAB_CLICK_TIMEOUT_MS / 1000)


async def run_login(
    student_id,
    password,
    service,
    method="mail",
    code_provider=None,
    reusable_code_provider=None,
    permit_provider=None,
    proxy=None,
    seed_state=None,
):
    if method != "mail":
        raise ValueError("raw CDP login currently supports method='mail' only")
    if code_provider is None:
        raise ValueError("code_provider is required for run_login")

    async with ChromiumSession(seed_state=seed_state, proxy=proxy) as browser:
        cdp = browser.cdp
        tickets = browser.tickets
        send_response = {}
        send_event = asyncio.Event()

        def on_response(response) -> None:
            if cqu_login.METHOD[method]["send_marker"] in response.url:
                send_response.update(
                    status=response.status,
                    response=response,
                )
                send_event.set()

        browser.on_response(on_response)

        url = f"{cqu_login.SSO}/login?service={urllib.parse.quote(service, safe='')}"
        try:
            await browser.navigate(url, wait_until="commit", timeout_s=browser_profile.LOGIN_NAV_TIMEOUT_MS / 1000)
        except (RuntimeError, TimeoutError):
            if not cqu_login.extract_ticket(tickets):
                raise
        croypto, execution = await _wait_login_ready(cdp, tickets)
        if cqu_login.extract_ticket(tickets):
            return {"state": await browser.storage_state(),
                    "ticket": cqu_login.extract_ticket(tickets)}
        captcha_required = await cdp.evaluate(
            "!![...document.querySelectorAll('input')].find(e => "
            "(e.placeholder || '').includes('校验码') && e.checkVisibility())"
        )
        if captcha_required:
            raise RuntimeError("CAPTCHA_REQUIRED")
        await interaction_jitter()
        await _submit_form(
            cdp,
            {
                "type": "UsernamePassword",
                "_eventId": "submit",
                "geolocation": "",
                "execution": execution,
                "croypto": croypto,
                "username": student_id,
                "password": cqu_login.aes_encrypt_password(croypto, password),
            },
        )
        verdict = await _wait_first_factor(cdp, tickets)
        if verdict == "captcha":
            raise RuntimeError("CAPTCHA_REQUIRED")
        if verdict == "success":
            ticket = cqu_login.extract_ticket(tickets)
            return {"state": await browser.storage_state(), "ticket": ticket}
        if verdict != "2fa":
            raise RuntimeError(f"first-factor failed: {verdict}")

        await _switch_mail_tab(browser)
        if permit_provider is not None:
            await permit_provider()
        await _click_send_code(browser)
        try:
            async with asyncio.timeout(browser_profile.SEND_CODE_RESPONSE_TIMEOUT_MS / 1000):
                await send_event.wait()
                raw_body = (await send_response["response"].text()).encode("utf-8")
        except asyncio.TimeoutError as error:
            raise RuntimeError("发码响应超时(验证码状态未知)") from error
        body = parse_json_body(raw_body)
        send_verdict = cqu_login.classify_send_code(send_response["status"], body)
        if send_verdict == "failed":
            raise RuntimeError(
                f"发码失败 status={send_response['status']} bodyLength={len(raw_body)}(验证码未发出)"
            )

        provider = (
            reusable_code_provider
            if send_verdict == "already_valid" and reusable_code_provider is not None
            else code_provider
        )
        code = (await provider() or "").strip()
        if not code:
            raise RuntimeError("未取到验证码(code_provider 返回空)")
        execution = await cdp.evaluate(
            "document.querySelector('#login-page-flowkey')?.innerText?.trim()||''"
        )
        await interaction_jitter()
        await _submit_form(
            cdp,
            {
                "username": student_id,
                "password": code,
                "type": cqu_login.METHOD[method]["login_type"],
                "execution": execution,
                "_eventId": "submit",
                "geolocation": "",
                "captcha_code": "",
            },
        )
        deadline = time.monotonic() + browser_profile.FORMNAV_TIMEOUT_MS / 1000
        ticket = ""
        while time.monotonic() < deadline:
            ticket = cqu_login.extract_ticket(tickets)
            if ticket:
                break
            try:
                tickets.append(await cdp.evaluate("location.href", timeout=5) or "")
            except ConnectionError:
                raise RuntimeError("CONTAINER_UNAVAILABLE") from None
            except Exception:
                pass
            await asyncio.sleep(0.1)
        if not ticket:
            raise RuntimeError("未捕获 ST ticket(验证码可能错误/过期)")
        return {"state": await browser.storage_state(), "ticket": ticket}
