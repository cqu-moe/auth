"""Shared Chromium/CDP lifetime, state and network events for CQU operations."""

import asyncio
import base64
import errno
import glob
import json
import os
import random
import shutil
import signal
import socket
import sys
import tempfile
import time
import urllib.parse
from collections.abc import Callable
from types import SimpleNamespace

import aiohttp

import browser_profile
import cqu_login

STORAGE_PAGE_TIMEOUT_S = 10.0
PROFILE_CLEANUP_TIMEOUT_S = 2.0

def build_chrome_args(
    executable: str, profile_dir: str, debug_port: int, proxy=None
) -> list[str]:
    args = [
        executable,
        f"--remote-debugging-port={debug_port}",
        f"--user-data-dir={profile_dir}",
        "--no-first-run",
        "--no-default-browser-check",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "about:blank",
    ]
    if os.environ.get("DISPLAY"):
        args.insert(-1, "--window-size=1440,1000")
    else:
        args.insert(-1, "--headless=new")
    if proxy and proxy.get("server"):
        args.insert(-1, f"--proxy-server={proxy['server']}")
    if sys.platform == "darwin":
        # A fresh automation profile must not wait on the user's Keychain prompt.
        args.insert(-1, "--use-mock-keychain")
    return args


def cookie_to_cdp(cookie: dict) -> dict:
    allowed = ("name", "value", "domain", "path", "httpOnly", "secure", "sameSite")
    result = {key: cookie[key] for key in allowed if key in cookie}
    expires = cookie.get("expires")
    if isinstance(expires, (int, float)) and expires > 0:
        result["expires"] = expires
    partition = cookie.get("partitionKey")
    if isinstance(partition, str):
        result["partitionKey"] = {"topLevelSite": partition, "hasCrossSiteAncestor": False}
    elif isinstance(partition, dict) and isinstance(partition.get("topLevelSite"), str):
        result["partitionKey"] = {"topLevelSite": partition["topLevelSite"],
                                  "hasCrossSiteAncestor": partition.get("hasCrossSiteAncestor", False)}
    return result


def cookies_to_storage_state(cookies: list[dict], origins: list[dict]) -> dict:
    exported = []
    for cookie in cookies:
        value = cookie_to_cdp(cookie)
        # Import omits session expiry; exported storage state requires it.
        value["expires"] = cookie.get("expires", -1)
        value["sameSite"] = cookie.get("sameSite", "Lax")
        for key in cookie:
            if "partition" in key.lower():
                value[key] = cookie[key]
        if value.get("name") and value.get("domain"):
            exported.append(value)
    return {"cookies": exported, "origins": origins}


def find_chromium_executable() -> str:
    configured = os.environ.get("CQU_CHROMIUM_EXECUTABLE") or os.environ.get("CQU_CHROMIUM_PATH")
    if configured:
        if os.path.isfile(configured) and os.access(configured, os.X_OK):
            return configured
        raise RuntimeError("configured Chromium executable is unavailable")
    candidates = [
        configured,
        "/opt/chrome/chrome-linux64/chrome",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
    ]
    candidates.extend(
        glob.glob(os.path.expanduser("~/.cache/ms-playwright/chromium-*/chrome-*/chrome"))
    )
    candidates.extend(
        glob.glob(os.path.expanduser("~/.cache/ms-playwright/chromium-*/chrome-linux/chrome"))
    )
    candidates.extend(sorted(glob.glob(os.path.expanduser(
        "~/Library/Caches/ms-playwright/chromium-*/chrome-mac*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
    )), reverse=True))
    candidates.extend(sorted(glob.glob(os.path.expanduser(
        "~/Library/Caches/ms-playwright/chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium"
    )), reverse=True))
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
        self.closed = False
        self.disconnected = asyncio.Event()
        self.reader_task = asyncio.create_task(self._reader())

    def on(self, method: str, handler: Callable[[dict], None]) -> None:
        self.handlers.setdefault(method, []).append(handler)

    async def _reader(self) -> None:
        failure = ConnectionError("Chrome DevTools connection closed")
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
        except Exception:
            failure = ConnectionError("Chrome DevTools connection failed")
        finally:
            self.closed = True
            self.disconnected.set()
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(failure)

    async def call(self, method: str, params=None, timeout=30) -> dict:
        if self.closed:
            raise ConnectionError("Chrome DevTools connection closed")
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
            except ConnectionError:
                raise
            except Exception:
                pass
            await asyncio.sleep(0.1)
        raise TimeoutError("CDP page condition timed out")

    async def close(self) -> None:
        self.reader_task.cancel()
        await asyncio.gather(self.reader_task, return_exceptions=True)
        await self.websocket.close()


