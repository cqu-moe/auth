#!/usr/bin/env python3
"""
重庆大学统一身份认证 —— 脚本化登录 (patchright 驱动, 2026-06-11 实测打通)
==========================================================================
适用: sso.cqu.edu.cn 2026-06-10「增强登录」(密码 + 短信/邮件二次验证), 前置瑞数 Botgate WAF (6 代)。

【架构 / 为什么这样 —— 全部 2026-06-11 实测, 见 notes.md 逆向记录】
  整夜逐一排除后, 唯一走得通的路是「单浏览器会话 + 表单导航式提交」:

    正常全量加载登录页(Angular 完整, 活跃 P)
      └→ 注入原始 <form> 走【文档导航式】提交第一因素(密码)
            · 关键: 文档导航 POST 被瑞数当普通页面跳转放行 → 200 到 2FA
            · 对照: Angular 自己的 XHR 提交 POST /login → 必被瑞数判 400(整夜的坑)
      └→ 2FA 页在同一浏览器里完整渲染(短信/邮件/微信 tab 齐)
      └→ 切短信(或邮件) tab → 原生点「获取验证码」
            · 发码 XHR 由浏览器瑞数 VM 自带 CAqWHAeT → 200 发出
            · 对照: 纯请求(urllib/httpx)打任何发码端点(/api/ 或 /linkid/, sms 或 mail) → 必 412
      └→ [取 6 位验证码: CLI 走 read_code(); 容器走 code_provider()]
      └→ 注入 <form> 文档导航式提交验证码(type=smsLogin/mailLogin) → 302 带 ST ticket
      └→ 抓 ticket + 导出 storage_state(cookie/localStorage, 供子系统复用)

  已验证为【死路】, 勿再走(详见 notes.md):
    · 纯请求重放发码端点 → 412(瑞数专守"发验证码"动作, 换 /linkid/ 镜像/加密头均无效)
    · 浏览器 Angular-XHR 第一因素 → 400(活跃 P 也 400; pristine P 仅纯请求重放有效)
    · 把纯请求拿到的 2FA SESSION 注入浏览器 → 渲染不出 2FA 页(浏览器导航刷新 SESSION)
    · 浏览器当 CAqWHAeT oracle(注入式 XHR open) → 瑞数不给注入式 XHR 加后缀

唯一人工步骤: 二次验证码(短信/邮件)由你实时读取并输入。
容器化(aiohttp server.py)时, 验证码由 /code 端点经 code_provider 推入, 替代 read_code 文件轮询。

依赖:
    pip install patchright pycryptodome
    patchright install chromium

CLI 用法(仍可独立运行):
    python cqu_login.py                                   # 交互式(短信)
    python cqu_login.py --username 20201234 --method mail # 邮件验证码
    python cqu_login.py --service <CAS回调URL>            # 指定子系统
    python cqu_login.py --out cqu_session.json            # 导出会话到指定文件
    python cqu_login.py --code-file /tmp/code.txt         # 非交互: 发码后轮询该文件取验证码(自动化/后台)
    python cqu_login.py --stop-before-code                # 只验证到发码(发1条短信后停, 不提交)

容器入口:
    await run_login(student_id, password, service, method, code_provider) -> dict
    返回 {"state": <patchright storage_state 完整对象, 含 cookies + localStorage>, "ticket": "ST-..."}
"""
import argparse
import asyncio
import getpass
import os
import random
import re
import sys
import time
import urllib.parse

import browser_profile
from patchright.async_api import async_playwright

SSO = "https://sso.cqu.edu.cn"
DEFAULT_SERVICE = "https://my.cqu.edu.cn/authserver/authentication/cas"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

# 浏览器登录器要回收的 3 个 CQU SSO cookie(对齐后端 CasCookies)。
WANTED_COOKIES = ("SOURCEID_TGC", "SESSION", "rg_objectid")
DYNAMIC_COOKIE_PAIR = ("CtLgrmkSWHBZO", "CtLgrmkSWHBZP")

