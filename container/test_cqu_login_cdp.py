import os
import sys
import asyncio

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import cqu_login_cdp


def test_chrome_args_use_raw_headless_cdp_without_automation_switches():
    args = cqu_login_cdp.build_chrome_args(
        "/browser/chrome", "/app/runtime/profile", 43123, proxy=None
    )

    assert args[0] == "/browser/chrome"
    assert "--headless=new" in args
    assert "--remote-debugging-port=43123" in args
    assert "--remote-debugging-port=0" not in args
    assert "--no-sandbox" in args
    assert "--disable-dev-shm-usage" in args
    assert not any("enable-automation" in arg for arg in args)
    assert not any("user-agent=" in arg for arg in args)


def test_chrome_args_pass_an_unauthenticated_proxy_server():
    args = cqu_login_cdp.build_chrome_args(
        "/browser/chrome",
        "/app/runtime/profile",
        43123,
        proxy={"server": "http://127.0.0.1:8080"},
    )

    assert "--proxy-server=http://127.0.0.1:8080" in args


def test_seed_cookie_conversion_omits_session_expiry_and_unknown_fields():
    converted = cqu_login_cdp.cookie_to_cdp(
        {
            "name": "SESSION",
            "value": "opaque",
            "domain": "sso.cqu.edu.cn",
            "path": "/",
            "expires": -1,
            "httpOnly": True,
            "secure": True,
            "sameSite": "Lax",
            "priority": "High",
        }
    )

    assert converted == {
        "name": "SESSION",
        "value": "opaque",
        "domain": "sso.cqu.edu.cn",
        "path": "/",
        "httpOnly": True,
        "secure": True,
        "sameSite": "Lax",
    }


def test_cdp_cookie_export_matches_storage_state_shape():
    state = cqu_login_cdp.cookies_to_storage_state(
        [
            {
                "name": "SOURCEID_TGC",
                "value": "opaque",
                "domain": "sso.cqu.edu.cn",
                "path": "/",
                "expires": 12345,
                "httpOnly": True,
                "secure": False,
                "sameSite": "Lax",
                "size": 99,
            }
        ],
        [{"origin": "https://my.cqu.edu.cn", "localStorage": []}],
    )

    assert state == {
        "cookies": [
            {
                "name": "SOURCEID_TGC",
                "value": "opaque",
                "domain": "sso.cqu.edu.cn",
                "path": "/",
                "expires": 12345,
                "httpOnly": True,
                "secure": False,
                "sameSite": "Lax",
            }
        ],
        "origins": [{"origin": "https://my.cqu.edu.cn", "localStorage": []}],
    }


def test_send_body_parser_preserves_business_json_and_rejects_html():
    assert cqu_login_cdp.parse_json_body(
        b'{"code":200,"data":{"result":true}}'
    ) == {"code": 200, "data": {"result": True}}
    assert cqu_login_cdp.parse_json_body(b"\r\n\r\n\r\n") is None


def test_interaction_jitter_uses_the_requested_half_to_one_second_range():
    seen = []

    async def sleep(delay):
        seen.append(delay)

    def uniform(low, high):
        assert (low, high) == (0.5, 1.0)
        return 0.75

    asyncio.run(cqu_login_cdp.interaction_jitter(uniform=uniform, sleep=sleep))
    assert seen == [0.75]


def test_first_page_websocket_waits_until_chrome_exposes_a_page_target():
    class FakeResponse:
        def __init__(self, targets):
            self.targets = targets

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

        def raise_for_status(self):
            return None

        async def json(self):
            return self.targets

    class FakeHttp:
        def __init__(self):
            self.calls = 0

        def get(self, _url):
            self.calls += 1
            targets = [] if self.calls == 1 else [{
                "type": "page",
                "webSocketDebuggerUrl": "ws://127.0.0.1/devtools/page/1",
            }]
            return FakeResponse(targets)

    http = FakeHttp()
    websocket = asyncio.run(cqu_login_cdp._first_page_websocket(http, 43123))

    assert websocket == "ws://127.0.0.1/devtools/page/1"
    assert http.calls == 2


def test_cdp_session_cookie_export_keeps_expiry_and_default_same_site():
    state = cqu_login_cdp.cookies_to_storage_state([{
        "name": "SOURCEID_TGC", "value": "synthetic-session", "domain": "sso.cqu.edu.cn",
        "path": "/", "expires": -1, "session": True, "httpOnly": True, "secure": True,
    }], [])
    assert state["cookies"][0]["expires"] == -1
    assert state["cookies"][0]["sameSite"] == "Lax"


def test_cdp_export_does_not_drop_partition_metadata():
    cookie = {"name": "SOURCEID_TGC", "value": "synthetic", "domain": "sso.cqu.edu.cn",
        "path": "/", "expires": -1, "httpOnly": True, "secure": True,
        "partitionKey": {"topLevelSite": "https://cqu.edu.cn", "hasCrossSiteAncestor": False}}
    assert cqu_login_cdp.cookies_to_storage_state([cookie], [])["cookies"][0]["partitionKey"] == cookie["partitionKey"]


def test_cdp_export_matches_worker_cookie_fixture():
    import json
    from pathlib import Path
    fixture = json.loads((Path(__file__).parent / "fixtures/cdp-session-cookie.json").read_text())
    assert cqu_login_cdp.cookies_to_storage_state(fixture["rawCookies"], []) == fixture["storageState"]
