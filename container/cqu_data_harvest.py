"""Organic harvest:在已登录 + 已过瑞数的临时浏览器里有机 fire 请求并截获响应。

my.cqu.edu.cn 全站瑞数化后,后端纯 HTTP POST 课表被 412 专守;唯一过墙是让真前端在
auth 已登录浏览器里导航 navUrl(页面自动 fire 课表/学期)+ 截获 capture 模式响应 +
对 fetch[] 跑 in-page GET(同源、读豁免)。本模块是 schedule 取数的通用原语,业务无关。

host 红线:navUrl/capture(同源相对或绝对)/fetch[].url 解析出的 host 必须精确为
my.cqu.edu.cn —— 比取票的 *.cqu.edu.cn 收得更紧(harvest 只打这一个 host),防 auth 变
开放代理(SSRF)。纯函数(host 校验 / recipe 解析 / capture 匹配)抽出便于单测。
"""
import asyncio
import urllib.parse
from patchright.async_api import async_playwright
import cqu_login  # UA / locale 等浏览器对抗参数,与取票统一
import cqu_ticket_browser  # 复用 _close_browser_driver / TICKET_SEMAPHORE / 超时常量

# harvest 唯一允许的目标 host(精确等于,绝不 endswith/in)。
HARVEST_HOST = "my.cqu.edu.cn"


def is_harvest_host_allowed(url: str) -> bool:
    """url 的 host 是否精确为 my.cqu.edu.cn(https、无 userinfo、端口省略或 443)。

    策略对齐 server.is_allowed_service_url 的红线(反斜杠/非ASCII/scheme/userinfo/端口/
    host 字符),但 host 判定收紧为 **精确等于 HARVEST_HOST**(不放行其它 *.cqu.edu.cn)。
    纯函数,不抛。
    """
    if not url or "\\" in url:
        return False
    if any(ord(ch) < 0x20 or ord(ch) > 0x7e for ch in url):  # 非 ASCII / 控制符
        return False
    try:
        u = urllib.parse.urlparse(url)
    except Exception:
        return False
    if u.scheme != "https":
        return False
    if u.username or u.password:
        return False
    try:
        port = u.port  # 非法端口抛 ValueError
    except ValueError:
        return False
    if port is not None and port != 443:
        return False
    host = (u.hostname or "").lower()
    if not host:
        return False
    if any(ch not in "abcdefghijklmnopqrstuvwxyz0123456789.-" for ch in host):
        return False
    return host == HARVEST_HOST


class HarvestRecipeError(Exception):
    """harvest 配方(navUrl/capture/fetch)非法 —— host 越界 / 缺字段 / method 非 GET。

    server.py 据此回 400(客户端契约错);message 只含红线类型,不回显入参原文。
    """


def parse_harvest_recipe(body: dict) -> dict:
    """校验 + 规范化 {navUrl, capture[], fetch[]}。非法抛 HarvestRecipeError。

    · navUrl: 必填,host 必须过 is_harvest_host_allowed。
    · capture: list[str],每项非空字符串(URL 子串模式,page.on('response') 用 `in` 匹配);
               允许空 list。
    · fetch: list[{method?:"GET", url:str}],method 省略默认 GET、仅允许 GET;url 必须过
             host 白名单;允许空 list。
    纯函数,便于单测。返回的 dict 字段均已规范化,可直接喂给 harvest 主体。
    """
    if not isinstance(body, dict):
        raise HarvestRecipeError("recipe must be an object")

    nav_url = body.get("navUrl")
    if not isinstance(nav_url, str) or not is_harvest_host_allowed(nav_url):
        raise HarvestRecipeError("navUrl missing or host not allowed")

    capture = body.get("capture", [])
    if not isinstance(capture, list):
        raise HarvestRecipeError("capture must be a list")
    for pat in capture:
        if not isinstance(pat, str) or not pat:
            raise HarvestRecipeError("capture entries must be non-empty strings")

    raw_fetch = body.get("fetch", [])
    if not isinstance(raw_fetch, list):
        raise HarvestRecipeError("fetch must be a list")
    fetch: list[dict] = []
    for f in raw_fetch:
        if not isinstance(f, dict):
            raise HarvestRecipeError("fetch entries must be objects")
        method = (f.get("method") or "GET").upper()
        if method != "GET":
            raise HarvestRecipeError("fetch method must be GET")
        url = f.get("url")
        if not isinstance(url, str) or not is_harvest_host_allowed(url):
            raise HarvestRecipeError("fetch url missing or host not allowed")
        fetch.append({"method": "GET", "url": url})

    return {"navUrl": nav_url, "capture": list(capture), "fetch": fetch}


def capture_match(resp_url: str, patterns: list[str]) -> str | None:
    """resp_url 命中的第一个 capture pattern(子串 in 匹配),无命中返回 None。

    对齐 spike:CAqWHAeT 令牌作 URL 参数注入,故按"端点路径子串"匹配而非全等。
    返回命中的 pattern 本身(作 captures dict 的去重 key)。纯函数。
    """
    if not resp_url:
        return None
    for pat in patterns:
        if pat in resp_url:
            return pat
    return None


def all_captures_present(collected: set[str], expected: list[str]) -> bool:
    """已收集的 pattern 集是否覆盖全部期望 pattern(等齐判定,供主体决定提前结束盲等)。"""
    return all(p in collected for p in expected)


