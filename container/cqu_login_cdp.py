"""CQU login through raw Chrome DevTools Protocol, without Patchright injection."""

from __future__ import annotations

import asyncio
import glob
import json
import os
import random
import shutil
import socket
import tempfile
import time
import urllib.parse
from collections.abc import Callable

import aiohttp

import browser_profile
import cqu_login as legacy


async def interaction_jitter(*, uniform=random.uniform, sleep=asyncio.sleep) -> None:
    """Add a short human-scale pause immediately before a visible interaction."""
    await sleep(uniform(0.5, 1.0))


def build_chrome_args(
    executable: str, profile_dir: str, debug_port: int, proxy=None
) -> list[str]:
    args = [
        executable,
        "--headless=new",
        f"--remote-debugging-port={debug_port}",
        f"--user-data-dir={profile_dir}",
        "--no-first-run",
        "--no-default-browser-check",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "about:blank",
    ]
    if proxy and proxy.get("server"):
        args.insert(-1, f"--proxy-server={proxy['server']}")
    return args


def cookie_to_cdp(cookie: dict) -> dict:
    allowed = ("name", "value", "domain", "path", "httpOnly", "secure", "sameSite")
    result = {key: cookie[key] for key in allowed if key in cookie}
    expires = cookie.get("expires")
    if isinstance(expires, (int, float)) and expires > 0:
        result["expires"] = expires
    return result


def cookies_to_storage_state(cookies: list[dict], origins: list[dict]) -> dict:
    exported = []
    for cookie in cookies:
        value = cookie_to_cdp(cookie)
        if value.get("name") and value.get("domain"):
            exported.append(value)
    return {"cookies": exported, "origins": origins}


def parse_json_body(raw: bytes) -> dict | None:
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def find_chromium_executable() -> str:
    configured = os.environ.get("CQU_CHROMIUM_PATH")
    candidates = [
        configured,
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ]
    candidates.extend(
        glob.glob(os.path.expanduser("~/.cache/ms-playwright/chromium-*/chrome-*/chrome"))
    )
    candidates.extend(
        glob.glob(os.path.expanduser("~/.cache/ms-playwright/chromium-*/chrome-linux/chrome"))
    )
    for path in candidates:
        if path and os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    raise RuntimeError("raw CDP Chromium executable not found")


class CdpSession:
    def __init__(self, websocket: aiohttp.ClientWebSocketResponse):
        self.websocket = websocket
        self.next_id = 0
        self.pending: dict[int, asyncio.Future] = {}
        self.handlers: dict[str, list[Callable[[dict], None]]] = {}
        self.reader_task = asyncio.create_task(self._reader())

    def on(self, method: str, handler: Callable[[dict], None]) -> None:
        self.handlers.setdefault(method, []).append(handler)

    async def _reader(self) -> None:
        try:
            async for message in self.websocket:
                if message.type != aiohttp.WSMsgType.TEXT:
                    continue
                payload = json.loads(message.data)
                call_id = payload.get("id")
                if isinstance(call_id, int):
                    future = self.pending.get(call_id)
                    if future is not None and not future.done():
                        future.set_result(payload)
                    continue
                method = payload.get("method")
                if method:
                    for handler in self.handlers.get(method, []):
                        try:
                            handler(payload.get("params", {}))
                        except Exception:
                            pass
        except asyncio.CancelledError:
            raise
        except Exception as error:
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(error)

    async def call(self, method: str, params=None, timeout=30) -> dict:
        self.next_id += 1
        call_id = self.next_id
        future = asyncio.get_running_loop().create_future()
        self.pending[call_id] = future
        try:
            await self.websocket.send_json(
                {"id": call_id, "method": method, "params": params or {}}
            )
            payload = await asyncio.wait_for(future, timeout=timeout)
            if "error" in payload:
                raise RuntimeError(payload["error"].get("message", method))
            return payload.get("result", {})
        finally:
            self.pending.pop(call_id, None)

    async def evaluate(self, expression: str, timeout=30):
        result = await self.call(
            "Runtime.evaluate",
            {
                "expression": expression,
                "returnByValue": True,
                "awaitPromise": True,
            },
            timeout=timeout,
        )
        if result.get("exceptionDetails"):
            raise RuntimeError("CDP Runtime.evaluate failed")
        return result.get("result", {}).get("value")

    async def wait_js(self, expression: str, timeout_s: float) -> None:
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            try:
                if await self.evaluate(expression, timeout=5):
                    return
            except Exception:
                pass
            await asyncio.sleep(0.1)
        raise TimeoutError("CDP page condition timed out")

    async def close(self) -> None:
        self.reader_task.cancel()
        await asyncio.gather(self.reader_task, return_exceptions=True)
        await self.websocket.close()