# 二次验证 type / 切 tab 文案 / 发码端点关键字(按 method)
METHOD = {
    "sms":  {"tab": "短信验证码", "login_type": "smsLogin",  "send_marker": "sendSmsCode"},
    "mail": {"tab": "邮件验证码", "login_type": "mailLogin", "send_marker": "sendMailCode"},
}


async def _read_complete_login_form(pg):
    """读取完整第一因素表单；任一动态字段未就绪时返回空。"""
    try:
        croypto_locator = pg.locator("#login-croypto")
        flowkey_locator = pg.locator("#login-page-flowkey")
        if not await croypto_locator.count() or not await flowkey_locator.count():
            return None, None
        croypto = (
            await croypto_locator.inner_text(timeout=browser_profile.LOGIN_READY_POLL_MS)
        ).strip()
        flowkey = (
            await flowkey_locator.inner_text(timeout=browser_profile.LOGIN_READY_POLL_MS)
        ).strip()
        return (croypto, flowkey) if croypto and flowkey else (None, None)
    except Exception:
        return None, None


def _dynamic_cookie_pair_present(cookies):
    present = {
        cookie.get("name")
        for cookie in cookies
        if cookie.get("name") in DYNAMIC_COOKIE_PAIR and cookie.get("value")
    }
    return all(name in present for name in DYNAMIC_COOKIE_PAIR)


async def wait_for_login_ready(
    pg,
    *,
    cookie_supplier=None,
    sleep=asyncio.sleep,
    monotonic=time.monotonic,
):
    """同时观察瑞数动态 cookie 与完整 CAS 表单，返回 (状态, croypto, flowkey)。"""
    if cookie_supplier is None:
        cookie_supplier = lambda: pg.context.cookies(SSO)

    started = monotonic()
    cookie_deadline = started + browser_profile.LOGIN_COOKIE_WAIT_MS / 1000
    form_deadline = started + browser_profile.LOGIN_FORM_WAIT_MS / 1000
    poll_seconds = browser_profile.LOGIN_READY_POLL_MS / 1000

    while True:
        try:
            cookies_ready = _dynamic_cookie_pair_present(await cookie_supplier())
        except Exception:
            cookies_ready = False
        croypto, flowkey = await _read_complete_login_form(pg)
        if cookies_ready and croypto and flowkey:
            return "ready", croypto, flowkey

        now = monotonic()
        if not cookies_ready and now >= cookie_deadline:
            return "cookies_timeout", None, None
        if now >= form_deadline:
            return "form_timeout", None, None

        next_deadline = (
            form_deadline if cookies_ready else min(cookie_deadline, form_deadline)
        )
        await sleep(min(poll_seconds, max(0, next_deadline - now)))


async def load_login_page(
    pg,
    url,
    *,
    sleep=asyncio.sleep,
    monotonic=time.monotonic,
    cookie_supplier=None,
):
    """加载登录页并等待动态 cookie pair + 完整表单；超时后至多 reload 一次。"""
    for attempt in range(browser_profile.LOGIN_READY_ATTEMPTS):
        try:
            if attempt == 0:
                await pg.goto(
                    url,
                    wait_until="domcontentloaded",
                    timeout=browser_profile.LOGIN_NAV_TIMEOUT_MS,
                )
            else:
                await pg.reload(
                    wait_until="domcontentloaded",
                    timeout=browser_profile.LOGIN_NAV_TIMEOUT_MS,
                )
        except Exception:
            pass
        status, croypto, flowkey = await wait_for_login_ready(
            pg,
            cookie_supplier=cookie_supplier,
            sleep=sleep,
            monotonic=monotonic,
        )
        if status == "ready":
            return croypto, flowkey
    return None, None


async def formnav_submit(pg, url, fields, wait_until="networkidle", timeout=None):
    """注入原始 <form> 走【文档导航式】提交(过瑞数的关键; 非 Angular XHR)。"""
    if timeout is None:
        timeout = browser_profile.FORMNAV_TIMEOUT_MS
    try:
        async with pg.expect_navigation(wait_until=wait_until, timeout=timeout):
            await pg.evaluate("""(a) => {
                const f = document.createElement('form');
                f.method = 'POST'; f.action = a.action;
                for (const k in a.fields) {
                    const i = document.createElement('input');
                    i.type = 'hidden'; i.name = k; i.value = a.fields[k]; f.appendChild(i);
                }
                document.body.appendChild(f); f.submit();
            }""", {"action": url, "fields": fields})
        return True
    except Exception:
        return False


