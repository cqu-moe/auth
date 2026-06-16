"""青果代理提取(国内来源调用)。acquire_qg_proxy(profile) 在国内节点本地调提取 API,
拿一个重庆移动 server:port, 组成 patchright/httpx 用的 proxy 配置。账密走环境变量。

成本优化: 分两个青果套餐(各一独立 Authkey, 按 profile 选 key 区分):
  - "short"(1 分钟包, 便宜): 高频取票/keepalive
  - "login"(15 分钟包): 需 ~11 分钟的登录(未配独立 key 时回退到 short 套餐 key)
should_use_proxy(profile) 是灰度门: 控制每路走青果还是节点直连(直连省钱)。"""
import os
import urllib.parse

import httpx


class QgExtractError(Exception):
    pass


def build_extract_url(base: str, key: str, area: str) -> str:
    q = urllib.parse.urlencode({
        "key": key, "num": 1, "area": area, "isp": 0,
        "format": "json", "distinct": "true",
    })
    return f"{base}?{q}"


def parse_extract_response(body: dict) -> str:
    if body.get("code") != "SUCCESS":
        raise QgExtractError(f"qg extract not SUCCESS: {body.get('code')!r}")
    data = body.get("data") or []
    first = data[0] if data and isinstance(data[0], dict) else {}
    if not first.get("server"):
        raise QgExtractError("qg extract returned no server")
    return first["server"]


def _select_credentials(profile: str) -> tuple[str, str]:
    """按 profile 选青果套餐的 (Authkey, pwd)。两个套餐各一独立 Authkey, 提取时靠选 key 区分:
    - "login"(15 分钟包, 给 ~11 分钟的登录): QG_AUTH_KEY_LOGIN/QG_AUTH_PWD_LOGIN,
      未设(None/空)则回退到 QG_AUTH_KEY/QG_AUTH_PWD(单套餐部署也能跑)。
    - 其它(含 "short", 1 分钟包, 给高频取票/keepalive): QG_AUTH_KEY/QG_AUTH_PWD。
    缺 QG_AUTH_KEY/QG_AUTH_PWD 是配置错误, 让 KeyError fail loud, 不收口。"""
    if profile == "login":
        key = os.environ.get("QG_AUTH_KEY_LOGIN") or os.environ["QG_AUTH_KEY"]
        pwd = os.environ.get("QG_AUTH_PWD_LOGIN") or os.environ["QG_AUTH_PWD"]
        return key, pwd
    return os.environ["QG_AUTH_KEY"], os.environ["QG_AUTH_PWD"]


def should_use_proxy(profile: str) -> bool:
    """是否该走青果(返回 False 则节点直连 CQU, 省青果钱; 部署时灰度验证用)。

    两路分别由 QG_PROXY_LOGIN / QG_PROXY_SHORT 控制(profile.upper() 拼环境变量名);
    QG_ENABLED 是总开关(0=强制全部直连, 应急降级)。
    任一开关 == "0" 视为关; 其余值(含未设)默认走青果 → 默认全开。"""
    if os.environ.get("QG_ENABLED", "1") == "0":
        return False
    return os.environ.get(f"QG_PROXY_{profile.upper()}", "1") != "0"


async def acquire_qg_proxy(profile: str = "short") -> dict:
    """按 profile 取一个青果 IP, 返回 patchright proxy dict: {server, username, password}。
    profile 选套餐 Authkey/pwd(见 _select_credentials)。职责纯粹是「按 profile 取一个青果 IP」:
    任何"拿不到青果 IP"的情形(网络错误/超时 / 非2xx / 畸形响应)都抛 QgExtractError,
    由调用方按硬依赖处理(端点返回 5xx 让上游 DO 退避)。
    走/不走青果的灰度门控见 should_use_proxy, acquire 本身不查 QG_ENABLED。
    注: 缺 QG_AUTH_KEY/PWD 是配置错误, 故意不收口(让 KeyError fail loud)。"""
    key, pwd = _select_credentials(profile)
    base = os.environ.get("QG_EXTRACT_BASE", "https://share.proxy.qg.net/get")
    url = build_extract_url(base, key, os.environ.get("QG_AREA", "500100"))
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.get(url)
            r.raise_for_status()
            body = r.json()
    except (httpx.HTTPError, ValueError) as e:
        raise QgExtractError(f"qg extract request failed: {type(e).__name__}: {e}") from e
    server = parse_extract_response(body)
    return {"server": f"http://{server}",
            "username": key,
            "password": pwd}
