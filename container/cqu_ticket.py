#!/usr/bin/env python3
"""国内节点取 service ticket(ST) —— httpx 换票, 出站默认经青果、灰度可节点直连。
=============================================================================
出站策略: 默认经青果(让 CQU 只看到动态重庆移动 IP); `proxy=None` 时改**节点直连**
(成都境内节点 IP 直连 CQU, 省青果配额)。走/不走青果由上游灰度门(qg_proxy.should_use_proxy,
开关 QG_PROXY_*/QG_ENABLED)决定, 本模块只按入参 proxy 是否为真选路, 不自行决策。

职责边界(只做「换票」, 不做「闸」):
  · 本模块只负责: 拿 DO 给的、已校验过的 serviceUrl + 3 个 cookie, 经青果去 CQU
    的 CAS `/login?service=...` 端点换一张 ST, 抓到返回, 抓不到抛明确异常。
  · 取票的全部安全闸(serviceUrl host 校验 / cqu.quicklogin opt-in / 限流 / 审计)
    仍留在 Cloudflare DO 侧(src/durable-objects/cqu-session.ts), 不迁到这里。

复刻来源: src/services/cqu-sso.ts 的 `mintServiceTicketOnce`。
  · 请求: GET https://sso.cqu.edu.cn/login?service=<urlencode(serviceUrl)>,
    带浏览器 UA + 3 个 cookie(SOURCEID_TGC / SESSION / rg_objectid)。
  · TS 用 redirect:"manual" 读 302 的 Location 抓 ticket=ST-...; 这里同样
    follow_redirects=False, 只从 302 的 Location 头抓 ST, **绝不跟随**。ST 单次有效,
    跟随会真的对 serviceUrl 发请求 → 目标服务在那次回调里就把这张票校验/消费掉, 抓到即废票。
  · 会话过期判别: 抓不到 ST 且最终落回 CAS 登录页(login-croypto/login-page-flowkey
    特征) → 判 SESSION_EXPIRED; 否则判 NO_TICKET(疑似瑞数误判/未知页)。
"""
import asyncio
import re
import urllib.parse

import httpx

from cqu_login import UA, WANTED_COOKIES, extract_ticket  # 复用 ST 正则 + cookie 名

SSO = "https://sso.cqu.edu.cn"
# 取票请求的硬超时(秒): 连接被 CF→CQU 网络挂起时不至于一直占着请求路径。
FETCH_TIMEOUT = 15

# ── 取 ST 的瞬态退避重试参数(对齐 src/services/cqu-sso.ts getServiceTicket) ───────
# TS 侧 ST_MAX_ATTEMPTS=3 / ST_BASE_BACKOFF_MS=400(指数: 400ms, 800ms)。这里把同样的
# 重试韧性搬到国内节点, 关键差异: **同一青果 IP 全程复用、不重抽**(省青果配额)。
ST_MAX_ATTEMPTS = 3
ST_BASE_BACKOFF_S = 0.4
# 可重试的 TicketError 码: 只含 NO_TICKET(疑似瑞数误判/未知页/「302 但 Location 无 ticket=」/瞬态)。
# 注: 节点的 NO_TICKET 覆盖 TS 侧的 WAF_CHALLENGE(非登录页且没票)+ NO_TICKET(302 但 Location 无 ticket=),
# 二者皆瞬态(瑞数误判/限流), 都重试; 与 cqu-sso.ts isRetryableSsoError(重试 NETWORK_ERROR + WAF_CHALLENGE)
# 同向。SESSION_EXPIRED(真过期, 重试也是同样过期)与 MISSING_COOKIE(契约错, 重试无意义)不在其列。
RETRYABLE_TICKET_CODES = frozenset({"NO_TICKET"})

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


async def fetch_service_ticket(service_url: str, cookies: dict, proxy: dict | None) -> str:
    """凭 3 个 cookie 去 CQU CAS 换一张 ST。

    出站路径由 proxy 决定(灰度门 should_use_proxy 控制, 见 qg_proxy.py):
      · proxy 为青果 dict({server,username,password}) → 经青果出站(CQU 只看到动态重庆移动 IP)。
      · proxy is None → **节点直连**(不经青果): 成都境内节点 IP 直连 CQU, 省青果配额(成本优化灰度)。

    复刻 cqu-sso.ts mintServiceTicketOnce: 浏览器 UA + 3 cookie, GET
    /login?service=<service_url>, 不跟随 302, 从 Location 头抓 ST(ST 单次有效,
    跟随会被目标服务消费)。

    返回 ST 字符串(形如 "ST-...")。抓不到时:
      · 落回 CAS 登录页(login-croypto 等特征)→ TicketError("SESSION_EXPIRED")。
      · 否则 → TicketError("NO_TICKET")。
    """
    cookie_jar = select_cookies(cookies)
    url = build_service_login_url(service_url)
    async with httpx.AsyncClient(
        proxy=_proxy_url(proxy) if proxy is not None else None,
        timeout=FETCH_TIMEOUT,
        follow_redirects=False,   # ST 单次有效: 绝不跟随 CAS 302 到 serviceUrl(跟随=目标服务消费掉票)
        headers={"User-Agent": UA},
        trust_env=False,  # 不读环境 HTTP(S)_PROXY/ALL_PROXY/.netrc: proxy=None 时确保真直连
                          # (节点境内 IP), proxy 给定时只用我们传的青果代理, 杜绝环境变量悄改出口 IP。
    ) as client:
        resp = await client.get(url, cookies=cookie_jar)

    # CAS 取票成功 = 302 重定向到 serviceUrl?ticket=ST-...。只从 Location 抓票, 不跟随
    # (对齐 cqu-sso.ts mintServiceTicketOnce 的 redirect:"manual"; ST 单次有效, 跟随会被目标服务消费)。
    if resp.status_code in (301, 302, 303, 307, 308):
        location = resp.headers.get("location", "")
        ticket = extract_ticket([location])
        if ticket:
            return ticket
        raise TicketError("NO_TICKET", f"redirect without ticket=ST in Location: {location[:80]}")

    # 非重定向(多为 200 登录页): 落回 CAS 登录页 = 真过期; 否则未知/疑似瑞数误判。
    body = resp.text or ""
    if looks_like_cas_login(body):
        raise TicketError(
            "SESSION_EXPIRED",
            f"no ST: fell back to CAS login page (session expired), status={resp.status_code}",
        )
    raise TicketError("NO_TICKET", f"no ST, non-redirect status={resp.status_code}")