def aes_encrypt_password(croypto_b64, password):
    """第一因素密码: AES-ECB-PKCS7(明文, Base64decode(croypto)) → Base64(与前端 aesEncrypt 同算法)。"""
    from base64 import b64decode, b64encode
    from Crypto.Cipher import AES
    from Crypto.Util.Padding import pad
    key = b64decode(croypto_b64)
    return b64encode(AES.new(key, AES.MODE_ECB).encrypt(pad(password.encode(), 16))).decode()


async def _fail_fingerprint(pg):
    """TEMP 诊断(抓到瑞数封锁真实形态后移除): 第一因素「未判定」失败页的紧凑指纹 ——
    title + 特征命中表 + HTML 长度 + 正文头部 120 字。挑战页为公开内容, 仍只截短片段, 不 dump 整页。
    任何一步抛错都吞掉, 绝不让诊断影响登录主流程。"""
    try:
        html = await pg.content()
    except Exception:
        html = ""
    try:
        text = (await pg.locator("body").inner_text()) if await pg.locator("body").count() else ""
    except Exception:
        text = ""
    try:
        title = await pg.title()
    except Exception:
        title = ""

    def hit(*ss):
        return "1" if any(s in html for s in ss) else "0"

    head = " ".join(text.split())[:120]
    return (
        f"fp title={title!r} len={len(html)} "
        f"caslogin={hit('login-croypto', 'login-page-flowkey')} "
        f"botgate={hit('botgate')} debuggerkw={hit('debugger')} ctlgr={hit('CtLgrmkSWHBZ')} "
        f"captcha={hit('captcha', '验证码')} "
        f"forbidden={hit('403', 'Forbidden', '拒绝访问', '禁止访问')} "
        f"slider={hit('slider', '滑块', 'nc_iconfont', 'geetest')} "
        f"head={head!r}"
    )


async def do_first_factor(pg, url, username, password, debug_screenshot=True):
    """加载 → 表单导航式提交密码。

    返回判别前缀而非让调用方解析诊断文案：'success' / '2fa' /
    'credential_rejected:<detail>' / 'transient:<detail>'。

    debug_screenshot=False 时跳过失败截图(及其文案后缀): 容器路径用之,
    避免在登录页落下凭证相邻产物 + 并发覆盖同名文件; CLI 路径保留(默认 True)便于调试。
    """
    croypto, flowkey = await load_login_page(pg, url)
    if not (croypto and flowkey):
        return "transient:登录页未渲染(疑似被瑞数挑战/限流)"
    # 第一因素必须保留已实测通过的 hidden-form/document-navigation；它不产生可安全
    # 调整的逐字符输入节奏，拟人延迟只应用于后续可见 tab/click 操作。
    fields = {"_eventId": "submit", "type": "UsernamePassword", "execution": flowkey,
              "geolocation": "", "username": username,
              "password": aes_encrypt_password(croypto, password), "croypto": croypto}
    await formnav_submit(pg, url, fields)
    await pg.wait_for_timeout(browser_profile.POST_SUBMIT_WAIT_MS)
    if "ticket=ST-" in pg.url:
        return "success"
    body = (await pg.locator("body").inner_text()) if await pg.locator("body").count() else ""
    if "二次身份验证" in body:
        return "2fa"
    # 失败: 看 login-error-code
    try:
        err = (await pg.locator("#login-error-code").inner_text(timeout=800)).strip()
    except Exception:
        err = ""
    credential_markers = ("用户名或密码", "密码错误", "账号已锁定", "帐号已锁定", "冻结")
    outcome = (
        "credential_rejected"
        if err and any(marker in err for marker in credential_markers)
        else "transient"
    )
    if not err and await pg.locator("#login-croypto").count():
        err = "回到登录页(密码错误/瑞数软重挑战)"
    # TEMP 诊断(抓到瑞数封锁真实形态后移除): 仅对「未判定」兜底附加页面指纹;
    # 已知错误(密码错/回登录页)不附加, 避免污染用户可见错误。
    diag = "" if err else " | " + await _fail_fingerprint(pg)
    if debug_screenshot:
        await pg.screenshot(path="firstfactor_fail.png", full_page=True)
        return outcome + ":" + (err or f"未判定 url={pg.url[:70]}") + " (见 firstfactor_fail.png)" + diag
    return outcome + ":" + (err or f"未判定 url={pg.url[:70]}") + diag


