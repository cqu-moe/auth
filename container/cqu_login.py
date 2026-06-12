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
    返回 {"cookies": {"SOURCEID_TGC":..,"SESSION":..,"rg_objectid":..}, "ticket": "ST-..."}
"""
import argparse
import asyncio
import getpass
import os
import re
import sys
import time
import urllib.parse

from patchright.async_api import async_playwright

SSO = "https://sso.cqu.edu.cn"
DEFAULT_SERVICE = "https://my.cqu.edu.cn/authserver/authentication/cas"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

# 浏览器登录器要回收的 3 个 CQU SSO cookie(对齐后端 CasCookies)。
WANTED_COOKIES = ("SOURCEID_TGC", "SESSION", "rg_objectid")

# 二次验证 type / 切 tab 文案 / 发码端点关键字(按 method)
METHOD = {
    "sms":  {"tab": "短信验证码", "login_type": "smsLogin",  "send_marker": "sendSmsCode"},
    "mail": {"tab": "邮件验证码", "login_type": "mailLogin", "send_marker": "sendMailCode"},
}


async def load_login_page(pg, url):
    """正常全量加载登录页(Angular 完整), 返回 (croypto, flowkey) 或 (None, None)。"""
    for i in range(6):
        try:
            await (pg.goto(url, wait_until="networkidle", timeout=25000) if i == 0
                   else pg.reload(wait_until="networkidle", timeout=25000))
        except Exception:
            pass
        await pg.wait_for_timeout(1500)
        if await pg.locator("#login-croypto").count():
            break
    else:
        return None, None
    try:
        croypto = (await pg.locator("#login-croypto").inner_text()).strip()
        flowkey = (await pg.locator("#login-page-flowkey").inner_text()).strip()
        return (croypto or None), (flowkey or None)
    except Exception:
        return None, None


async def formnav_submit(pg, url, fields, wait_until="networkidle", timeout=25000):
    """注入原始 <form> 走【文档导航式】提交(过瑞数的关键; 非 Angular XHR)。"""
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


async def do_first_factor(pg, url, username, password):
    """加载 → 表单导航式提交密码。返回 'success'(直接ticket) / '2fa' / 'fail:...'。"""
    croypto, flowkey = await load_login_page(pg, url)
    if not (croypto and flowkey):
        return "fail:登录页未渲染(疑似被瑞数挑战/限流)"
    fields = {"_eventId": "submit", "type": "UsernamePassword", "execution": flowkey,
              "geolocation": "", "username": username,
              "password": aes_encrypt_password(croypto, password), "croypto": croypto}
    await formnav_submit(pg, url, fields)
    await pg.wait_for_timeout(2500)
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
    if not err and await pg.locator("#login-croypto").count():
        err = "回到登录页(密码错误/瑞数软重挑战)"
    await pg.screenshot(path="firstfactor_fail.png", full_page=True)
    return "fail:" + (err or f"未判定 url={pg.url[:70]}") + " (见 firstfactor_fail.png)"


async def switch_2fa_tab(pg, method):
    """2FA 页切到短信/邮件 tab(等 Angular 渲染齐 tab)。"""
    tab_text = METHOD[method]["tab"]
    for _ in range(12):
        await pg.wait_for_timeout(1500)
        if await pg.locator(".ant-tabs-tab").filter(has_text=tab_text).count() or \
           await pg.locator("input[placeholder='请输入验证码']").count():
            break
    t = pg.locator(".ant-tabs-tab").filter(has_text=tab_text)
    if await t.count():
        try:
            await t.first.click(timeout=4000)
            await pg.wait_for_timeout(1500)
        except Exception:
            pass


async def request_code(pg, sms_state):
    """原生点「获取验证码」, 发码 XHR 自带 CAqWHAeT。返回是否点到。"""
    for sel in [".font-class-text-button", "button:has-text('获取验证码')", "span:has-text('获取验证码')"]:
        if await pg.locator(sel).count():
            try:
                await pg.locator(sel).first.click(timeout=4000)
                await pg.wait_for_timeout(3500)
                return True
            except Exception:
                continue
    return False


async def submit_code(pg, url, username, code, method):
    """表单导航式提交二次验证码(type=smsLogin/mailLogin, password=验证码明文)。"""
    try:
        flowkey = (await pg.locator("#login-page-flowkey").inner_text()).strip()
    except Exception:
        flowkey = ""
    fields = {"username": username, "password": code, "type": METHOD[method]["login_type"],
              "execution": flowkey, "_eventId": "submit", "trustDevice": "false"}
    await formnav_submit(pg, url, fields, timeout=20000)
    await pg.wait_for_timeout(2500)


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


async def run_login(student_id, password, service, method="mail", code_provider=None):
    """容器入口: 跑完整登录流程, 验证码经 code_provider(async, 返回 6 位字符串)推入。

    与 CLI run() 同一条流程(form-nav 第一因素 + 原生发码 + form-nav 提交码 + ticket 嗅探),
    唯一区别: read_code() 文件轮询替换为 `await code_provider()`(由 server.py /code 端点 set Event 唤醒)。

    成功返回 {"cookies": {"SOURCEID_TGC":..,"SESSION":..,"rg_objectid":..}, "ticket": "ST-..."}。
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
            timeout=30000,
        )
        ctx = await browser.new_context(user_agent=UA, viewport={"width": 1440, "height": 900},
                                        locale="zh-CN", timezone_id="Asia/Shanghai")
        page = await ctx.new_page()
        page.set_default_timeout(15000)
        tickets = []
        install_ticket_sniffer(page, tickets)
        sms_state = {"status": None}
        page.on("response", lambda r: sms_state.__setitem__("status", r.status)
                if METHOD[method]["send_marker"] in r.url else None)
        try:
            verdict = await do_first_factor(page, url, student_id, password)
            if verdict == "success":
                # 该 service 未开二次验证, 第一因素直出 ticket。
                tk = extract_ticket(tickets + [page.url])
                cookies = extract_cookies(await ctx.storage_state())
                if not tk:
                    raise RuntimeError("first-factor succeeded but no ST ticket captured")
                return {"cookies": cookies, "ticket": tk}
            if verdict != "2fa":
                raise RuntimeError(f"first-factor failed: {verdict}")

            await switch_2fa_tab(page, method)
            if not await request_code(page, sms_state):
                raise RuntimeError("未找到「获取验证码」按钮(页面结构可能变化)")
            if sms_state["status"] != 200:
                raise RuntimeError(f"发码响应 status={sms_state['status']}(非200), 验证码可能未发出")

            # 替代 read_code 文件轮询: 等 /code 端点经 code_provider 推入。
            code = (await code_provider() or "").strip()
            if not code:
                raise RuntimeError("未取到验证码(code_provider 返回空)")

            await submit_code(page, url, student_id, code, method)
            tk = extract_ticket(tickets + [page.url])
            if not tk:
                await page.wait_for_timeout(2500)
                tk = extract_ticket(tickets + [page.url])
            if not tk:
                raise RuntimeError(f"未捕获 ST ticket(验证码可能错误/过期), final_url={page.url[:80]}")

            cookies = extract_cookies(await ctx.storage_state())
            return {"cookies": cookies, "ticket": tk}
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
            timeout=30000)
        ctx = await browser.new_context(user_agent=UA, viewport={"width": 1440, "height": 900},
                                        locale="zh-CN", timezone_id="Asia/Shanghai")
        page = await ctx.new_page()
        page.set_default_timeout(15000)
        tickets = []
        install_ticket_sniffer(page, tickets)
        sms_state = {"status": None}
        page.on("response", lambda r: sms_state.__setitem__("status", r.status)
                if METHOD[args.method]["send_marker"] in r.url else None)
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
            if sms_state["status"] == 200:
                print(f"✓ 已发{'邮箱' if args.method == 'mail' else '短信'}验证码(发码 200), 请查收。")
            else:
                print(f"⚠ 发码响应 status={sms_state['status']}(非200), 可能未发出。", file=sys.stderr)

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
                await page.wait_for_timeout(2500)
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
