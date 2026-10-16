"""Isolated external school, never an Auth/Workflow/browser replacement.

The real Chrome process resolves only the two school hostnames to this TLS
server. The control port configures external failures and drains generated mail.
"""
import asyncio
import base64
import json
import secrets
import ssl
import time
from pathlib import Path
from urllib.parse import urlencode

from aiohttp import web
from Crypto.Cipher import AES
from Crypto.Util.Padding import unpad

state = {"mode": "success", "session": "202610", "pageSession": "202610", "hold": False, "holdLogin": False, "holdMail": False}
events = []
mail = []
sessions = set()
codes = {}
generation = 0
KEY = b"0123456789abcdef"


def record(kind):
    events.append({"kind": kind, "at": int(time.time() * 1000)})


def html(text):
    return web.Response(text=text, content_type="text/html")


def form(error=""):
    return html(f'''<html><body><div id="login-croypto">{base64.b64encode(KEY).decode()}</div>
      <div id="login-page-flowkey">synthetic-flow</div>
      <div id="login-error-code">{error}</div><form>统一认证登录</form></body></html>''')


def ticket(request, token=None):
    token = token or secrets.token_hex(12)
    sessions.add(token)
    response = web.HTTPFound(request.cookies.get("service", "https://my.cqu.edu.cn/authserver/authentication/cas") + "?ticket=ST-" + secrets.token_hex(12))
    for name in ("SOURCEID_TGC", "SESSION", "rg_objectid"):
        response.set_cookie(name, token, secure=True)
    record("ticket_issued")
    return response


async def login(request):
    if request.method == "GET":
        record("sso_navigation")
        if request.cookies.get("SOURCEID_TGC") in sessions:
            response = ticket(request, request.cookies["SOURCEID_TGC"])
            if request.query.get("service"):
                response.headers["Location"] = request.query["service"] + "?ticket=ST-" + secrets.token_hex(12)
            return response
        response = form()
        for name in ("CtLgrmkSWHBZO", "CtLgrmkSWHBZP"):
            response.set_cookie(name, "synthetic", secure=True)
        response.set_cookie("service", request.query.get("service", "https://my.cqu.edu.cn/authserver/authentication/cas"), secure=True)
        return response
    body = await request.post()
    if body.get("type") == "UsernamePassword":
        record("password_submitted")
        try:
            password = unpad(AES.new(KEY, AES.MODE_ECB).decrypt(base64.b64decode(body.get("password", ""))), 16).decode()
        except Exception:
            password = ""
        if body.get("username") != "20990001" or password != "School-synthetic-123!" or state["mode"] == "reject":
            return form("用户名或密码错误")
        return html('''<html><body>二次身份验证
          <div id="login-page-flowkey">synthetic-2fa</div>
          <button class="ant-tabs-tab">邮件验证码</button><p>已绑定密保邮箱</p>
          <button id="send">获取验证码</button>
          <script>document.querySelector('#send').onclick=()=>fetch('/sendMailCode',{method:'POST'});</script>
          </body></html>''')
    if body.get("type") == "mailLogin":
        record("code_submitted")
        code = body.get("password")
        if code not in codes or codes[code] < time.time():
            record("code_rejected")
            return form("验证码错误或已过期")
        codes.pop(code)
        record("code_accepted")
        while state["holdLogin"]:
            await asyncio.sleep(.05)
        record("login_replied")
        return ticket(request)
    raise web.HTTPBadRequest()


async def send_code(request):
    record("code_requested")
    if state["mode"] == "send_timeout":
        await asyncio.sleep(120)
    if state["mode"] == "send_reject":
        return web.json_response({"code": 500, "data": {"result": False}}, status=500)
    code = str(secrets.randbelow(900000) + 100000)
    codes[code] = time.time() + 600
    mail.append({"code": "000000" if state["mode"] == "wrong_code" else code})
    return web.json_response({"code": 200, "data": {"result": True}})


async def app_page(request):
    if request.cookies.get("MY_SESSION") != str(generation):
        return web.HTTPFound("https://sso.cqu.edu.cn/login?" + urlencode({"service":"https://my.cqu.edu.cn/authserver/authentication/cas"}))
    record("directory_page")
    return html('''<html><body>
      <div class="ant-form-item"><label>查询范围</label><div class="ant-select">行政班</div></div>
      <div id="directory"></div><script>
      const vm={sessionId:__SESSION__,getSearchList(){},
        async getRequest(path,base){const r=await fetch(base+path);return {status:r.status,data:await r.json()};},
        async postJsonRequest(path,body,base){const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};}};
      document.querySelector('#directory').__vue__=vm;
      localStorage.setItem('cqu_edu_ACCESS_TOKEN',JSON.stringify('synthetic-school-token'));
      </script></body></html>'''.replace('__SESSION__', json.dumps(state["pageSession"])))