async def switch_2fa_tab(pg, method, *, uniform=random.uniform):
    """2FA 页切到短信/邮件 tab(等 Angular 渲染齐 tab)。"""
    tab_text = METHOD[method]["tab"]
    t = pg.locator(".ant-tabs-tab").filter(has_text=tab_text)
    try:
        await t.first.wait_for(
            state="visible", timeout=browser_profile.TAB_CLICK_TIMEOUT_MS
        )
        await pg.wait_for_timeout(uniform(150, 450))
        await t.first.click(timeout=browser_profile.TAB_CLICK_TIMEOUT_MS)
        code_input = pg.locator("input[placeholder='请输入验证码']")
        await code_input.first.wait_for(
            state="visible", timeout=browser_profile.TAB_CLICK_TIMEOUT_MS
        )
        await pg.wait_for_timeout(uniform(200, 500))
        await pg.wait_for_timeout(browser_profile.TWO_FACTOR_SETTLE_WAIT_MS)
    except Exception:
        pass


async def request_code(pg, sms_state, *, uniform=random.uniform):
    """原生点「获取验证码」, 发码 XHR 自带 CAqWHAeT。返回是否点到。"""
    for sel in [".font-class-text-button", "button:has-text('获取验证码')", "span:has-text('获取验证码')"]:
        if await pg.locator(sel).count():
            try:
                button = pg.locator(sel).first
                await button.wait_for(
                    state="visible", timeout=browser_profile.TAB_CLICK_TIMEOUT_MS
                )
                await pg.wait_for_timeout(uniform(150, 450))
                await button.click(timeout=browser_profile.TAB_CLICK_TIMEOUT_MS)
                await pg.wait_for_timeout(3500)
                return True
            except Exception:
                continue
    return False


def classify_send_code(status: int, body: dict | None) -> str:
    """判定发码响应: "sent" | "already_valid" | "failed"(纯函数, 便于单测)。

    背景(2026-06 实测): 在验证码 600s 有效期内重登录/重试时, 发码端点不会再发新码,
    而是返回形如:
      {"code":412,"message":"您的验证码还在有效期内，请勿重复发送",
       "data":{"result":false,"sendInterval":0,"expireTime":0}}
    此时一份有效码其实已经发出(且会被嗅探/推入)——登录必须继续去 await 验证码, 不能当失败。

    规则:
      · HTTP 200 且 body.code==200 / body.data.result 为真 → "sent"(成功发出新码)。
      · body.message 含「请勿重复发送」, 或(body.code==412 且 data.result 为假且
        message 带「有效期内/已发送」语义)→ "already_valid"(旧码仍有效, 继续等码)。
      · 其余 → "failed"。
    """
    body = body or {}
    code = body.get("code")
    data = body.get("data") if isinstance(body.get("data"), dict) else {}
    result = data.get("result")
    message = str(body.get("message") or "")

    # 成功发出新码。
    if status == 200 and (code == 200 or result is True):
        return "sent"

    # 旧码仍在有效期内, 端点拒绝重复发送 —— 视作「已有有效码」, 继续等码。
    if "请勿重复发送" in message:
        return "already_valid"
    if code == 412 and result is False and any(k in message for k in ("有效期内", "已发送")):
        return "already_valid"

    return "failed"


