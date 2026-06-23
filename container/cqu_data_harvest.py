"""Organic harvest:在已登录 + 已过瑞数的临时浏览器里有机 fire 请求并截获响应。

my.cqu.edu.cn 全站瑞数化后,后端纯 HTTP POST 课表被 412 专守;唯一过墙是让真前端在
auth 已登录浏览器里导航 navUrl(页面自动 fire 课表/学期)+ 截获 capture 模式响应 +
对 fetch[] 跑 in-page GET(同源、读豁免)。本模块是 schedule 取数的通用原语,业务无关。

host 红线:navUrl/capture(同源相对或绝对)/fetch[].url 解析出的 host 必须精确为
my.cqu.edu.cn —— 比取票的 *.cqu.edu.cn 收得更紧(harvest 只打这一个 host),防 auth 变
开放代理(SSRF)。纯函数(host 校验 / recipe 解析 / capture 匹配)抽出便于单测。
"""
import urllib.parse

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
