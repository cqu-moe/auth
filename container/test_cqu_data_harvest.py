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


def test_parse_recipe_fetch_method_none_defaults_to_get():
    # method 显式 None 也默认 GET(与省略同义)。
    r = m.parse_harvest_recipe(
        _good() | {"fetch": [{"method": None, "url": "https://my.cqu.edu.cn/x"}]})
    assert r["fetch"][0]["method"] == "GET"


def test_parse_recipe_fetch_method_lowercase_get_ok():
    # "get" 大小写不敏感,uppercase 后等于 GET。
    r = m.parse_harvest_recipe(
        _good() | {"fetch": [{"method": "get", "url": "https://my.cqu.edu.cn/x"}]})
    assert r["fetch"][0]["method"] == "GET"


@pytest.mark.parametrize("bad_method", [42, True, ["GET"], {"m": "GET"}])
def test_parse_recipe_fetch_non_string_method_raises(bad_method):
    # 非字符串 method(数字/布尔/list/dict)绝不能走到 .upper() 抛 AttributeError(→ 500);
    # 必须在 shape 校验阶段抛 HarvestRecipeError(让 server.py 回 400)。
    bad = _good() | {"fetch": [{"method": bad_method,
                                "url": "https://my.cqu.edu.cn/x"}]}
    with pytest.raises(m.HarvestRecipeError):
        m.parse_harvest_recipe(bad)


def test_parse_recipe_fetch_empty_string_method_raises():
    # "" 不是合法 method,旧代码用 `or "GET"` 会静默吞成 GET;现应判非 GET → 拒。
    bad = _good() | {"fetch": [{"method": "", "url": "https://my.cqu.edu.cn/x"}]}
    with pytest.raises(m.HarvestRecipeError):
        m.parse_harvest_recipe(bad)


# --- capture_match: resp.url 命中哪个 capture pattern(子串匹配,返回首个命中或 None) ---

def test_capture_match_hits_substring():
    pats = ["student/my-table-detail", "session/info-detail"]
    assert m.capture_match(
        "https://my.cqu.edu.cn/timetable/class/timetable/student/my-table-detail?CAqWHAeT=x",
        pats) == "student/my-table-detail"


def test_capture_match_returns_first_on_overlap():
    # 多 pattern 都命中时返回列表里靠前的(确定性)。
    assert m.capture_match("https://my.cqu.edu.cn/a/b/c", ["a/b", "b/c"]) == "a/b"


def test_capture_match_no_hit_returns_none():
    assert m.capture_match("https://my.cqu.edu.cn/other", ["x/y"]) is None


def test_capture_match_empty_patterns_none():
    assert m.capture_match("https://my.cqu.edu.cn/a", []) is None


# --- is_expired_harvest: 无 capture 命中 + 页面落回 CAS 登录页 → 会话过期(交 DO 重登) ---
# storage_state 过期时 navUrl 会被重定向到 SSO/CAS 登录页, 无 capture fire、fetch 返 401/空,
# 但 harvest 若照常 ok:true 上层就永远不触发重登。此纯函数判 expired, 让 harvest 抛错 → 409。

import cqu_login
import cqu_ticket_browser


def test_is_expired_false_when_captures_present():
    # 有 capture 命中 = 真过墙拿到数据, 一律非过期(即便 page_content/url 像登录页也不误判)。
    captures = {"student/my-table-detail": {"status": 200, "body": "{}"}}
    assert m.is_expired_harvest(
        captures, "login-page-flowkey login-croypto", "https://sso.cqu.edu.cn/login"
    ) is False


def test_is_expired_true_when_empty_and_login_markers():
    # 无 capture + 页面含 CAS 登录页标记 → 过期。
    assert m.is_expired_harvest({}, "...login-page-flowkey...", "https://my.cqu.edu.cn/workspace/curriculum") is True
    assert m.is_expired_harvest({}, "x login-croypto y", "https://my.cqu.edu.cn/x") is True


def test_is_expired_true_when_empty_and_sso_host():
    # 无 capture + 落到 SSO host(被重定向到登录) → 过期(即便 page_content 抓不到/为空)。
    assert m.is_expired_harvest({}, "", "https://sso.cqu.edu.cn/login?service=x") is True


def test_is_expired_false_when_empty_and_normal_page():
    # 无 capture 但页面是正常 my.cqu 页(无登录标记、非 SSO host)→ 非过期(归瞬态, 不触发重登)。
    assert m.is_expired_harvest({}, "<html>normal page no markers</html>", "https://my.cqu.edu.cn/workspace/curriculum") is False


def test_is_expired_uses_shared_cas_markers_and_sso():
    # 锁住「复用既有常量」不变式: 标记取自 cqu_ticket_browser.CAS_LOGIN_MARKERS、SSO host 取自 cqu_login.SSO。
    for marker in cqu_ticket_browser.CAS_LOGIN_MARKERS:
        assert m.is_expired_harvest({}, f"prefix {marker} suffix", "https://my.cqu.edu.cn/x") is True
    sso_host = cqu_login.SSO  # https://sso.cqu.edu.cn
    assert m.is_expired_harvest({}, "", f"{sso_host}/login") is True


# --- all_captures_present: 已收集的 capture pattern 集是否覆盖期望集(等齐判定) ---

def test_all_captures_present_true_when_covered():
    collected = {"a/b", "c/d"}
    assert m.all_captures_present(collected, ["a/b", "c/d"]) is True


