from types import SimpleNamespace

import pytest

import cqu_login
import cqu_ticket_browser as m


def test_build_login_url_encodes_service():
    u = m.build_login_url("https://my.cqu.edu.cn/authserver/authentication/cas")
    assert u == "https://sso.cqu.edu.cn/login?service=https%3A%2F%2Fmy.cqu.edu.cn%2Fauthserver%2Fauthentication%2Fcas"


def test_classify_browser_result_ticket():
    assert m.classify_browser_result("ST-1-abc", "") == ("ok", "ST-1-abc")


def test_classify_browser_result_cas_login_is_expired():
    body = "<input id='login-page-flowkey' value='x'>"
    assert m.classify_browser_result("", body)[0] == "expired"


def test_classify_browser_result_unknown_is_no_ticket():
    assert m.classify_browser_result("", "<html>weird</html>")[0] == "no_ticket"


# --- service_host_of: 从 serviceUrl 解析规范化 host 键(用于 abort 判定) ---
# 返回规范化元组 (host_lower, port_or_None);https 默认 443 与"无端口"等价(都归一为 None)。
# 解析不出 host 返回 ("", None)。纯函数,便于单测。

def test_service_host_of_extracts_normalized_tuple():
    assert m.service_host_of("https://my.cqu.edu.cn/authserver/authentication/cas") == ("my.cqu.edu.cn", None)


def test_service_host_of_lowercases_host():
    # 浏览器把请求 URL host 规范化为小写,事实源也必须小写,否则比对不上漏 abort。
    assert m.service_host_of("https://MY.CQU.EDU.CN/x") == ("my.cqu.edu.cn", None)


def test_service_host_of_explicit_443_equals_no_port():
    # 显式 :443 与省略端口等价(都归一 None),不能因 :443 ≠ 无端口而漏 abort。
    assert m.service_host_of("https://my.cqu.edu.cn:443/x") == ("my.cqu.edu.cn", None)


def test_service_host_of_keeps_non_default_port():
    assert m.service_host_of("https://lib.cqu.edu.cn:8443/cas/login") == ("lib.cqu.edu.cn", 8443)


def test_service_host_of_garbage_is_empty_tuple():
    # 解析不出 host(空串/无 scheme 的垃圾)→ ("", None)(绝不误判某请求该 abort)。
    assert m.service_host_of("") == ("", None)


def test_service_host_of_invalid_port_is_none():
    # 非法端口(超 65535)→ urllib u.port 抛 ValueError,当作无端口(host 仍可比对,不崩)。
    assert m.service_host_of("https://my.cqu.edu.cn:99999/x") == ("my.cqu.edu.cn", None)


# --- should_abort_request: 仅对落向目标服务 host 的请求 abort(等价旧 follow_redirects=False) ---
# service_host 参数为 service_host_of 返回的规范化元组。

def test_should_abort_request_target_service_host():
    # 指向目标服务 host 的请求(带 ST 回调)→ abort,绝不让浏览器把一次性 ST 送达核销。
    assert m.should_abort_request(
        "https://my.cqu.edu.cn/authserver/authentication/cas?ticket=ST-123-abc",
        m.service_host_of("https://my.cqu.edu.cn/authserver/authentication/cas")) is True


def test_should_abort_request_target_service_host_any_path():
    # 中间多跳里任何落向目标服务 host 的请求都拦(不依赖 URL 是否含 ticket=)。
    assert m.should_abort_request(
        "https://my.cqu.edu.cn/some/landing",
        m.service_host_of("https://my.cqu.edu.cn/")) is True


def test_should_abort_request_normalization_consistency():
    # M1 关键回归:serviceUrl 写成大写 + 显式 :443,浏览器把回调请求规范化为小写、省略 443 后,
    # 二者判定必须一致(否则漏 abort → 一次性 ST 被送达核销 → 取票失败)。覆盖三变体。
    sh = m.service_host_of("https://MY.CQU.EDU.CN:443/authserver/authentication/cas")
    # 浏览器规范化后的回调请求:小写 host、无端口、带 ticket。
    assert m.should_abort_request("https://my.cqu.edu.cn/x?ticket=ST-1", sh) is True
    # 显式 :443 的回调也应判一致。
    assert m.should_abort_request("https://my.cqu.edu.cn:443/x?ticket=ST-1", sh) is True
    # 大写 host 的回调也应判一致。
    assert m.should_abort_request("https://MY.CQU.EDU.CN/x?ticket=ST-1", sh) is True


def test_should_not_abort_sso_host():
    # 指向 sso.cqu.edu.cn(瑞数 + CAS 登录页本身)的请求绝不 abort,否则瑞数 JS 加载不全。
    assert m.should_abort_request(
        "https://sso.cqu.edu.cn/login?service=https%3A%2F%2Fmy.cqu.edu.cn",
        m.service_host_of("https://my.cqu.edu.cn/")) is False


def test_should_not_abort_sso_host_even_when_service_is_sso():
    # M2:当 serviceUrl 的 host 恰为 CAS 自身(sso.cqu.edu.cn)时,初始 /login 导航的 host 也等于
    # service_host → 必须仍放行(否则初始导航被自 abort → 吞异常返回 no_ticket)。
    sh = m.service_host_of("https://sso.cqu.edu.cn/some/cas")
    assert m.should_abort_request("https://sso.cqu.edu.cn/login?service=x", sh) is False
    assert m.should_abort_request("https://sso.cqu.edu.cn/some/cas?ticket=ST-1", sh) is False


def test_should_not_abort_when_service_host_empty():
    # service_host 解析失败时退化为「全不拦」(宁可不拦也不误拦,sniffer 仍兜底抓票)。
    assert m.should_abort_request("https://my.cqu.edu.cn/x?ticket=ST-1", m.service_host_of("")) is False


def test_should_not_abort_garbage_request_url():
    # 畸形 request_url(解析不出 host)对真 service_host → host 比对不上 → 不拦(fail-open,sniffer 兜底)。
    assert m.should_abort_request("@@bad@@", m.service_host_of("https://my.cqu.edu.cn/")) is False


# --- collect_ticket_url: 把带 ticket=ST- 的 URL 收进 tickets 供 extract_ticket ---

def test_collect_ticket_url_appends_ticket():
    tickets = []
    m.collect_ticket_url("https://my.cqu.edu.cn/cas?ticket=ST-9-xyz", tickets)
    assert tickets == ["https://my.cqu.edu.cn/cas?ticket=ST-9-xyz"]


def test_collect_ticket_url_ignores_non_ticket():
    tickets = []
    m.collect_ticket_url("https://sso.cqu.edu.cn/login", tickets)
    assert tickets == []


# --- 回归:abort 收集的 URL 必须能被现有 extract_ticket regex 抽出 ST(锁死契约) ---

def test_collected_ticket_url_is_extractable_by_extract_ticket():
    tickets = []
    m.collect_ticket_url("https://my.cqu.edu.cn/authserver/authentication/cas?ticket=ST-42-aB.c-D_e", tickets)
    assert cqu_login.extract_ticket(tickets) == "ST-42-aB.c-D_e"
