"""青果短效代理提取(国内来源调用)。acquire_qg_proxy() 在国内节点本地调提取 API,
拿一个重庆移动 server:port, 组成 patchright/httpx 用的 proxy 配置。账密走环境变量。"""
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


async def acquire_qg_proxy() -> dict:
    """返回 patchright proxy dict: {server, username, password}。
    任何"拿不到青果 IP"的情形(QG_ENABLED=0 / 网络错误/超时 / 非2xx / 畸形响应)
    都抛 QgExtractError, 由调用方按硬依赖处理(端点返回 5xx 让上游 DO 退避)。
    注: 缺 QG_AUTH_KEY/PWD 是配置错误, 故意不收口(让 KeyError fail loud)。"""
    if os.environ.get("QG_ENABLED", "1") == "0":
        raise QgExtractError("QG_ENABLED=0 (应急开关关闭)")
    base = os.environ.get("QG_EXTRACT_BASE", "https://share.proxy.qg.net/get")
    url = build_extract_url(base, os.environ["QG_AUTH_KEY"], os.environ.get("QG_AREA", "500100"))
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.get(url)
            r.raise_for_status()
            body = r.json()
    except (httpx.HTTPError, ValueError) as e:
        raise QgExtractError(f"qg extract request failed: {type(e).__name__}: {e}") from e
    server = parse_extract_response(body)
    return {"server": f"http://{server}",
            "username": os.environ["QG_AUTH_KEY"],
            "password": os.environ["QG_AUTH_PWD"]}