def test_all_captures_present_false_when_missing():
    assert m.all_captures_present({"a/b"}, ["a/b", "c/d"]) is False


def test_all_captures_present_true_for_empty_expected():
    # 无 capture 期望 → 立即"齐"(只跑 fetch[])。
    assert m.all_captures_present(set(), []) is True


# --- classify_harvest_outcome: capture-wait 后的三态判定(ok / expired / transient) ---
# navigate 失败(goto 超时/网络/非 CAS 的瑞数挑战页)会让期望 capture 收不齐, 此时绝不能当
# "ok 空 harvest"返回(经 DO/RPC 报 200 假成功)。纯函数, 让 harvest 主体据此 raise:
#   · 期望 capture 全齐(或 capture 期望为空)→ "ok"(照常返回)
#   · 期望 capture 缺 + 页面像 CAS 登录页 → "expired"(→ HarvestExpiredError → 409 重登)
#   · 期望 capture 缺 + 页面非登录页 → "transient"(→ HarvestTransientError → 502 退避)

def test_classify_outcome_ok_when_all_captures_present():
    # 期望全齐 → ok(即便 page_content 像登录页也不误判, 真过墙拿到数据为准)。
    assert m.classify_harvest_outcome(
        {"a/b", "c/d"}, ["a/b", "c/d"],
        "...login-page-flowkey...", "https://sso.cqu.edu.cn/login"
    ) == "ok"


def test_classify_outcome_ok_when_fetch_only_has_2xx():
    # fetch-only 配方(capture 期望为空): 至少一个 fetch 返 2xx → 合法 ok(真拿到数据)。
    assert m.classify_harvest_outcome(
        set(), [], "<html>anything</html>", "https://my.cqu.edu.cn/x",
        fetch_statuses=[200],
    ) == "ok"


def test_classify_outcome_ok_when_fetch_only_mixed_with_one_2xx():
    # fetch-only: 部分 fetch 非 2xx 但只要有一个 2xx → ok(部分端点失败不否定整体成功)。
    assert m.classify_harvest_outcome(
        set(), [], "<html>anything</html>", "https://my.cqu.edu.cn/x",
        fetch_statuses=[401, 200, 0],
    ) == "ok"


def test_classify_outcome_transient_when_fetch_only_all_non_2xx_normal_page():
    # fetch-only + 全部 fetch 非 2xx(401/0/...) + 正常页(非登录) → transient(瞬态退避, 502),
    # 绝不当 ok 空成功(旧代码 patterns 空即 ok 会让会话静默失效)。
    assert m.classify_harvest_outcome(
        set(), [], "<html>normal page no markers</html>", "https://my.cqu.edu.cn/x",
        fetch_statuses=[401, 0],
    ) == "transient"


def test_classify_outcome_transient_when_fetch_only_no_fetches_normal_page():
    # fetch-only + 没有任何成功 fetch(空列表/全失败) + 正常页 → transient(没拿到任何可用数据)。
    assert m.classify_harvest_outcome(
        set(), [], "<html>normal page no markers</html>", "https://my.cqu.edu.cn/x",
        fetch_statuses=[],
    ) == "transient"


def test_classify_outcome_expired_when_fetch_only_all_non_2xx_login_page():
    # fetch-only + 全部 fetch 非 2xx + 落回 CAS 登录页 → expired(409 重登), 先于 transient 判过期。
    assert m.classify_harvest_outcome(
        set(), [], "x login-page-flowkey y", "https://my.cqu.edu.cn/workspace/curriculum",
        fetch_statuses=[401, 0],
    ) == "expired"


def test_classify_outcome_expired_when_fetch_only_sso_host():
    # fetch-only + 落到 SSO host(被重定向到登录) → expired(即便有 fetch 也按过期处理)。
    assert m.classify_harvest_outcome(
        set(), [], "", "https://sso.cqu.edu.cn/login?service=x",
        fetch_statuses=[401],
    ) == "expired"


def test_classify_outcome_expired_when_missing_and_login_markers():
    # 期望缺 + 页面含 CAS 登录页标记 → expired(交 DO 重登)。
    assert m.classify_harvest_outcome(
        set(), ["a/b"], "x login-page-flowkey y", "https://my.cqu.edu.cn/workspace/curriculum"
    ) == "expired"


def test_classify_outcome_expired_when_missing_and_sso_host():
    # 期望缺 + 落到 SSO host(被重定向到登录)→ expired(即便 page_content 抓不到)。
    assert m.classify_harvest_outcome(
        set(), ["a/b"], "", "https://sso.cqu.edu.cn/login?service=x"
    ) == "expired"


def test_classify_outcome_transient_when_missing_and_normal_page():
    # 期望缺 + 页面是正常 my.cqu 页(无登录标记、非 SSO host)→ transient(瑞数/网络瞬态, 退避)。
    assert m.classify_harvest_outcome(
        set(), ["a/b"], "<html>normal page no markers</html>", "https://my.cqu.edu.cn/workspace/curriculum"
    ) == "transient"


def test_classify_outcome_transient_when_partial_captures():
    # 期望部分到齐(缺一)+ 非登录页 → transient(不是干净过期, 也不是 ok 空成功)。
    assert m.classify_harvest_outcome(
        {"a/b"}, ["a/b", "c/d"], "<html>normal</html>", "https://my.cqu.edu.cn/x"
    ) == "transient"
