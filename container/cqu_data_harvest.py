"""Organic harvest:在已登录 + 已过瑞数的临时浏览器里有机 fire 请求并截获响应。

my.cqu.edu.cn 全站瑞数化后,后端纯 HTTP POST 课表被 412 专守;唯一过墙是让真前端在
auth 已登录浏览器里导航 navUrl(页面自动 fire 课表/学期)+ 截获 capture 模式响应 +
对 fetch[] 跑 in-page GET(同源、读豁免)。本模块是 schedule 取数的通用原语,业务无关。

host 红线:navUrl/fetch[].url 解析出的 host 必须精确为直连应用或 aTrust 改写应用，且
一份 recipe 内必须同 host，防 auth 变开放代理(SSRF)。纯函数(host 校验 / recipe 解析 /
capture 匹配)抽出便于单测。
"""
import asyncio
import urllib.parse
from patchright.async_api import async_playwright
import browser_profile
import cqu_login  # UA / locale 等浏览器对抗参数,与取票统一
import cqu_ticket_browser  # 复用 _close_browser_driver / TICKET_SEMAPHORE / 超时常量

# harvest 只允许这两个目标 host(精确等于,绝不 endswith/in)。
HARVEST_HOSTS = {
    "my.cqu.edu.cn": "direct",
    "my-cqu-edu-cn-s.atrust.cqu.edu.cn": "atrust",
}
ATRUST_PORTAL_HOST = "atrust.cqu.edu.cn"
ATRUST_SSO_HOST = "sso-cqu-edu-cn-s.atrust.cqu.edu.cn"


def classify_harvest_host(url: str) -> str | None:
    """合法 harvest URL 返回 ``direct``/``atrust``，非法返回 None。"""
    if not url or "\\" in url:
        return None
    if any(ord(ch) < 0x20 or ord(ch) > 0x7e for ch in url):
        return None
    try:
        u = urllib.parse.urlparse(url)
    except Exception:
        return None
    if u.scheme != "https" or u.username or u.password:
        return None
    try:
        port = u.port
    except ValueError:
        return None
    if port is not None and port != 443:
        return None
    host = (u.hostname or "").lower()
    if not host or any(
        ch not in "abcdefghijklmnopqrstuvwxyz0123456789.-" for ch in host
    ):
        return None
    return HARVEST_HOSTS.get(host)


def is_harvest_host_allowed(url: str) -> bool:
    """非抛谓词：URL 是否属于两个精确允许 host 之一。"""
    return classify_harvest_host(url) is not None


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
    nav_kind = classify_harvest_host(nav_url) if isinstance(nav_url, str) else None
    if nav_kind is None:
        raise HarvestRecipeError("navUrl missing or host not allowed")
    nav_host = (urllib.parse.urlparse(nav_url).hostname or "").lower()

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
        raw_method = f.get("method")
        # method 缺省/None → 默认 GET;给定值必须是 str(防非字符串走到 .upper() 抛
        # AttributeError → server.py 回 500 而非契约错的 400)。bool 是 int 子类,
        # isinstance(True, str) 已为 False,会一并落入此 400 分支。
        if raw_method is None:
            method = "GET"
        elif isinstance(raw_method, str):
            method = raw_method.upper()
        else:
            raise HarvestRecipeError("fetch method must be GET")
        if method != "GET":  # 含 "" / "post" 等:非 GET 一律拒(不再被 `or` 静默吞成 GET)
            raise HarvestRecipeError("fetch method must be GET")
        url = f.get("url")
        fetch_kind = classify_harvest_host(url) if isinstance(url, str) else None
        if fetch_kind is None:
            raise HarvestRecipeError("fetch url missing or host not allowed")
        fetch_host = (urllib.parse.urlparse(url).hostname or "").lower()
        if fetch_host != nav_host:
            raise HarvestRecipeError("recipe URLs must use the same host")
        fetch.append({"method": "GET", "url": url})

    return {
        "navUrl": nav_url,
        "capture": list(capture),
        "fetch": fetch,
        "hostKind": nav_kind,
    }


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


# SSO/CAS 服务器自身 host(规范化小写)。storage_state 过期时 navUrl 会被重定向到这里的登录页。
_SSO_HOST = (urllib.parse.urlparse(cqu_login.SSO).hostname or "").lower()


