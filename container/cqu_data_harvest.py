"""Organic harvest:在已登录 + 已过瑞数的临时浏览器里有机 fire 请求并截获响应。

my.cqu.edu.cn 全站瑞数化后,后端纯 HTTP POST 课表被 412 专守;唯一过墙是让真前端在
auth 已登录浏览器里导航 navUrl(页面自动 fire 课表/学期)+ 截获 capture 模式响应 +
对 fetch[] 跑 in-page GET(同源、读豁免)。本模块是 schedule 取数的通用原语,业务无关。

host 红线:navUrl/capture(同源相对或绝对)/fetch[].url 解析出的 host 必须精确为
my.cqu.edu.cn —— 比取票的 *.cqu.edu.cn 收得更紧(harvest 只打这一个 host),防 auth 变
开放代理(SSRF)。纯函数(host 校验 / recipe 解析 / capture 匹配)抽出便于单测。
"""
import urllib.parse

# harvest 唯一允许的目标 host(精确等于,绝不 endswith/in)。
HARVEST_HOST = "my.cqu.edu.cn"


def is_harvest_host_allowed(url: str) -> bool:
    """url 的 host 是否精确为 my.cqu.edu.cn(https、无 userinfo、端口省略或 443)。

    策略对齐 server.is_allowed_service_url 的红线(反斜杠/非ASCII/scheme/userinfo/端口/
    host 字符),但 host 判定收紧为 **精确等于 HARVEST_HOST**(不放行其它 *.cqu.edu.cn)。
    纯函数,不抛。
    """
    if not url or "\\" in url:
        return False
    if any(ord(ch) < 0x20 or ord(ch) > 0x7e for ch in url):  # 非 ASCII / 控制符
        return False
    try:
        u = urllib.parse.urlparse(url)
    except Exception:
        return False
    if u.scheme != "https":
        return False
    if u.username or u.password:
        return False
    try:
        port = u.port  # 非法端口抛 ValueError
    except ValueError:
        return False
    if port is not None and port != 443:
        return False
    host = (u.hostname or "").lower()
    if not host:
        return False
    if any(ch not in "abcdefghijklmnopqrstuvwxyz0123456789.-" for ch in host):
        return False
    return host == HARVEST_HOST