async def submit_code(pg, url, username, code, method):
    """表单导航式提交二次验证码(type=smsLogin/mailLogin, password=验证码明文)。"""
    try:
        flowkey = (await pg.locator("#login-page-flowkey").inner_text()).strip()
    except Exception:
        flowkey = ""
    fields = {"username": username, "password": code, "type": METHOD[method]["login_type"],
              "execution": flowkey, "_eventId": "submit", "trustDevice": "false"}
    await formnav_submit(pg, url, fields, timeout=browser_profile.FORMNAV_TIMEOUT_MS)
    await pg.wait_for_timeout(browser_profile.POST_SUBMIT_WAIT_MS)


def install_ticket_sniffer(page, tickets):
    def on_response(resp):
        try:
            if "ticket=ST-" in resp.url:
                tickets.append(resp.url)
            loc = resp.headers.get("location", "")
            if "ticket=ST-" in loc:
                tickets.append(loc)
        except Exception:
            pass
    page.on("response", on_response)


def install_send_code_sniffer(page, sms_state, method):
    """监听发码响应(URL 含 send_marker, 如 sendMailCode), 捕获 HTTP status + 解析后的 JSON body。

    body 用于 classify_send_code 判定「请勿重复发送(旧码仍有效)」等非 200 但应继续等码的情形;
    `await resp.json()` 防御异常(发码响应偶有非 JSON / 解析失败), 失败时 body 留 None。
    """
    marker = METHOD[method]["send_marker"]

    async def on_response(resp):
        try:
            if marker not in resp.url:
                return
            sms_state["status"] = resp.status
            try:
                sms_state["body"] = await resp.json()
            except Exception:
                sms_state["body"] = None
        except Exception:
            pass

    page.on("response", on_response)


def extract_ticket(urls):
    for u in urls:
        m = re.search(r"ticket=(ST-[\w.\-]+)", u or "")
        if m:
            return m.group(1)
    return ""


def extract_cookies(storage_state):
    """从 patchright storage_state 抽取后端要的 3 个 cookie。缺任一返回的 dict 里对应键为 ""。"""
    jar = {name: "" for name in WANTED_COOKIES}
    for c in storage_state.get("cookies", []):
        name = c.get("name")
        if name in jar:
            jar[name] = c.get("value", "")
    return jar


def read_code(args):
    """取验证码: --code 直给 / --code-file 轮询 / 否则交互输入。"""
    if args.code:
        return args.code.strip()
    if args.code_file:
        print(f"→ 等待验证码写入 {args.code_file} (最多 110s)...", flush=True)
        for _ in range(110):
            if os.path.exists(args.code_file):
                v = open(args.code_file).read().strip()
                if v:
                    try:
                        os.remove(args.code_file)
                    except Exception:
                        pass
                    return v
            time.sleep(1)
        return ""
    return input("请输入收到的 6 位验证码: ").strip()