async def _wait_devtools(profile_dir: str, timeout_s: float) -> tuple[int, str]:
    path = os.path.join(profile_dir, "DevToolsActivePort")
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            with open(path, encoding="utf-8") as handle:
                lines = [line.strip() for line in handle if line.strip()]
            if len(lines) >= 2:
                return int(lines[0]), lines[1]
        except (FileNotFoundError, ValueError, OSError):
            pass
        await asyncio.sleep(0.1)
    raise TimeoutError("Chrome DevTools endpoint did not start")


def _free_loopback_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


async def _wait_devtools_http(
    http: aiohttp.ClientSession, port: int, timeout_s: float
) -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            async with http.get(
                f"http://127.0.0.1:{port}/json/version", timeout=1
            ) as response:
                if response.status == 200:
                    return
        except (aiohttp.ClientError, asyncio.TimeoutError):
            pass
        await asyncio.sleep(0.1)
    raise TimeoutError("Chrome DevTools endpoint did not start")


async def _first_page_websocket(
    http: aiohttp.ClientSession, port: int, timeout_s: float = 5
) -> str:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        async with http.get(f"http://127.0.0.1:{port}/json/list") as response:
            response.raise_for_status()
            targets = await response.json()
        page = next((item for item in targets if item.get("type") == "page"), None)
        if page:
            return page["webSocketDebuggerUrl"]
        await asyncio.sleep(0.1)
    raise TimeoutError("Chrome did not expose a page target")


async def _set_seed_cookies(cdp: CdpSession, seed_state: dict | None) -> None:
    if not seed_state:
        return
    cookies = [cookie_to_cdp(cookie) for cookie in seed_state.get("cookies", [])]
    cookies = [cookie for cookie in cookies if cookie.get("name") and cookie.get("domain")]
    if cookies:
        await cdp.call("Network.setCookies", {"cookies": cookies})


async def _wait_login_ready(cdp: CdpSession) -> tuple[str, str]:
    deadline = time.monotonic() + max(
        browser_profile.LOGIN_COOKIE_WAIT_MS,
        browser_profile.LOGIN_FORM_WAIT_MS,
    ) / 1000
    while time.monotonic() < deadline:
        try:
            values = await cdp.evaluate(
                "({croypto:document.querySelector('#login-croypto')?.innerText?.trim()||'',"
                "execution:document.querySelector('#login-page-flowkey')?.innerText?.trim()||''})",
                timeout=5,
            )
            raw_cookies = await cdp.call(
                "Network.getCookies", {"urls": [legacy.SSO]}, timeout=5
            )
            cookies_ready = legacy._dynamic_cookie_pair_present(
                raw_cookies.get("cookies", [])
            )
            if cookies_ready and values["croypto"] and values["execution"]:
                return values["croypto"], values["execution"]
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
    while time.monotonic() < deadline:
        if legacy.extract_ticket(tickets):
            return "success"
        try:
            state = await cdp.evaluate(
                "({url:location.href,text:document.body?.innerText||'',"
                "error:document.querySelector('#login-error-code')?.innerText?.trim()||''})",
                timeout=5,
            )
            tickets.append(state.get("url", ""))
            if "二次身份验证" in state.get("text", ""):
                return "2fa"
            error = state.get("error", "")
            if error:
                markers = ("用户名或密码", "密码错误", "账号已锁定", "帐号已锁定", "冻结")
                prefix = "credential_rejected" if any(item in error for item in markers) else "transient"
                return f"{prefix}:{error[:80]}"
        except Exception:
            pass
        await asyncio.sleep(0.1)
    try:
        diagnostic = await cdp.evaluate(
            "({title:document.title,url:location.origin+location.pathname,"
            "text:(document.body?.innerText||'').replace(/\\s+/g,' ').slice(0,120),"
            "hasLogin:!!document.querySelector('#login-croypto'),"
            "hasCaptcha:!![...document.querySelectorAll('input')].find(e=>"
            "(e.placeholder||'').includes('校验码')) ,"
            "ua:navigator.userAgent,brands:navigator.userAgentData?.brands||[]})",
            timeout=5,
        )
    except Exception:
        diagnostic = {"unreadable": True}
    return "transient:第一因素提交后页面未进入可识别状态 " + json.dumps(
        diagnostic, ensure_ascii=False, separators=(",", ":")
    )