def is_school_origin(origin: str) -> bool:
    try:
        parsed = urllib.parse.urlsplit(origin)
        return (parsed.scheme == "https" and parsed.username is None
                and parsed.password is None and parsed.port in (None, 443)
                and bool(parsed.hostname) and parsed.hostname.endswith(".cqu.edu.cn")
                and not parsed.path and not parsed.query and not parsed.fragment)
    except (TypeError, ValueError):
        return False


def is_school_cookie(cookie: dict) -> bool:
    domain = cookie.get("domain", "").lstrip(".")
    return bool(cookie.get("name")) and (domain == "cqu.edu.cn" or domain.endswith(".cqu.edu.cn"))


async def restore_seed_cookies(cdp: CdpSession, state: dict | None) -> None:
    if not state:
        return
    cookies = [cookie_to_cdp(cookie) for cookie in state.get("cookies", [])
               if isinstance(cookie, dict) and is_school_cookie(cookie)]
    if cookies:
        await cdp.call("Network.setCookies", {"cookies": cookies})


def seed_origins(state: dict | None) -> dict:
    return {
        item["origin"]: [[entry["name"], entry["value"]] for entry in item.get("localStorage", [])
                         if isinstance(entry, dict) and isinstance(entry.get("name"), str)
                         and isinstance(entry.get("value"), str)]
        for item in (state or {}).get("origins", [])
        if isinstance(item, dict) and is_school_origin(item.get("origin", ""))
    }


class NetworkResponse:
    def __init__(self, cdp, params):
        data = params["response"]
        self.url = data["url"]
        self.status = int(data["status"])
        self.headers = {key.lower(): str(value) for key, value in data.get("headers", {}).items()}
        self.request = SimpleNamespace(resource_type=params.get("type", "Other").lower())
        self.request_id = params["requestId"]
        self._cdp = cdp
        self._finished = asyncio.Event()
        self._failed = False

    async def text(self):
        await wait_for_browser_event(self._cdp, self._finished)
        if self._failed:
            raise RuntimeError("Browser response did not finish loading")
        result = await self._cdp.call("Network.getResponseBody", {"requestId": self.request_id})
        if result.get("base64Encoded"):
            return base64.b64decode(result["body"]).decode("utf-8", errors="replace")
        return result.get("body", "")


async def wait_for_browser_event(cdp, event):
    ready = asyncio.create_task(event.wait())
    disconnected = asyncio.create_task(cdp.disconnected.wait())
    try:
        await asyncio.wait({ready, disconnected}, return_when=asyncio.FIRST_COMPLETED)
        if cdp.closed:
            raise ConnectionError("CONTAINER_UNAVAILABLE")
    finally:
        for task in (ready, disconnected):
            if not task.done():
                task.cancel()
        await asyncio.gather(ready, disconnected, return_exceptions=True)


