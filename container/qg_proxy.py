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
    if not data or not data[0].get("server"):
        raise QgExtractError("qg extract returned no server")
    return data[0]["server"]


async def acquire_qg_proxy() -> dict:
    """返回 patchright proxy dict: {server, username, password}。
    QG_ENABLED=0 时抛 QgExtractError(由调用方按硬依赖处理: 端点返回 5xx)。"""
    if os.environ.get("QG_ENABLED", "1") == "0":
        raise QgExtractError("QG_ENABLED=0 (应急开关关闭)")
    base = os.environ.get("QG_EXTRACT_BASE", "https://share.proxy.qg.net/get")
    url = build_extract_url(base, os.environ["QG_AUTH_KEY"], os.environ.get("QG_AREA", "500100"))
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.get(url)
        server = parse_extract_response(r.json())
    return {"server": f"http://{server}",
            "username": os.environ["QG_AUTH_KEY"],
            "password": os.environ["QG_AUTH_PWD"]}
