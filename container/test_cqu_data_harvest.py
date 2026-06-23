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


import pytest


# --- parse_harvest_recipe: 校验 + 规范化 {navUrl, capture[], fetch[]} ---
# navUrl + 每个 fetch[].url 必须过 host 白名单;fetch[].method 仅 GET;capture[] 是非空
# URL 子串模式(对齐 page.on('response') 的 `pattern in resp.url` 匹配,见 harvest 主体)。

def _good():
    return {
        "navUrl": "https://my.cqu.edu.cn/workspace/curriculum",
        "capture": [
            "timetable/class/timetable/student/my-table-detail",
            "resourceapi/session/info-detail",
        ],
        "fetch": [
            {"method": "GET",
             "url": "https://my.cqu.edu.cn/api/exam/examTask/get-student-exam-list"},
        ],
    }


def test_parse_recipe_ok_returns_normalized():
    r = m.parse_harvest_recipe(_good())
    assert r["navUrl"] == "https://my.cqu.edu.cn/workspace/curriculum"
    assert r["capture"] == [
        "timetable/class/timetable/student/my-table-detail",
        "resourceapi/session/info-detail",
    ]
    assert r["fetch"] == [
        {"method": "GET",
         "url": "https://my.cqu.edu.cn/api/exam/examTask/get-student-exam-list"},
    ]


def test_parse_recipe_allows_empty_capture_and_fetch():
    r = m.parse_harvest_recipe({"navUrl": _good()["navUrl"], "capture": [], "fetch": []})
    assert r["capture"] == [] and r["fetch"] == []


def test_parse_recipe_missing_navurl_raises():
    with pytest.raises(m.HarvestRecipeError):
        m.parse_harvest_recipe({"capture": [], "fetch": []})


def test_parse_recipe_navurl_host_not_allowed_raises():
    bad = _good() | {"navUrl": "https://lib.cqu.edu.cn/x"}
    with pytest.raises(m.HarvestRecipeError):
        m.parse_harvest_recipe(bad)


def test_parse_recipe_fetch_url_host_not_allowed_raises():
    bad = _good() | {"fetch": [{"method": "GET", "url": "https://evil.com/x"}]}
    with pytest.raises(m.HarvestRecipeError):
        m.parse_harvest_recipe(bad)


def test_parse_recipe_fetch_non_get_raises():
    # POST in-page fetch 注入式拿不到 VM 令牌(412/400),且写专守 —— 一律拒,只允许 GET。
    bad = _good() | {"fetch": [{"method": "POST",
                                "url": "https://my.cqu.edu.cn/x"}]}
    with pytest.raises(m.HarvestRecipeError):
        m.parse_harvest_recipe(bad)


def test_parse_recipe_fetch_missing_url_raises():
    bad = _good() | {"fetch": [{"method": "GET"}]}
    with pytest.raises(m.HarvestRecipeError):
        m.parse_harvest_recipe(bad)


def test_parse_recipe_capture_must_be_nonempty_string():
    with pytest.raises(m.HarvestRecipeError):
        m.parse_harvest_recipe(_good() | {"capture": [""]})
    with pytest.raises(m.HarvestRecipeError):
        m.parse_harvest_recipe(_good() | {"capture": [123]})


def test_parse_recipe_capture_not_list_raises():
    with pytest.raises(m.HarvestRecipeError):
        m.parse_harvest_recipe(_good() | {"capture": "not-a-list"})


def test_parse_recipe_fetch_method_defaults_to_get():
    # method 省略默认 GET(便于调用方少写)。
    r = m.parse_harvest_recipe(
        _good() | {"fetch": [{"url": "https://my.cqu.edu.cn/x"}]})
    assert r["fetch"][0]["method"] == "GET"