class HarvestExpiredError(Exception):
    """会话(storage_state)过期 —— navUrl 落回 CAS 登录页, 无 capture 命中、fetch 401/空。

    server.py 据此回 409 {"error":"TGT_EXPIRED"}(对齐 /service-ticket 的 ExpiredError→409),
    让 DO 的 classifyNodeHarvestResponse 映射 TGT_EXPIRED → setAlarm 触发重登; 否则 harvest
    照常 ok:true 返回空数据, 重登路径永不触发, 会话静默失效。
    """


class AtrustHarvestExpiredError(Exception):
    """aTrust 独立会话落回门户或改写 SSO；只允许清理/重登 aTrust 状态。"""


def is_expired_harvest(captures: dict, page_content: str, page_url: str) -> bool:
    """无任何 capture 命中 **且** 页面看起来是 CAS 登录页 → 判会话过期(纯函数, 便于单测)。

    判据(任一即视为登录页):
      · page_content 含 cqu_ticket_browser.CAS_LOGIN_MARKERS 任一标记(与取票过期判定同口径); 或
      · page_url 的 host 精确等于 SSO host(cqu_login.SSO) —— 被重定向到登录入口。
    captures 非空(真过墙拿到数据)一律返回 False, 绝不误判。正常 my.cqu 页(无标记、非 SSO host)
    也返回 False —— 归瞬态由上游退避, 不当过期触发重登。
    """
    if captures:
        return False
    if any(mk in (page_content or "") for mk in cqu_ticket_browser.CAS_LOGIN_MARKERS):
        return True
    host = (urllib.parse.urlparse(page_url or "").hostname or "").lower()
    return host == _SSO_HOST


def classify_expired_harvest(
    captures: dict,
    page_content: str,
    page_url: str,
    host_kind: str,
) -> str | None:
    """按 recipe 的状态域区分直连 CAS 过期与 aTrust 独立会话过期。"""
    if captures:
        return None
    host = (urllib.parse.urlparse(page_url or "").hostname or "").lower()
    if host_kind == "atrust":
        if host in {ATRUST_PORTAL_HOST, ATRUST_SSO_HOST}:
            return "atrust_expired"
        return None
    return "expired" if is_expired_harvest(captures, page_content, page_url) else None


class HarvestTransientError(Exception):
    """navigate/WAF/网络瞬态 —— 期望 capture 没到齐, 但页面**不是** CAS 登录页(非干净过期)。

    成因: goto 超时 / 网络抖动 / 非 CAS 的瑞数挑战页(无登录标记)。此时绝不能当 ok 空 harvest
    返回(经 DO/RPC 报 200 假成功, 调用方误以为"今天没课"); server.py 据此回 502, 让上游退避重试
    下个周期, 与 409(过期重登)/400(配方错)三态严格区分。
    """


def _has_2xx(statuses: list[int]) -> bool:
    """fetch_statuses 里是否有任一 2xx(in-page GET 真拿到数据)。失败 fetch 记 status 0, 非 2xx。"""
    return any(200 <= s < 300 for s in statuses)


def classify_harvest_outcome(
    captured_keys: set[str],
    patterns: list[str],
    page_content: str,
    page_url: str,
    fetch_statuses: list[int] | None = None,
    host_kind: str = "direct",
) -> str:
    """navigate + capture-wait + fetch[] 后的三态判定(纯函数, 便于单测): "ok"/"expired"/"transient"。

    对 capture 配方与 **fetch-only 配方(patterns 为空)** 都鲁棒(P2 修复):fetch-only 时旧逻辑
    "patterns 空即 ok" 会把"goto 超时/会话过期(重定向 CAS)/fetch 全 401"也当 ok 空成功返回,
    DO 永不触发重登、调用方误以为"今天没课"。现按以下顺序判:

    1. **永远先判过期**: is_expired_harvest(captured, page_content, page_url) 为真 → "expired"
       (落回 CAS 登录页/SSO host 一律过期, 不论是否期望 capture; captured 非空时该函数恒 False)。
    2. **capture 配方**(patterns 非空): 全齐 → "ok"; 否则 → "transient"(瞬态退避)。
    3. **fetch-only 配方**(patterns 为空): 至少一个 fetch 返 2xx → "ok"(真拿到数据);
       否则(空列表/全部非 2xx/全失败)→ "transient"(没拿到任何可用数据, 退避而非假成功)。

    fetch_statuses 为各 in-page fetch 的 HTTP status(失败记 0); 仅 fetch-only 分支用到,
    capture 配方传 None/省略即可(保持既有调用与单测不变)。
    """
    captured = {k: True for k in captured_keys}  # is_expired_harvest 只看 truthy/empty
    expired = classify_expired_harvest(
        captured, page_content, page_url, host_kind
    )
    if expired is not None:
        return expired
    if patterns:
        return "ok" if all_captures_present(captured_keys, patterns) else "transient"
    # fetch-only: 只有至少一个 2xx 才算真成功, 否则瞬态退避。
    return "ok" if _has_2xx(fetch_statuses or []) else "transient"