async def _switch_mail_tab(cdp: CdpSession) -> None:
    await asyncio.sleep(browser_profile.TWO_FACTOR_SETTLE_WAIT_MS / 1000)
    await cdp.wait_js("document.querySelectorAll('.ant-tabs-tab').length >= 2", 15)
    await interaction_jitter()
    await cdp.evaluate(
        "[...document.querySelectorAll('.ant-tabs-tab')].find(e => "
        "e.innerText.includes('邮件验证码')).click(); true"
    )
    await cdp.wait_js("document.body?.innerText.includes('已绑定密保邮箱')", 15)
    await asyncio.sleep(browser_profile.TWO_FACTOR_SETTLE_WAIT_MS / 1000)


async def _click_send_code(cdp: CdpSession) -> None:
    await interaction_jitter()
    rect = await cdp.evaluate(
        """(() => {
          const element = [...document.querySelectorAll(
            '.font-class-text-button,button,span,a'
          )].find(e => e.innerText.trim() === '获取验证码' &&
            e.getBoundingClientRect().width > 0);
          if (!element) return null;
          const r = element.getBoundingClientRect();
          return {x:r.x+r.width/2,y:r.y+r.height/2};
        })()"""
    )
    if not rect:
        raise RuntimeError("未找到「获取验证码」按钮(页面结构可能变化)")
    for event_type in ("mousePressed", "mouseReleased"):
        await cdp.call(
            "Input.dispatchMouseEvent",
            {
                "type": event_type,
                "x": rect["x"],
                "y": rect["y"],
                "button": "left",
                "clickCount": 1,
            },
        )


async def _response_body(cdp: CdpSession, request_id: str) -> bytes:
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        try:
            result = await cdp.call(
                "Network.getResponseBody", {"requestId": request_id}, timeout=5
            )
            body = result.get("body", "")
            if result.get("base64Encoded"):
                import base64

                return base64.b64decode(body)
            return body.encode("utf-8")
        except Exception:
            await asyncio.sleep(0.1)
    return b""