async def cas(request):
    record("school_callback")
    response = web.HTTPFound("/tt/AllCourseSchedule")
    response.set_cookie("MY_SESSION", str(generation), secure=True)
    return response


async def api(request):
    path = request.path
    if path.endswith("/session/info-detail"):
        return web.json_response({"curSessionId":state["session"]})
    if path.endswith("/session/list"):
        return web.json_response({"sessionVOList":[{"id":state["session"],"year":"2099-2100","term":"秋"}]})
    if path.endswith("/department/list"):
        return web.json_response({"data":[{"id":"12","name":"合成学院","subDepartmentVOList":[]}]})
    record("directory_requested")
    while state["hold"]:
        await asyncio.sleep(.05)
    if state["mode"] == "schema_error":
        return web.json_response({"status":"success","ok":True,"data":[{"id":"broken"}]})
    if path.endswith("/info-by-name-or-code"):
        data = [{"id":"31","name":"合成电路","codeR":"SYN101"}]
    elif "/instructors/" in path:
        data = [] if path.endswith('/62') else [{"instructorId":"51","instrName":"合成教师","instrCode":"T01","instrDeptName":"合成学院","belongDeptId":"12"}]
    elif path.endswith("/dept-admin-classes"):
        body = await request.json()
        if body != []:
            raise web.HTTPBadRequest(text="unexpected fixed school recipe")
        data = [{"id":"21","className":"合成班级","departmentName":"合成学院","grade":2099}]
    elif path.endswith("/roomName-filter"):
        data = [{"id":"41","name":"合成教室"}]
    else:
        raise web.HTTPNotFound()
    record("directory_replied")
    if state["mode"] == "drift_after":
        state.update(session="202611",mode="success")
    if path.endswith(('/dept-admin-classes','/roomName-filter','/LaboratoryId-filter','/classNbr-filter')):
        return web.json_response(data)
    return web.json_response({"status":"success","ok":True,"data":data})


async def control(request):
    global generation
    if request.method == "POST":
        updates = await request.json()
        if updates.pop("expire", False):
            sessions.clear()
            generation += 1
            record("sessions_expired")
        if updates.pop("clearEvents", False):
            events.clear()
        allowed = {"mode","session","pageSession","hold","holdLogin","holdMail"}
        if set(updates) - allowed:
            raise web.HTTPBadRequest()
        state.update(updates)
    chrome = 0
    for process in Path('/proc').iterdir():
        try:
            binary = (process / 'cmdline').read_bytes().split(b'\0')[0]
            chrome += int(binary.startswith(b'/opt/chrome/'))
        except (OSError, ValueError):
            pass
    return web.json_response({"events":events,"state":state,
      "profiles":len(list(Path('/app/runtime').glob('cqu-cdp-*'))),"chromeProcesses":chrome})


async def drain(_request):
    if state["holdMail"]:
        record("mail_held")
        while state["holdMail"]:
            await asyncio.sleep(.05)
    pending = list(mail)
    mail.clear()
    return web.json_response(pending)


async def main():
    app = web.Application()
    app.add_routes([web.route('*','/login',login),web.post('/sendMailCode',send_code),
                    web.get('/tt/AllCourseSchedule',app_page),web.get('/authserver/authentication/cas',cas),
                    web.route('*','/api/{tail:.*}',api)])
    runner = web.AppRunner(app,access_log=None)
    await runner.setup()
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain('/fixture/cert.pem','/fixture/key.pem')
    await web.TCPSite(runner,'127.0.0.1',443,ssl_context=tls).start()
    controls = web.Application()
    controls.add_routes([web.route('*','/control',control),web.get('/mail',drain)])
    second = web.AppRunner(controls,access_log=None)
    await second.setup()
    await web.TCPSite(second,'0.0.0.0',9090).start()
    try:
        await asyncio.Event().wait()
    finally:
        await second.cleanup()
        await runner.cleanup()


asyncio.run(main())
