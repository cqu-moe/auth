#!/usr/bin/env python3
"""国内节点取 service ticket(ST) —— httpx 经青果代理换票。
=============================================================================
铁律: 所有连 CQU 的出站一律经青果(让 CQU 只看到动态重庆移动 IP)。取 ST 也是
「连 CQU」, 故这一跳从国内节点发起、经青果出站。

职责边界(只做「换票」, 不做「闸」):
  · 本模块只负责: 拿 DO 给的、已校验过的 serviceUrl + 3 个 cookie, 经青果去 CQU
    的 CAS `/login?service=...` 端点换一张 ST, 抓到返回, 抓不到抛明确异常。
  · 取票的全部安全闸(serviceUrl host 校验 / cqu.quicklogin opt-in / 限流 / 审计)
    仍留在 Cloudflare DO 侧(src/durable-objects/cqu-session.ts), 不迁到这里。

复刻来源: src/services/cqu-sso.ts 的 `mintServiceTicketOnce`。
  · 请求: GET https://sso.cqu.edu.cn/login?service=<urlencode(serviceUrl)>,
    带浏览器 UA + 3 个 cookie(SOURCEID_TGC / SESSION / rg_objectid)。
  · TS 用 redirect:"manual" 读 302 的 Location 抓 ticket=ST-...; 这里改用
    follow_redirects=True, 从重定向历史 + 最终 URL 里抓 ST(更稳: ST 可能出现在
    任意一跳的 URL 里), 二者等价。
  · 会话过期判别: 抓不到 ST 且最终落回 CAS 登录页(login-croypto/login-page-flowkey
    特征) → 判 SESSION_EXPIRED; 否则判 NO_TICKET(疑似瑞数误判/未知页)。
"""
import re
import urllib.parse

import httpx

from cqu_login import UA, WANTED_COOKIES, extract_ticket  # 复用 ST 正则 + cookie 名

SSO = "https://sso.cqu.edu.cn"
# 取票请求的硬超时(秒): 连接被 CF→CQU 网络挂起时不至于一直占着请求路径。
FETCH_TIMEOUT = 15

# 落回 CAS 登录页的特征串(对齐 cqu-sso.ts classifyNon302Body 的 cas-login 判据):
# 出现任一即认定「真过期, 回到了登录页」。
CAS_LOGIN_MARKERS = ("login-croypto", "login-page-flowkey")


class TicketError(Exception):
    """取 ST 失败。code 区分语义, 供端点映射 HTTP 状态码:
      · "SESSION_EXPIRED": 会话过期, 落回 CAS 登录页 → 交 DO/容器重登(端点 409)。
      · "NO_TICKET":       未抓到 ST 且非登录页(疑似瑞数误判/未知页)→ 可重试(端点 502)。
    """

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def build_service_login_url(service_url: str) -> str:
    """组 CAS 取票 URL: <SSO>/login?service=<urlencode(service_url)>。
    与 cqu-sso.ts `${SSO_BASE}/login?service=${encodeURIComponent(serviceUrl)}` 对齐。"""
    return f"{SSO}/login?service={urllib.parse.quote(service_url, safe='')}"


def select_cookies(cookies: dict) -> dict:
    """从入参里挑出后端要的 3 个 CQU SSO cookie(SOURCEID_TGC/SESSION/rg_objectid),
    丢弃其余, 缺任一抛 TicketError("MISSING_COOKIE")。纯逻辑, 便于单测。"""
    selected = {}
    missing = []
    for name in WANTED_COOKIES:
        val = (cookies or {}).get(name)
        if not val:
            missing.append(name)
        else:
            selected[name] = val
    if missing:
        raise TicketError("MISSING_COOKIE", f"missing CQU SSO cookie(s): {', '.join(missing)}")
    return selected


def collect_response_urls(response: "httpx.Response") -> list[str]:
    """收齐一次 follow-redirects 请求里出现过的所有 URL(重定向历史 + 最终), 供 ST 提取。
    ST 出现在某一跳的 Location(即下一跳的请求 URL)里, 全收最稳。纯逻辑, 便于单测。"""
    urls = [str(r.url) for r in response.history]
    urls.append(str(response.url))
    return urls


def looks_like_cas_login(text: str) -> bool:
    """页面正文是否含 CAS 登录页特征 → 判会话过期(落回登录页)。
    对齐 cqu-sso.ts classifyNon302Body 的 cas-login 分支。纯逻辑, 便于单测。"""
    return any(m in (text or "") for m in CAS_LOGIN_MARKERS)


def _proxy_url(proxy: dict) -> str:
    """把 acquire_qg_proxy() 的 {server:"http://ip:port", username, password} 组成
    httpx 0.28 单 `proxy=` 参数要的带账密 URL: http://user:pass@ip:port。
    server 已带 scheme, 把账密注入 netloc 即可(对 user/pass 做 URL 编码)。"""
    parts = urllib.parse.urlsplit(proxy["server"])
    user = urllib.parse.quote(proxy["username"], safe="")
    pwd = urllib.parse.quote(proxy["password"], safe="")
    return urllib.parse.urlunsplit(
        (parts.scheme, f"{user}:{pwd}@{parts.netloc}", parts.path, parts.query, parts.fragment)
    )


async def fetch_service_ticket(service_url: str, cookies: dict, proxy: dict) -> str:
    """凭 3 个 cookie, 经青果 proxy 去 CQU CAS 换一张 ST。

    复刻 cqu-sso.ts mintServiceTicketOnce: 浏览器 UA + 3 cookie, GET
    /login?service=<service_url>, follow redirects, 从重定向历史/最终 URL 抓 ST-...。

    返回 ST 字符串(形如 "ST-...")。抓不到时:
      · 落回 CAS 登录页(login-croypto 等特征)→ TicketError("SESSION_EXPIRED")。
      · 否则 → TicketError("NO_TICKET")。
    """
    cookie_jar = select_cookies(cookies)
    url = build_service_login_url(service_url)
    async with httpx.AsyncClient(
        proxy=_proxy_url(proxy),
        timeout=FETCH_TIMEOUT,
        follow_redirects=True,
        headers={"User-Agent": UA},
    ) as client:
        resp = await client.get(url, cookies=cookie_jar)

    ticket = extract_ticket(collect_response_urls(resp))
    if ticket:
        return ticket

    # 抓不到 ST: 区分「真过期(落回登录页)」与「未知/疑似误判」。
    body = resp.text or ""
    if looks_like_cas_login(body):
        raise TicketError(
            "SESSION_EXPIRED",
            f"no ST: fell back to CAS login page (session expired), final_url={str(resp.url)[:80]}",
        )
    raise TicketError(
        "NO_TICKET",
        f"no ST in redirect chain (likely WAF/throttle or unknown page), final_url={str(resp.url)[:80]}",
    )