class ChromiumSession:
    """One isolated browser process, one page, and ownership of its CDP tasks."""

    def __init__(self, *, seed_state=None, proxy=None):
        self.seed_state = seed_state
        self.proxy = proxy
        self.cdp = None
        self.process = None
        self._process_group = None
        self.http = None
        self.profile_dir = None
        self.url = "about:blank"
        self.tickets = []
        self.origins = set()
        self._storage = {origin: dict(items) for origin, items in seed_origins(seed_state).items()}
        self._requests = []
        self._responses = []
        self._bodies = {}
        self._tasks = set()
        self._navigation = asyncio.Event()

    async def __aenter__(self):
        try:
            root = os.environ.get("CQU_CDP_RUNTIME_DIR", "/app/runtime" if os.path.isdir("/app")
                                  else os.path.join(os.getcwd(), ".cqu-runtime"))
            os.makedirs(root, mode=0o700, exist_ok=True)
            self.profile_dir = tempfile.mkdtemp(prefix="cqu-cdp-", dir=root)
            os.mkdir(os.path.join(self.profile_dir, "Default"))
            with open(os.path.join(self.profile_dir, "Default", "Preferences"), "w") as preferences:
                json.dump({"intl": {"accept_languages": "zh-CN,zh"}}, preferences)
            port = _free_loopback_port()
            self.port = port
            self.process = await asyncio.create_subprocess_exec(
                *build_chrome_args(find_chromium_executable(), self.profile_dir, port, self.proxy),
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
                start_new_session=True,
            )
            self._process_group = self.process.pid
            self.http = aiohttp.ClientSession()
            async with asyncio.timeout(browser_profile.BROWSER_LAUNCH_TIMEOUT_MS / 1000):
                await _wait_devtools_http(self.http, port, browser_profile.BROWSER_LAUNCH_TIMEOUT_MS / 1000)
                endpoint = await _first_page_websocket(self.http, port,
                                                       browser_profile.BROWSER_LAUNCH_TIMEOUT_MS / 1000)
                self.cdp = CdpSession(await self.http.ws_connect(endpoint, origin=None))
                await self.cdp.call("Page.enable")
                await self.cdp.call("Network.enable")
                await self.cdp.call("DOMStorage.enable")
                self.version = (await self.cdp.call("Browser.getVersion"))["product"].split("/", 1)[1]
                await self.cdp.call("Emulation.setLocaleOverride", {"locale": "zh-CN"})
                await self.cdp.call("Emulation.setTimezoneOverride", {"timezoneId": "Asia/Shanghai"})
                await self.cdp.call("Emulation.setDeviceMetricsOverride", {
                    "width": 1440, "height": 900, "deviceScaleFactor": 1, "mobile": False,
                })
                await restore_seed_cookies(self.cdp, self.seed_state)
                if self._storage:
                    await self._storage_page(self._storage, restore=True)
                    self.origins.update(self._storage)
            self.cdp.on("Network.requestWillBeSent", self._on_request)
            self.cdp.on("Network.responseReceived", self._on_response)
            self.cdp.on("Network.loadingFinished", self._on_finished)
            self.cdp.on("Network.loadingFailed", self._on_failed)
            self.cdp.on("Page.frameNavigated", self._on_frame)
            self.cdp.on("Page.domContentEventFired", lambda _: self._navigation.set())
            return self
        except BaseException:
            await self.close()
            raise

    async def __aexit__(self, *_args):
        await self.close()

    def on_request(self, callback):
        self._requests.append(callback)

    def on_response(self, callback):
        self._responses.append(callback)

    def _remember_ticket(self, url):
        if "ticket=ST-" in url:
            self.tickets.append(url)

    def _on_request(self, params):
        url = params.get("request", {}).get("url", "")
        self._remember_ticket(url)
        redirect = params.get("redirectResponse", {})
        for name, value in redirect.get("headers", {}).items():
            if name.lower() == "location":
                self._remember_ticket(value)
        request = SimpleNamespace(url=url, resource_type=params.get("type", "Other").lower())
        for callback in self._requests:
            callback(request)

    def _on_response(self, params):
        response = NetworkResponse(self.cdp, params)
        self._bodies[response.request_id] = response
        self._remember_ticket(response.url)
        self._remember_ticket(response.headers.get("location", ""))
        for callback in self._responses:
            callback(response)

    def _on_finished(self, params):
        response = self._bodies.get(params["requestId"])
        if response:
            response._finished.set()

    def _on_failed(self, params):
        response = self._bodies.get(params["requestId"])
        if response:
            response._failed = True
            response._finished.set()

    def _on_frame(self, params):
        frame = params.get("frame", {})
        if not frame.get("parentId"):
            self.url = frame.get("url", "about:blank")
        origin = frame.get("securityOrigin", "")
        if is_school_origin(origin):
            self.origins.add(origin)
            self._storage.setdefault(origin, {})

    async def evaluate(self, expression, argument=None):
        if argument is not None:
            expression = f"({expression})({json.dumps(argument)})"
        return await self.cdp.evaluate(expression)

    async def navigate(self, url, *, timeout_s, wait_until="domcontentloaded"):
        self._navigation.clear()
        async with asyncio.timeout(timeout_s):
            result = await self.cdp.call("Page.navigate", {"url": url}, timeout=timeout_s)
            if result.get("errorText"):
                raise RuntimeError("Browser navigation failed")
            if wait_until != "commit":
                await wait_for_browser_event(self.cdp, self._navigation)

    async def reload(self, *, timeout_s, wait_until="domcontentloaded"):
        self._navigation.clear()
        async with asyncio.timeout(timeout_s):
            await self.cdp.call("Page.reload", timeout=timeout_s)
            if wait_until != "commit":
                await wait_for_browser_event(self.cdp, self._navigation)

    async def pause(self, milliseconds):
        await asyncio.sleep(max(0, milliseconds) / 1000)

    async def cookies(self, urls=None):
        result = await self.cdp.call("Network.getCookies", {"urls": urls} if urls else {})
        return result.get("cookies", [])

    async def content(self):
        return await self.evaluate("document.documentElement?.outerHTML || ''")

    async def storage_state(self):
        raw = await self.cdp.call("Network.getAllCookies")
        cookies = [cookie for cookie in raw.get("cookies", []) if is_school_cookie(cookie)]
        unresolved = []
        for origin in sorted(self.origins):
            try:
                result = await self.cdp.call("DOMStorage.getDOMStorageItems", {
                    "storageId": {"securityOrigin": origin, "isLocalStorage": True},
                })
                self._storage[origin] = dict(result.get("entries", []))
            except RuntimeError:
                unresolved.append(origin)
        if unresolved:
            self._storage.update(await self._storage_page(unresolved))
        origins = [{"origin": origin, "localStorage": [
            {"name": name, "value": value} for name, value in sorted(items.items())
        ]} for origin, items in sorted(self._storage.items())]
        return cookies_to_storage_state(cookies, origins)

    async def _storage_page(self, origins, *, restore=False):
        """Read real profile storage with a blank, intercepted page; no school requests."""
        origins = [origin for origin in origins if is_school_origin(origin)]
        target = None
        page = None
        tasks = set()
        async with asyncio.timeout(STORAGE_PAGE_TIMEOUT_S):
            try:
                target = (await self.cdp.call("Target.createTarget", {
                    "url": "about:blank", "background": True,
                }))["targetId"]
                endpoint = await _first_page_websocket(self.http, self.port, target_id=target)
                page = CdpSession(await self.http.ws_connect(endpoint, origin=None))
                await page.call("Page.enable")
                ready = asyncio.Event()
                page.on("Page.domContentEventFired", lambda _: ready.set())

                async def fulfill(params):
                    await page.call("Fetch.fulfillRequest", {
                        "requestId": params["requestId"], "responseCode": 200,
                        "responseHeaders": [{"name": "Content-Type", "value": "text/html"}],
                        "body": base64.b64encode(b"<!doctype html><html></html>").decode(),
                    })

                def paused(params):
                    tasks.add(asyncio.create_task(fulfill(params)))

                page.on("Fetch.requestPaused", paused)
                await page.call("Network.setBypassServiceWorker", {"bypass": True})
                await page.call("Fetch.enable", {"patterns": [{"urlPattern": "*", "requestStage": "Request"}]})
                result = {}
                for origin in origins:
                    ready.clear()
                    await page.call("Page.navigate", {"url": origin + "/"})
                    await wait_for_browser_event(page, ready)
                    if restore:
                        entries = json.dumps(list(self._storage[origin].items()))
                        await page.evaluate(f"(() => {{ for (const [k,v] of {entries}) localStorage.setItem(k,v); }})()")
                    result[origin] = dict(await page.evaluate("Object.entries(localStorage)"))
                return result
            finally:
                for task in tasks:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                try:
                    if target is not None:
                        try:
                            await self.cdp.call("Target.closeTarget", {"targetId": target}, timeout=2)
                        except Exception:
                            pass
                finally:
                    if page is not None:
                        try:
                            await asyncio.wait_for(page.close(), timeout=2)
                        except Exception:
                            pass

    async def click_text(self, selector, text, *, timeout_s):
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            rect = await self.evaluate("""({selector,text,rx,ry}) => {
              for (const element of document.querySelectorAll(selector)) {
                if (element.innerText.trim() !== text ||
                    element.closest(':disabled,[aria-disabled="true"],[inert]') ||
                    !element.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) continue;
                element.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
                const r = element.getBoundingClientRect(), x=r.x+r.width*rx, y=r.y+r.height*ry;
                const hit = document.elementFromPoint(x,y);
                if (r.width && r.height && hit && (hit === element || element.contains(hit))) return {x,y};
              }
              return null;
            }""", {"selector": selector, "text": text,
                     "rx": random.uniform(0.35, 0.65), "ry": random.uniform(0.35, 0.65)})
            if rect:
                for event_type in ("mouseMoved", "mousePressed", "mouseReleased"):
                    await self.cdp.call("Input.dispatchMouseEvent", {
                        "type": event_type, **rect,
                        "button": "none" if event_type == "mouseMoved" else "left",
                        "clickCount": 0 if event_type == "mouseMoved" else 1,
                    })
                return
            await asyncio.sleep(0.1)
        # Carry the selector, target text, and why the control stayed unclickable so error
        # tracking can tell the two call sites apart. The probe reports counts only, never
        # page text; the /run response never echoes this message either.
        state = await self._describe_missing_control(selector, text)
        raise RuntimeError(
            f"login control not actionable: selector={selector} text={text!r} state={state}"
        )

    async def _describe_missing_control(self, selector, text):
        try:
            report = await self.evaluate("""({selector,text}) => {
              const nodes = [...document.querySelectorAll(selector)];
              const withText = nodes.filter(element => (element.innerText || '').trim() === text);
              return {
                matched: nodes.length,
                withText: withText.length,
                hidden: withText.filter(element =>
                  !element.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})).length,
                disabled: withText.filter(element =>
                  element.closest(':disabled,[aria-disabled="true"],[inert]')).length,
                readyState: document.readyState,
              };
            }""", {"selector": selector, "text": text})
        except Exception as error:
            report = {"probeError": type(error).__name__}
        return json.dumps(report, ensure_ascii=False, separators=(",", ":"))

    async def intercept_requests(self, should_abort):
        async def handle(params):
            url = params["request"]["url"]
            self._remember_ticket(url)
            if should_abort(url):
                await self.cdp.call("Fetch.failRequest", {"requestId": params["requestId"], "errorReason": "Aborted"})
            else:
                await self.cdp.call("Fetch.continueRequest", {"requestId": params["requestId"]})
        def paused(params):
            task = asyncio.create_task(handle(params))
            self._tasks.add(task)
        self.cdp.on("Fetch.requestPaused", paused)
        await self.cdp.call("Fetch.enable", {"patterns": [{"urlPattern": "*", "requestStage": "Request"}]})

    async def close(self):
        for response in self._bodies.values():
            response._failed = True
            response._finished.set()
        for task in self._tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        try:
            if self.cdp:
                try:
                    await self.cdp.call("Browser.close", timeout=2)
                except Exception:
                    pass
                try:
                    await asyncio.wait_for(self.cdp.close(), timeout=2)
                except Exception:
                    pass
        finally:
            try:
                if self.http:
                    try:
                        await asyncio.wait_for(self.http.close(), timeout=2)
                    except Exception:
                        pass
            finally:
                try:
                    await self._stop_process_tree()
                finally:
                    await self._remove_profile()

    async def _stop_process_tree(self):
        if self.process is None:
            return

        def send(sig):
            try:
                if self._process_group is not None:
                    os.killpg(self._process_group, sig)
                elif self.process.returncode is None:
                    (self.process.terminate if sig == signal.SIGTERM else self.process.kill)()
            except ProcessLookupError:
                pass

        reaped = self.process.returncode is not None
        try:
            send(signal.SIGTERM)
            if not reaped:
                try:
                    await asyncio.wait_for(self.process.wait(), timeout=5)
                    reaped = True
                except asyncio.TimeoutError:
                    pass
        finally:
            # Browser.close may finish the parent while profile-writing children remain.
            if self._process_group is not None or not reaped:
                send(signal.SIGKILL)
            if not reaped:
                await asyncio.wait_for(self.process.wait(), timeout=5)
            self._process_group = None

    async def _remove_profile(self):
        if self.profile_dir is None:
            return
        deadline = time.monotonic() + PROFILE_CLEANUP_TIMEOUT_S
        while True:
            try:
                shutil.rmtree(self.profile_dir)
                self.profile_dir = None
                return
            except FileNotFoundError:
                if not os.path.lexists(self.profile_dir):
                    self.profile_dir = None
                    return
            except OSError as error:
                if error.errno not in (errno.ENOTEMPTY, errno.EEXIST):
                    raise RuntimeError("BROWSER_CLEANUP_FAILED") from None
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError("BROWSER_CLEANUP_FAILED") from None
            await asyncio.sleep(min(0.05, remaining))


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
    http: aiohttp.ClientSession, port: int, timeout_s: float = 5, *, target_id: str | None = None,
) -> str:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        async with http.get(f"http://127.0.0.1:{port}/json/list") as response:
            response.raise_for_status()
            targets = await response.json()
        page = next((item for item in targets if item.get("type") == "page"
                     and (target_id is None or item.get("id") == target_id)), None)
        if page:
            return page["webSocketDebuggerUrl"]
        await asyncio.sleep(0.1)
    raise TimeoutError("Chrome did not expose a page target")
