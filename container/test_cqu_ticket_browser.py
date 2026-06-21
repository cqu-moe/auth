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


# --- service_host_of: 从 serviceUrl 解析目标服务 host(用于 abort 判定) ---

def test_service_host_of_extracts_netloc():
    assert m.service_host_of("https://my.cqu.edu.cn/authserver/authentication/cas") == "my.cqu.edu.cn"


def test_service_host_of_strips_port():
    assert m.service_host_of("https://lib.cqu.edu.cn:8443/cas/login") == "lib.cqu.edu.cn:8443"


def test_service_host_of_garbage_is_empty():
    # 解析不出 host(空串/无 scheme 的垃圾)→ 空串(绝不误判某请求该 abort)。
    assert m.service_host_of("") == ""


# --- should_abort_request: 仅对落向目标服务 host 的请求 abort(等价旧 follow_redirects=False) ---

def test_should_abort_request_target_service_host():
    # 指向目标服务 host 的请求(带 ST 回调)→ abort,绝不让浏览器把一次性 ST 送达核销。
    assert m.should_abort_request(
        "https://my.cqu.edu.cn/authserver/authentication/cas?ticket=ST-123-abc",
        "my.cqu.edu.cn") is True


def test_should_abort_request_target_service_host_any_path():
    # 中间多跳里任何落向目标服务 host 的请求都拦(不依赖 URL 是否含 ticket=)。
    assert m.should_abort_request("https://my.cqu.edu.cn/some/landing", "my.cqu.edu.cn") is True


def test_should_not_abort_sso_host():
    # 指向 sso.cqu.edu.cn(瑞数 + CAS 登录页本身)的请求绝不 abort,否则瑞数 JS 加载不全。
    assert m.should_abort_request(
        "https://sso.cqu.edu.cn/login?service=https%3A%2F%2Fmy.cqu.edu.cn",
        "my.cqu.edu.cn") is False


def test_should_not_abort_when_service_host_empty():
    # service_host 解析失败时退化为「全不拦」(宁可不拦也不误拦,sniffer 仍兜底抓票)。
    assert m.should_abort_request("https://my.cqu.edu.cn/x?ticket=ST-1", "") is False


def test_should_not_abort_garbage_request_url():
    # 畸形 request_url(解析不出 host)对真 service_host → host 比对不上 → 不拦(fail-open,sniffer 兜底)。
    assert m.should_abort_request("@@bad@@", "my.cqu.edu.cn") is False


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