async def run_login(
    student_id,
    password,
    service,
    method="mail",
    code_provider=None,
    reusable_code_provider=None,
    permit_provider=None,
    proxy=None,
):
    """容器入口: 跑完整登录流程, 验证码经 code_provider(async, 返回 6 位字符串)推入。

    与 CLI run() 同一条流程(form-nav 第一因素 + 原生发码 + form-nav 提交码 + ticket 嗅探),
    唯一区别: read_code() 文件轮询替换为 `await code_provider()`(由 server.py /code 端点 set Event 唤醒)。

    proxy: 可选, 形如 {"server": "http://ip:port", "username": .., "password": ..}(青果住宅代理,
    由 server.py 经 acquire_qg_proxy() 取得后传入), 让浏览器经国内住宅出站消除 CQU 验证码;
    None 时透传给 patchright launch 等价于不设代理(playwright 默认 = 无代理), 保持旧行为。

    成功返回 {"state": <patchright storage_state 完整对象, 含 cookies + localStorage>, "ticket": "ST-..."}。
    失败(第一因素未过 / 无 ST / 未取到码)抛 RuntimeError, 携带可诊断信息。
    """
    if method not in METHOD:
        raise ValueError(f"unsupported method: {method!r} (expected 'sms' or 'mail')")
    if code_provider is None:
        raise ValueError("code_provider is required for run_login")

    url = f"{SSO}/login?service={urllib.parse.quote(service, safe='')}"

    async with async_playwright() as p:
        # headless chromium —— basic(1 GiB)容器必须带 --no-sandbox + --disable-dev-shm-usage。
        browser = await p.chromium.launch(
            headless=True,
            args=[
                "--headless=new",
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-dev-shm-usage",
            ],
            proxy=proxy,
            timeout=browser_profile.BROWSER_LAUNCH_TIMEOUT_MS,
        )
        ctx = await browser.new_context(user_agent=UA, viewport={"width": 1440, "height": 900},
                                        locale="zh-CN", timezone_id="Asia/Shanghai")
        page = await ctx.new_page()
        page.set_default_timeout(15000)
        tickets = []
        install_ticket_sniffer(page, tickets)
        sms_state = {"status": None, "body": None}
        install_send_code_sniffer(page, sms_state, method)
        try:
            # 容器路径不落盘失败截图(凭证相邻产物 + 并发覆盖同名文件的隐患)。
            verdict = await do_first_factor(page, url, student_id, password, debug_screenshot=False)
            if verdict == "success":
                # 该 service 未开二次验证, 第一因素直出 ticket。
                tk = extract_ticket(tickets + [page.url])
                state = await ctx.storage_state()
                if not tk:
                    raise RuntimeError("first-factor succeeded but no ST ticket captured")
                return {"state": state, "ticket": tk}
            if verdict != "2fa":
                raise RuntimeError(f"first-factor failed: {verdict}")

            await switch_2fa_tab(page, method)
            # 普通 CAS 与 QuickLogin 可并行完成第一因素，但共享的账号级验证码只能由租约
            # owner 请求/消费。旧 CLI/调用方未提供 permit_provider 时维持立即发码。
            if permit_provider is not None:
                await permit_provider()
            if not await request_code(page, sms_state):
                raise RuntimeError("未找到「获取验证码」按钮(页面结构可能变化)")
            # 发码响应分类: "sent"(发出新码) / "already_valid"(旧码仍有效, 端点拒重发) 都应继续等码;
            # 只有 "failed" 才中止。已发/请勿重复发送时一份有效码已在外, 会被嗅探/推入。
            send_verdict = classify_send_code(sms_state["status"], sms_state["body"])
            if send_verdict == "failed":
                raise RuntimeError(
                    f"发码失败 status={sms_state['status']} body={sms_state['body']}(验证码未发出)"
                )

            # 后端拒绝重复发送(already_valid)时不会再来一封邮件；此时只能使用 DO
            # 在授予租约时定向预载的、仍在 10 分钟有效期内的旧码。真正发出新码(sent)
            # 时必须只等新邮件，绝不能误吃预载旧码。
            provider = (
                reusable_code_provider
                if send_verdict == "already_valid" and reusable_code_provider is not None
                else code_provider
            )
            code = (await provider() or "").strip()
            if not code:
                raise RuntimeError("未取到验证码(code_provider 返回空)")

            await submit_code(page, url, student_id, code, method)
            tk = extract_ticket(tickets + [page.url])
            if not tk:
                await page.wait_for_timeout(browser_profile.POST_SUBMIT_WAIT_MS)
                tk = extract_ticket(tickets + [page.url])
            if not tk:
                raise RuntimeError(f"未捕获 ST ticket(验证码可能错误/过期), final_url={page.url[:80]}")

            state = await ctx.storage_state()
            return {"state": state, "ticket": tk}
        finally:
            await browser.close()


