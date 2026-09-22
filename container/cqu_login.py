"""Shared CQU login constants and pure response/credential helpers."""

import re

SSO = "https://sso.cqu.edu.cn"

DEFAULT_SERVICE = "https://my.cqu.edu.cn/authserver/authentication/cas"

WANTED_COOKIES = ("SOURCEID_TGC", "SESSION", "rg_objectid")

DYNAMIC_COOKIE_PAIR = ("CtLgrmkSWHBZO", "CtLgrmkSWHBZP")

METHOD = {
    "sms":  {"tab": "短信验证码", "login_type": "smsLogin",  "send_marker": "sendSmsCode"},
    "mail": {"tab": "邮件验证码", "login_type": "mailLogin", "send_marker": "sendMailCode"},
}

def _dynamic_cookie_pair_present(cookies):
    present = {
        cookie.get("name")
        for cookie in cookies
        if cookie.get("name") in DYNAMIC_COOKIE_PAIR and cookie.get("value")
    }
    return all(name in present for name in DYNAMIC_COOKIE_PAIR)

def aes_encrypt_password(croypto_b64, password):
    """第一因素密码: AES-ECB-PKCS7(明文, Base64decode(croypto)) → Base64(与前端 aesEncrypt 同算法)。"""
    from base64 import b64decode, b64encode
    from Crypto.Cipher import AES
    from Crypto.Util.Padding import pad
    key = b64decode(croypto_b64)
    return b64encode(AES.new(key, AES.MODE_ECB).encrypt(pad(password.encode(), 16))).decode()

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

def extract_ticket(urls):
    for u in urls:
        m = re.search(r"ticket=(ST-[\w.\-]+)", u or "")
        if m:
            return m.group(1)
    return ""

def extract_cookies(storage_state):
    """从浏览器 storage_state 抽取后端要的 3 个 cookie。缺任一返回的 dict 里对应键为 ""。"""
    jar = {name: "" for name in WANTED_COOKIES}
    for c in storage_state.get("cookies", []):
        name = c.get("name")
        if name in jar:
            jar[name] = c.get("value", "")
    return jar

async def run_login(*args, **kwargs):
    from cqu_login_cdp import run_login as login
    return await login(*args, **kwargs)


if __name__ == "__main__":
    import argparse
    import asyncio
    import getpass
    import json
    import os
    from pathlib import Path

    parser = argparse.ArgumentParser(description="CQU mail verification login using Chromium/CDP")
    parser.add_argument("--username")
    parser.add_argument("--method", choices=["mail"], default="mail")
    parser.add_argument("--service", default=DEFAULT_SERVICE)
    parser.add_argument("--out", default="cqu_session.json")
    parser.add_argument("--code-file")
    args = parser.parse_args()

    async def read_code():
        if not args.code_file:
            return await asyncio.to_thread(input, "请输入收到的 6 位验证码: ")
        path = Path(args.code_file)
        for _ in range(570):
            if path.exists():
                code = path.read_text().strip()
                if code:
                    path.unlink()
                    return code
            await asyncio.sleep(1)
        return ""

    result = asyncio.run(run_login(
        args.username or input("学号: ").strip(), getpass.getpass("密码: "),
        args.service, method=args.method, code_provider=read_code,
    ))
    descriptor = os.open(args.out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as output:
        os.fchmod(output.fileno(), 0o600)
        json.dump(result["state"], output, ensure_ascii=False)
    print("会话已保存至", args.out)