async def fetch_service_ticket_retrying(
    service_url: str,
    cookies: dict,
    proxy: dict | None,
    *,
    max_attempts: int = ST_MAX_ATTEMPTS,
    base_backoff_s: float = ST_BASE_BACKOFF_S,
) -> str:
    """带「同青果 IP 瞬态退避重试」的取 ST —— 把 cqu-sso.ts getServiceTicket 的重试韧性搬到节点端。

    proxy 原样透传给每次 fetch_service_ticket(支持青果 dict 经青果 / None 节点直连): 重试对
    「直连」即「同节点 IP 重试」, 对「经青果」即「同青果 IP 重试」, 语义自洽(均不换出口 IP)。

    背景: 取 ST 这一跳偶发瞬态失败 —— 瑞数 WAF 误判(返回非登录页但也没 ST)、CF→CQU 网络
    抖动(连接重置/超时)。原本 cqu-sso.ts 在 CF 侧用 3 次指数退避(400ms→800ms)兜底; 出站迁到
    国内节点后, 把这层重试也搬到这里, 让节点端自愈瞬态, 减少上抛给 DO 的 502。

    与 TS 侧的关键差异 —— **同一 proxy 全程复用, 不重抽青果**:
      · proxy 是入参(server/username/password), 重试时原样传给每次 fetch_service_ticket,
        **绝不调 acquire_qg_proxy() 重新提取青果 IP** —— 重抽会烧青果配额(短效住宅代理按提取计费),
        且换 IP 反而可能落到另一个被风控的出口, 瞬态自愈用同 IP 重试即可。

    重试判据(对齐 cqu-sso.ts isRetryableSsoError, 它重试 NETWORK_ERROR + WAF_CHALLENGE):
      · TicketError code=="NO_TICKET": 可重试。节点的 NO_TICKET 含两种瞬态: 非登录页且没票(≡ TS 的
        WAF_CHALLENGE, 疑似瑞数误判/限流), 以及「302 但 Location 无 ticket=」; 均当瞬态自愈重试。
      · httpx.HTTPError 及其子类(超时/连接重置等网络层): 可重试。
      · TicketError("SESSION_EXPIRED"): **不重试** —— 真过期, 重试也是同样过期(徒增青果出站 + 风控
        面)。立即上抛, 让端点映射 409 交 DO/容器重登。
      · TicketError("MISSING_COOKIE") 等其它码: **不重试** —— 契约错, 重试无意义, 立即上抛。

    退避: 非末次失败后 sleep base_backoff_s * 2**(attempt-1)(默认 0.4s→0.8s, 同 TS 的 400ms→800ms)。
    耗尽 max_attempts 仍失败 → 抛最后一次的异常(TicketError 或 httpx.HTTPError), 由端点按现有映射处理
    (NO_TICKET→502 / 网络错→502 / SESSION_EXPIRED 在上面已提前上抛→409)。

    返回 ST 字符串(形如 "ST-...")。
    """
    last_exc: BaseException | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            return await fetch_service_ticket(service_url, cookies, proxy)
        except TicketError as e:
            # 不可重试码(SESSION_EXPIRED/MISSING_COOKIE 等)立即上抛, 不浪费重试。
            if e.code not in RETRYABLE_TICKET_CODES:
                raise
            last_exc = e
        except httpx.HTTPError as e:
            # 网络层瞬态(超时/连接重置等)可重试 —— 同 proxy 再试一次。
            last_exc = e
        # 非末次才退避(指数), 同青果 IP 重试。
        if attempt < max_attempts:
            await asyncio.sleep(base_backoff_s * 2 ** (attempt - 1))
    # 耗尽仍失败: 抛最后一次的异常(必非 None: 走到这里说明每次循环都设了 last_exc)。
    raise last_exc