async def _export_state(cdp: CdpSession, service: str) -> dict:
    raw = await cdp.call("Network.getAllCookies")
    cookies = [
        cookie
        for cookie in raw.get("cookies", [])
        if (cookie.get("domain", "").lstrip(".") == "cqu.edu.cn"
            or cookie.get("domain", "").lstrip(".").endswith(".cqu.edu.cn"))
    ]
    origins = []
    await cdp.call("DOMStorage.enable")
    current = await cdp.evaluate("location.origin")
    candidates = {legacy.SSO, urllib.parse.urlparse(service)._replace(path="", params="", query="", fragment="").geturl()}
    if isinstance(current, str) and current.startswith("https://"):
        candidates.add(current)
    for origin in candidates:
        try:
            result = await cdp.call(
                "DOMStorage.getDOMStorageItems",
                {"storageId": {"securityOrigin": origin, "isLocalStorage": True}},
                timeout=5,
            )
            items = [
                {"name": item[0], "value": item[1]}
                for item in result.get("entries", [])
                if len(item) >= 2
            ]
            origins.append({"origin": origin, "localStorage": items})
        except Exception:
            pass
    return cookies_to_storage_state(cookies, origins)


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

    runtime_root = os.environ.get("CQU_CDP_RUNTIME_DIR")
    if not runtime_root:
        runtime_root = "/app/runtime" if os.path.isdir("/app") else os.path.join(os.getcwd(), ".cqu-runtime")
    os.makedirs(runtime_root, mode=0o700, exist_ok=True)
    profile_dir = tempfile.mkdtemp(prefix="cqu-cdp-", dir=runtime_root)
    process = None
    cdp = None
    http = None
    try:
        executable = find_chromium_executable()
        debug_port = _free_loopback_port()
        process = await asyncio.create_subprocess_exec(
            *build_chrome_args(executable, profile_dir, debug_port, proxy),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        http = aiohttp.ClientSession()
        await _wait_devtools_http(
            http, debug_port, browser_profile.BROWSER_LAUNCH_TIMEOUT_MS / 1000
        )
        page_ws = await _first_page_websocket(
            http,
            debug_port,
            browser_profile.BROWSER_LAUNCH_TIMEOUT_MS / 1000,
        )
        websocket = await http.ws_connect(page_ws, origin=None)
        cdp = CdpSession(websocket)
        await cdp.call("Page.enable")
        await cdp.call("Runtime.enable")
        await cdp.call("Network.enable")
        version = (await cdp.call("Browser.getVersion"))["product"].split("/", 1)[1]
        await cdp.call(
            "Network.setUserAgentOverride", legacy.build_browser_identity(version)
        )
        await _set_seed_cookies(cdp, seed_state)

        tickets: list[str] = []
        send_response = {}
        send_event = asyncio.Event()

        def on_request(params: dict) -> None:
            url = params.get("request", {}).get("url", "")
            if "ticket=ST-" in url:
                tickets.append(url)

        def on_response(params: dict) -> None:
            response = params.get("response", {})
            url = response.get("url", "")
            location = response.get("headers", {}).get("location", "")
            if "ticket=ST-" in url:
                tickets.append(url)
            if "ticket=ST-" in location:
                tickets.append(location)
            if legacy.METHOD[method]["send_marker"] in url:
                send_response.update(
                    status=int(response.get("status", 0)),
                    request_id=params.get("requestId", ""),
                )
                send_event.set()

        cdp.on("Network.requestWillBeSent", on_request)
        cdp.on("Network.responseReceived", on_response)

        url = f"{legacy.SSO}/login?service={urllib.parse.quote(service, safe='')}"
        await cdp.call("Page.navigate", {"url": url})
        croypto, execution = await _wait_login_ready(cdp)
        captcha_required = await cdp.evaluate(
            "!![...document.querySelectorAll('input')].find(e => "
            "(e.placeholder || '').includes('校验码'))"
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
                "password": legacy.aes_encrypt_password(croypto, password),
            },
        )
        verdict = await _wait_first_factor(cdp, tickets)
        if verdict == "success":
            ticket = legacy.extract_ticket(tickets)
            return {"state": await _export_state(cdp, service), "ticket": ticket}
        if verdict != "2fa":
            raise RuntimeError(f"first-factor failed: {verdict}")

        await _switch_mail_tab(cdp)
        if permit_provider is not None:
            await permit_provider()
        await _click_send_code(cdp)
        try:
            await asyncio.wait_for(
                send_event.wait(),
                timeout=browser_profile.SEND_CODE_RESPONSE_TIMEOUT_MS / 1000,
            )
        except asyncio.TimeoutError as error:
            raise RuntimeError("发码响应超时(验证码状态未知)") from error
        raw_body = await _response_body(cdp, send_response["request_id"])
        body = parse_json_body(raw_body)
        send_verdict = legacy.classify_send_code(send_response["status"], body)
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
                "type": legacy.METHOD[method]["login_type"],
                "execution": execution,
                "_eventId": "submit",
                "geolocation": "",
                "captcha_code": "",
            },
        )
        deadline = time.monotonic() + browser_profile.FORMNAV_TIMEOUT_MS / 1000
        ticket = ""
        while time.monotonic() < deadline:
            ticket = legacy.extract_ticket(tickets)
            if ticket:
                break
            try:
                tickets.append(await cdp.evaluate("location.href", timeout=5) or "")
            except Exception:
                pass
            await asyncio.sleep(0.1)
        if not ticket:
            raise RuntimeError("未捕获 ST ticket(验证码可能错误/过期)")
        return {"state": await _export_state(cdp, service), "ticket": ticket}
    finally:
        if cdp is not None:
            try:
                await cdp.call("Browser.close", timeout=2)
            except Exception:
                pass
            await cdp.close()
        if http is not None:
            await http.close()
        if process is not None and process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=5)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()
        shutil.rmtree(profile_dir, ignore_errors=True)
