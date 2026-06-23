import cqu_data_harvest as m


# --- is_harvest_host_allowed: navUrl/capture/fetch 的 host 必须精确为 my.cqu.edu.cn ---
# 与 server.is_allowed_service_url(*.cqu.edu.cn)不同:harvest 只打 my.cqu.edu.cn 单 host,
# 故收得更紧(精确等于),纯函数便于单测。

def test_host_allowed_exact_my_cqu():
    assert m.is_harvest_host_allowed("https://my.cqu.edu.cn/workspace/curriculum") is True


def test_host_allowed_lowercases_host():
    # 浏览器把请求 URL host 规范化为小写;大写 host 也应判通过。
    assert m.is_harvest_host_allowed("https://MY.CQU.EDU.CN/x") is True


def test_host_allowed_explicit_443_ok():
    assert m.is_harvest_host_allowed("https://my.cqu.edu.cn:443/x") is True


def test_host_rejects_other_cqu_subdomain():
    # *.cqu.edu.cn 的别的子域(lib/card/sso)一律拒:harvest 只允许 my.cqu.edu.cn。
    assert m.is_harvest_host_allowed("https://lib.cqu.edu.cn/x") is False
    assert m.is_harvest_host_allowed("https://sso.cqu.edu.cn/login") is False


def test_host_rejects_apex():
    assert m.is_harvest_host_allowed("https://cqu.edu.cn/x") is False


def test_host_rejects_suffix_trick():
    # my.cqu.edu.cn.evil.com 含子串但 host != my.cqu.edu.cn,必须拒(绝不用 endswith/in)。
    assert m.is_harvest_host_allowed("https://my.cqu.edu.cn.evil.com/x") is False


def test_host_rejects_non_https():
    assert m.is_harvest_host_allowed("http://my.cqu.edu.cn/x") is False


def test_host_rejects_userinfo():
    assert m.is_harvest_host_allowed("https://user:pass@my.cqu.edu.cn/x") is False


def test_host_rejects_nondefault_port():
    assert m.is_harvest_host_allowed("https://my.cqu.edu.cn:8443/x") is False


def test_host_rejects_backslash():
    assert m.is_harvest_host_allowed("https://my.cqu.edu.cn\\@evil.com/x") is False


def test_host_rejects_non_ascii():
    # 全角点 my．cqu / IDN 同形 → 杀(对齐 service-url 红线)。
    assert m.is_harvest_host_allowed("https://my．cqu.edu.cn/x") is False


def test_host_rejects_empty_and_garbage():
    assert m.is_harvest_host_allowed("") is False
    assert m.is_harvest_host_allowed("@@bad@@") is False
