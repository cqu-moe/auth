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