# 导航后等页面有机 fire 完 capture 的盲等上限(ms):课表 POST(my-table-detail)+ 学期
# 由 /workspace/curriculum 自动 fire,实测百毫秒级到齐;给足 8s 容瑞数当场重算/重定向。
CAPTURE_WAIT_MS = browser_profile.CAPTURE_WAIT_MS
CAPTURE_POLL_MS = 150
# 单个 in-page fetch 的超时(ms):同源 GET 读豁免,正常亚秒级。
INPAGE_FETCH_TIMEOUT_MS = browser_profile.INPAGE_FETCH_TIMEOUT_MS
# harvest 整段执行上限(秒):navigate 过瑞数 + 等 capture + 跑 fetch[]。复用取票 overall_timeout 量级。
HARVEST_OVERALL_TIMEOUT = browser_profile.HARVEST_OVERALL_TIMEOUT_S


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
            await page.goto(nav_url, wait_until="domcontentloaded", timeout=browser_profile.HARVEST_NAV_TIMEOUT_MS)
        except Exception:
            pass
        # 等 capture 齐(或超时):页面有机 fire 是异步的,轮询 captured 覆盖期望集即提前结束。
        waited = 0
        while waited < CAPTURE_WAIT_MS and not all_captures_present(set(captured), patterns):
            await page.wait_for_timeout(CAPTURE_POLL_MS)
            waited += CAPTURE_POLL_MS

        # fetch[] 逐个 in-page GET(同源、带活 P、读豁免)。在页面上下文里 fetch,拿 VM 令牌豁免。
        # fetch-only 配方靠这些 fetch 的 status 判 ok/transient(见下 classify_harvest_outcome),
        # 故必须在三态闸前先跑完(失败/超时记 status 0)。
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

        # navigate + capture-wait + fetch[] 后三态闸(classify_harvest_outcome): 绝不能把会话过期/
        # 导航失败/fetch 全 401 当 ok 空 harvest 返回(经 DO/RPC 报 200 假成功)。对 capture 配方
        # **和 fetch-only 配方(capture 期望为空)都鲁棒** —— 后者旧逻辑"patterns 空即 ok"会让会话
        # 静默失效(P2)。仅在无成功 capture 时才 await page.content()(避免 happy path 拉整页开销):
        #   · capture 全齐 / fetch-only 有 2xx → "ok", 照常返回 captures+fetches。
        #   · 落回 CAS 登录页/SSO host(永远先判)→ "expired" → HarvestExpiredError(server 409 → DO 重登)。
        #   · 其余没拿到可用数据(capture 缺且非登录页 / fetch-only 全非 2xx)→ "transient"
        #     → HarvestTransientError(server 502 → 上游退避), 而非伪装成 ok 空成功。
        fetch_statuses = [f["status"] for f in fetches]
        page_content = "" if captured else await page.content()
        outcome = classify_harvest_outcome(
            set(captured), patterns, page_content, page.url, fetch_statuses,
            host_kind=recipe.get("hostKind", "direct"),
        )
        if outcome == "atrust_expired":
            raise AtrustHarvestExpiredError(
                "navUrl redirected to aTrust login (session expired)"
            )
        if outcome == "expired":
            raise HarvestExpiredError("navUrl redirected to CAS login (session expired)")
        if outcome == "transient":
            raise HarvestTransientError(
                "no usable harvest data (navigation/WAF/network/session transient)")

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