# 导航后等页面有机 fire 完 capture 的盲等上限(ms):课表 POST(my-table-detail)+ 学期
# 由 /workspace/curriculum 自动 fire,实测百毫秒级到齐;给足 8s 容瑞数当场重算/重定向。
CAPTURE_WAIT_MS = 8000
CAPTURE_POLL_MS = 150
# 单个 in-page fetch 的超时(ms):同源 GET 读豁免,正常亚秒级。
INPAGE_FETCH_TIMEOUT_MS = 15000
# harvest 整段执行上限(秒):navigate 过瑞数 + 等 capture + 跑 fetch[]。复用取票 overall_timeout 量级。
HARVEST_OVERALL_TIMEOUT = 45.0


async def harvest(state: dict, recipe: dict) -> dict:
    """在水化 state 的临时浏览器里 navigate recipe.navUrl(过瑞数,页面有机 fire 课表/学期),
    截获命中 capture 模式的响应 + 跑 fetch[] in-page GET,返回 {captures, fetches}。

    recipe 已由 parse_harvest_recipe 校验/规范化(host 全过白名单)。浏览器对抗参数(launch
    args / UA / locale / timezone / 显式 start-stop 驱动 / 限时 cleanup)复用 cqu_ticket_browser
    的 _hydrate_navigate 骨架,统一瑞数对抗。返回结构对 server/schedule 稳定。

    captures[i] = {url, status, contentType, body};fetches[i] = {url, status, body}。
    body 是文本(JSON 由上层 schedule 解析)。绝不记录 cookie/state/token 明文。
    """
    nav_url = recipe["navUrl"]
    patterns: list[str] = recipe["capture"]
    fetch_list: list[dict] = recipe["fetch"]
    handles: dict = {"pw": None, "browser": None}

    async def _run() -> dict:
        pw = await async_playwright().start()
        handles["pw"] = pw
        browser = await pw.chromium.launch(headless=True, args=[
            "--headless=new", "--disable-blink-features=AutomationControlled",
            "--no-sandbox", "--disable-dev-shm-usage"], timeout=30000)
        handles["browser"] = browser
        ctx = await browser.new_context(
            storage_state=state, user_agent=cqu_login.UA,
            viewport={"width": 1440, "height": 900},
            locale="zh-CN", timezone_id="Asia/Shanghai")
        # pattern -> {url,status,contentType,body};同 pattern 多次 fire 保留最后一次。
        captured: dict[str, dict] = {}

        async def _on_response(resp) -> None:
            pat = capture_match(resp.url, patterns)
            if pat is None:
                return
            try:
                body = await resp.text()
            except Exception:
                body = ""
            captured[pat] = {
                "url": resp.url,
                "status": resp.status,
                "contentType": resp.headers.get("content-type", ""),
                "body": body,
            }

        page = await ctx.new_page()
        page.on("response", lambda r: asyncio.create_task(_on_response(r)))
        try:
            await page.goto(nav_url, wait_until="domcontentloaded", timeout=25000)
        except Exception:
            pass
        # 等 capture 齐(或超时):页面有机 fire 是异步的,轮询 captured 覆盖期望集即提前结束。
        waited = 0
        while waited < CAPTURE_WAIT_MS and not all_captures_present(set(captured), patterns):
            await page.wait_for_timeout(CAPTURE_POLL_MS)
            waited += CAPTURE_POLL_MS

        # fetch[] 逐个 in-page GET(同源、带活 P、读豁免)。在页面上下文里 fetch,拿 VM 令牌豁免。
        fetches: list[dict] = []
        for f in fetch_list:
            url = f["url"]
            try:
                # 数据 API 是 Bearer-JWT 鉴权(非 cookie),credentials:'include' 不够;
                # 须从 localStorage 读 personal-prod token 加 Authorization 头(实测裸 GET 返 401/空)。
                # token 带首尾双引号(前端存储格式),strip 掉。AbortSignal 用 INPAGE_FETCH_TIMEOUT_MS 防挂。
                result = await page.evaluate(
                    """async ({ u, t }) => {
                        let tok = '';
                        try { tok = (localStorage.getItem('cqu_edu_ACCESS_TOKEN') || '').replace(/^"|"$/g, ''); } catch (e) {}
                        const headers = { 'Accept': 'application/json' };
                        if (tok) headers['Authorization'] = 'Bearer ' + tok;
                        const r = await fetch(u, { credentials: 'include', headers, signal: AbortSignal.timeout(t) });
                        return { status: r.status, body: await r.text() };
                    }""",
                    {"u": url, "t": INPAGE_FETCH_TIMEOUT_MS},
                )
                fetches.append({"url": url, "status": result["status"], "body": result["body"]})
            except Exception:
                fetches.append({"url": url, "status": 0, "body": ""})

        captures = [captured[p] for p in patterns if p in captured]
        return {"captures": captures, "fetches": fetches}

    # 复用取票的并发信号量(护节点资源)+ 等槽超时,与取票/探活共用同一槽。
    await asyncio.wait_for(
        cqu_ticket_browser.TICKET_SEMAPHORE.acquire(),
        timeout=cqu_ticket_browser.QUEUE_WAIT,
    )
    try:
        return await asyncio.wait_for(_run(), timeout=HARVEST_OVERALL_TIMEOUT)
    finally:
        cqu_ticket_browser.TICKET_SEMAPHORE.release()
        await cqu_ticket_browser._close_browser_driver(handles["browser"], handles["pw"])
