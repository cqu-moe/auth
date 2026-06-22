#!/usr/bin/env python3
"""server.is_allowed_service_url 纯函数单测 —— 节点侧 serviceUrl host 白名单(纵深第二层)。

策略对齐 src/services/service-url.ts(validateCquServiceUrl): 仅允许 https 的 *.cqu.edu.cn
(host == cqu.edu.cn 或以 .cqu.edu.cn 结尾), 杜绝 CVE-2022-39369 式 ST-relay。
host 红线本只在 DO.getServiceTicket 一处; 节点加这层是纵深防御(VPC 误配 / 将来新增直连
调用方时仍兜得住)。全部不触网。

返回值:通过 → canonical URL 字符串(小写 host、去默认 :443);不通过 → None。
(从 bool 改成 str|None,使取票整链口径单一:handler 拿 canonical 传给浏览器水化导航。)

运行:
    python3 -m pytest container/test_service_url_allowlist.py -v
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pytest  # noqa: E402

from server import is_allowed_service_url, PROBE_SERVICE_HOST_OK  # noqa: E402


# ── 合法: https 的 *.cqu.edu.cn(含 apex 与子域、带 path/query) ─────────────────
@pytest.mark.parametrize("url", [
    "https://my.cqu.edu.cn/authserver/authentication/cas",
    "https://lib.cqu.edu.cn/cas/login",
    "https://cqu.edu.cn/",                               # apex 全等
    "https://my.cqu.edu.cn/x?a=1&b=2#frag",              # 带 query/fragment 只看 scheme+host
    "https://jxpj.cqu.edu.cn",                           # 无 path
])
def test_allowed_https_cqu_hosts(url):
    # 通过 → 返回真值(canonical URL 字符串),不再是裸 True。
    assert is_allowed_service_url(url)


# ── 非法 scheme: 只允许 https ───────────────────────────────────────────────
@pytest.mark.parametrize("url", [
    "http://my.cqu.edu.cn/cas",                          # http 明文
    "ftp://my.cqu.edu.cn/x",
    "ws://my.cqu.edu.cn/x",
    "//my.cqu.edu.cn/x",                                 # scheme-relative, 无 scheme
])
def test_rejects_non_https(url):
    assert is_allowed_service_url(url) is None


# ── 非法 host: 别域 / 后缀伪装(关键: cqu.edu.cn.evil.com 必须判 NOT 属于 *.cqu.edu.cn) ─
@pytest.mark.parametrize("url", [
    "https://evil.com/cas",
    "https://cqu.edu.cn.evil.com/cas",                   # 后缀伪装(endsWith 陷阱)
    "https://notcqu.edu.cn/cas",                         # 无 . 边界, 不是子域
    "https://my.cqu.edu.cn.evil.com/cas",
    "https://evilcqu.edu.cn/cas",                        # 前缀粘连, 非 .cqu.edu.cn
    "https://cqu.edu.cn./cas",                           # 尾点(cn. == cn 风险)
])
def test_rejects_wrong_or_spoofed_host(url):
    assert is_allowed_service_url(url) is None


# ── 非法: userinfo(@) 绕过 ──────────────────────────────────────────────────
@pytest.mark.parametrize("url", [
    "https://evil.com@my.cqu.edu.cn/cas",                # 真 host=my.cqu.edu.cn 但带 userinfo → 拒
    "https://my.cqu.edu.cn@evil.com/cas",                # 真 host=evil.com
    "https://user:pass@my.cqu.edu.cn/cas",
])
def test_rejects_userinfo(url):
    assert is_allowed_service_url(url) is None


# ── 非法: 空 host / 不可解析 / 畸形 ──────────────────────────────────────────
@pytest.mark.parametrize("url", [
    "",
    "https://",                                          # 空 host
    "not a url",
    "https:///cas",                                      # 空 host
    "https://:443/cas",                                  # 空 host 带端口
    "\\\\my.cqu.edu.cn\\cas",                            # 反斜杠跨解析器陷阱
])
def test_rejects_empty_or_unparsable(url):
    assert is_allowed_service_url(url) is None


# ── 非法: 非默认端口(对齐 service-url.ts 只放行 443/省略) ──────────────────────
def test_rejects_non_443_port():
    assert is_allowed_service_url("https://my.cqu.edu.cn:8443/cas") is None


def test_allows_explicit_443_port():
    assert is_allowed_service_url("https://my.cqu.edu.cn:443/cas")


# ── 非法: 非 ascii host(IDN 同形 / 全角点绕过) ──────────────────────────────
def test_rejects_non_ascii_host():
    # 全角点 U+FF0E 等同形字符: 绝不能被当成 .cqu.edu.cn。
    assert is_allowed_service_url("https://my．cqu.edu.cn/cas") is None


# ── canonical 返回: 通过时返回小写 host、去默认 :443 的 URL(整链口径单一) ─────────
def test_canonical_lowercases_host():
    # 大写 host 通过校验后必须返回小写 canonical,供浏览器水化导航 host 比对口径单一。
    assert is_allowed_service_url("https://MY.CQU.EDU.CN/cas") == "https://my.cqu.edu.cn/cas"


def test_canonical_strips_default_443():
    # 显式 :443 去掉,与浏览器规范化后的请求 URL 口径一致(否则 abort 漏判)。
    assert is_allowed_service_url("https://my.cqu.edu.cn:443/cas") == "https://my.cqu.edu.cn/cas"


def test_canonical_preserves_path_query_fragment():
    # canonical 只规范化 host/port,path/query/fragment 原样保留(serviceUrl 语义不能丢)。
    out = is_allowed_service_url("https://MY.CQU.EDU.CN:443/authserver/cas?a=1&b=2#frag")
    assert out == "https://my.cqu.edu.cn/authserver/cas?a=1&b=2#frag"


def test_canonical_already_normalized_unchanged():
    assert is_allowed_service_url("https://my.cqu.edu.cn/cas") == "https://my.cqu.edu.cn/cas"


# ── PROBE_SERVICE 必须自身在白名单内(防未来把硬编码探测 URL 改坏) ──────────────
def test_probe_service_is_allowlisted():
    assert PROBE_SERVICE_HOST_OK