async def run(args):
    """CLI 流程(交互/文件取码)。复用 run_login 的全部 helper, 验证码走 read_code。"""
    service = args.service
    username = args.username or input("统一身份认证号/学号/身份证件号: ").strip()
    password = args.password or getpass.getpass("密码(不回显): ")
    url = f"{SSO}/login?service={urllib.parse.quote(service, safe='')}"

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=not args.headed,
            args=["--headless=new", "--disable-blink-features=AutomationControlled",
                  "--no-sandbox", "--disable-dev-shm-usage"]
            if not args.headed else ["--disable-blink-features=AutomationControlled"],
            timeout=browser_profile.BROWSER_LAUNCH_TIMEOUT_MS)
        ctx = await browser.new_context(user_agent=UA, viewport={"width": 1440, "height": 900},
                                        locale="zh-CN", timezone_id="Asia/Shanghai")
        page = await ctx.new_page()
        page.set_default_timeout(15000)
        tickets = []
        install_ticket_sniffer(page, tickets)
        sms_state = {"status": None, "body": None}
        install_send_code_sniffer(page, sms_state, args.method)
        try:
            verdict = await do_first_factor(page, url, username, password)
            if verdict == "success":
                tk = extract_ticket(tickets + [page.url])
                print(f"✓ 第一因素直接登录(该 service 未开二次验证)。ticket={tk or '(见URL)'}")
                await ctx.storage_state(path=args.out)
                print(f"✓ 会话已导出 → {args.out}")
                return 0
            if verdict != "2fa":
                print(f"✗ 第一因素未通过: {verdict}", file=sys.stderr)
                return 3
            print("✓ 第一因素通过(表单导航式), 已到二次身份验证页。")

            await switch_2fa_tab(page, args.method)
            if not await request_code(page, sms_state):
                print("⚠ 未找到「获取验证码」按钮, 页面结构可能变化。", file=sys.stderr)
            send_verdict = classify_send_code(sms_state["status"], sms_state["body"])
            if send_verdict == "sent":
                print(f"✓ 已发{'邮箱' if args.method == 'mail' else '短信'}验证码(发码 200), 请查收。")
            elif send_verdict == "already_valid":
                print("• 旧验证码仍在有效期内(端点拒绝重发), 直接用之前收到的码即可。")
            else:
                print(f"⚠ 发码失败 status={sms_state['status']} body={sms_state['body']}, 可能未发出。",
                      file=sys.stderr)

            if args.stop_before_code:
                print("• --stop-before-code: 到此为止(已发码, 未提交)。")
                return 0

            code = read_code(args)
            if not code:
                print("✗ 未取到验证码。", file=sys.stderr)
                return 4
            await submit_code(page, url, username, code, args.method)

            tk = extract_ticket(tickets + [page.url])
            if not tk:
                await page.wait_for_timeout(browser_profile.POST_SUBMIT_WAIT_MS)
                tk = extract_ticket(tickets + [page.url])
            await ctx.storage_state(path=args.out)
            if tk:
                print(f"✓ 登录成功! ticket={tk}")
                print(f"✓ 会话已导出 → {args.out}(含 cookie/localStorage)")
                return 0
            print(f"⚠ 未捕获 ST ticket。final_url={page.url[:80]}\n  验证码可能错误/过期, 用 --headed 观察。",
                  file=sys.stderr)
            return 5
        finally:
            await browser.close()


def main():
    ap = argparse.ArgumentParser(description="重庆大学统一身份认证脚本化登录(patchright, form-nav)")
    ap.add_argument("--service", default=DEFAULT_SERVICE, help="CAS 回调(子系统)URL")
    ap.add_argument("--username", default="", help="统一身份认证号/学号/身份证件号")
    ap.add_argument("--password", default="", help="密码(留空交互输入, 推荐)")
    ap.add_argument("--method", choices=["sms", "mail"], default="sms", help="二次验证方式")
    ap.add_argument("--code", default="", help="直接给验证码(自动化用)")
    ap.add_argument("--code-file", default="", help="发码后轮询此文件取验证码(后台/非交互用)")
    ap.add_argument("--headed", action="store_true", help="有头模式(调试)")
    ap.add_argument("--stop-before-code", action="store_true", help="只到发码(发1条后停, 不提交)")
    ap.add_argument("--out", default="cqu_session.json", help="会话导出文件")
    args = ap.parse_args()
    try:
        rc = asyncio.run(asyncio.wait_for(run(args), timeout=900))
    except asyncio.TimeoutError:
        print("✗ 整体超时(900s)。", file=sys.stderr)
        rc = 6
    sys.exit(rc)


if __name__ == "__main__":
    main()
