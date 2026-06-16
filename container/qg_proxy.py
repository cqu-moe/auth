"""青果代理提取(国内来源调用)。acquire_qg_proxy(profile) 在国内节点本地调提取 API,
拿一个重庆移动 server:port, 组成 patchright/httpx 用的 proxy 配置。账密走环境变量。

成本优化: 分两个青果套餐(各一独立 Authkey, 按 profile 选 key 区分):
  - "short"(1 分钟包, 便宜): 高频取票/keepalive
  - "login"(15 分钟包): 需 ~11 分钟的登录(未配独立 key 时回退到 short 套餐 key)
should_use_proxy(profile) 是灰度门: 控制每路走青果还是节点直连(直连省钱)。"""
import os
import urllib.parse
from typing import Literal

import httpx

# profile 闭集: 仅 "login"(15 分钟登录包) / "short"(1 分钟高频包)。两个被 profile 驱动的
# 函数(acquire_qg_proxy / should_use_proxy)开头都用它守卫, 消除「_select_credentials 把未知
# profile 静默当 short, 而 should_use_proxy 用 profile.upper() 读到不存在的 env」这种不一致。
_VALID_PROFILES = ("login", "short")


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
    - "login"(15 分钟包, 给 ~11 分钟的登录): QG_AUTH_KEY_LOGIN/QG_AUTH_PWD_LOGIN。
      **all-or-nothing**: 这对 key/pwd 要么都配(用登录包)、要么都不配(整对回退短效包),
      绝不混 —— 两个青果套餐是不同账号, key/pwd 跨账号混用会让代理鉴权必失败。只配其一
      (如只配 KEY_LOGIN 没配 PWD_LOGIN)→ 抛 KeyError fail loud, 不静默拿登录包 key 配短效包 pwd。
      空串(""/falsy)视为未设, 走回退分支。
    - 其它(含 "short", 1 分钟包, 给高频取票/keepalive): QG_AUTH_KEY/QG_AUTH_PWD。
    缺 QG_AUTH_KEY/QG_AUTH_PWD 是配置错误, 让 KeyError fail loud, 不收口。"""
    if profile == "login":
        login_key = os.environ.get("QG_AUTH_KEY_LOGIN")
        login_pwd = os.environ.get("QG_AUTH_PWD_LOGIN")
        if login_key and login_pwd:
            return login_key, login_pwd
        if login_key or login_pwd:
            raise KeyError(
                "QG_AUTH_KEY_LOGIN 与 QG_AUTH_PWD_LOGIN 必须成对配置(或都不配以回退短效包); "
                "只配其一会拿登录包 key 配短效包 pwd(跨账号), 代理鉴权必失败"
            )
        # 都未设(或都为空串)→ 回退短效包整对(不混)
    return os.environ["QG_AUTH_KEY"], os.environ["QG_AUTH_PWD"]


def should_use_proxy(profile: Literal["login", "short"]) -> bool:
    """是否该走青果(返回 False 则节点直连 CQU, 省青果钱; 部署时灰度验证用)。

    两路分别由 QG_PROXY_LOGIN / QG_PROXY_SHORT 控制(profile.upper() 拼环境变量名);
    QG_ENABLED 是总开关(0=强制全部直连, 应急降级)。
    任一开关 == "0" 视为关; 其余值(含未设)默认走青果 → 默认全开。
    profile 必属闭集 _VALID_PROFILES, 否则 ValueError(防拼一个不存在的 QG_PROXY_BOGUS)。"""
    if profile not in _VALID_PROFILES:
        raise ValueError(f"unknown profile: {profile!r}")
    if os.environ.get("QG_ENABLED", "1") == "0":
        return False
    return os.environ.get(f"QG_PROXY_{profile.upper()}", "1") != "0"


async def acquire_qg_proxy(profile: Literal["login", "short"] = "short") -> dict:
    """按 profile 取一个青果 IP, 返回 patchright proxy dict: {server, username, password}。
    profile 选套餐 Authkey/pwd(见 _select_credentials)。职责纯粹是「按 profile 取一个青果 IP」:
    任何"拿不到青果 IP"的情形(网络错误/超时 / 非2xx / 畸形响应)都抛 QgExtractError,
    由调用方按硬依赖处理(端点返回 5xx 让上游 DO 退避)。
    走/不走青果的灰度门控见 should_use_proxy, acquire 本身不查 QG_ENABLED。
    profile 必属闭集 _VALID_PROFILES, 否则 ValueError(在触网前就拒, 不静默当 short)。
    注: 缺 QG_AUTH_KEY/PWD 是配置错误, 故意不收口(让 KeyError fail loud)。"""
    if profile not in _VALID_PROFILES:
        raise ValueError(f"unknown profile: {profile!r}")
    key, pwd = _select_credentials(profile)
    base = os.environ.get("QG_EXTRACT_BASE", "https://share.proxy.qg.net/get")
    url = build_extract_url(base, key, os.environ.get("QG_AREA", "500100"))
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.get(url)
            r.raise_for_status()
            body = r.json()
    except httpx.HTTPStatusError as e:
        # 脱敏: 提取 URL 含 key=<QG_AUTH_KEY>(Authkey 密钥), raise_for_status 的 str(e) 会带
        # 完整 URL, 直接拼 str(e) 会把 Authkey 泄露进日志/上游 DO 响应。只报状态码, 不带 URL/str(e);
        # from None 断异常链(防 traceback/exc_info 里 __cause__ 那条带 URL 的原始异常再泄露)。
        raise QgExtractError(f"qg extract HTTP {e.response.status_code}") from None
    except (httpx.HTTPError, ValueError) as e:
        # 网络层/JSON 解析错误: 只报异常类型, 不拼 str(e)(可能含含密钥的 URL); from None 断链。
        raise QgExtractError(f"qg extract request failed: {type(e).__name__}") from None
    server = parse_extract_response(body)
    return {"server": f"http://{server}",
            "username": key,
            "password": pwd}
