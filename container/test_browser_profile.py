"""browser_profile 的两种时限集合:用 subprocess 隔离 env,避免模块缓存影响。"""

import json
import os
import subprocess
import sys
from pathlib import Path

CONTAINER_DIR = Path(__file__).resolve().parent
PROFILE_PROBE = (
    "import sys, json; sys.path.insert(0, sys.argv[1]); "
    "import browser_profile; "
    "print(json.dumps({"
    "    'cloudflare': browser_profile.CLOUDFLARE_PROFILE, "
    "    'name': browser_profile.PROFILE_NAME, "
    "    'login_nav': browser_profile.LOGIN_NAV_TIMEOUT_MS, "
    "    'cookie_wait': browser_profile.LOGIN_COOKIE_WAIT_MS, "
    "    'form_wait': browser_profile.LOGIN_FORM_WAIT_MS, "
    "    'ready_poll': browser_profile.LOGIN_READY_POLL_MS, "
    "    'ready_attempts': browser_profile.LOGIN_READY_ATTEMPTS, "
    "    'formnav': browser_profile.FORMNAV_TIMEOUT_MS, "
    "    'post_submit': browser_profile.POST_SUBMIT_WAIT_MS, "
    "    'tab_click': browser_profile.TAB_CLICK_TIMEOUT_MS, "
    "    'launch': browser_profile.BROWSER_LAUNCH_TIMEOUT_MS, "
    "    'capture_wait': browser_profile.CAPTURE_WAIT_MS, "
    "    'inpage_fetch': browser_profile.INPAGE_FETCH_TIMEOUT_MS, "
    "    'harvest_overall': browser_profile.HARVEST_OVERALL_TIMEOUT_S, "
    "    'harvest_nav': browser_profile.HARVEST_NAV_TIMEOUT_MS, "
    "    'hydrate_overall': browser_profile.HYDRATE_OVERALL_TIMEOUT_S, "
    "    'ticket_launch': browser_profile.TICKET_LAUNCH_TIMEOUT_MS, "
    "    'ticket_nav': browser_profile.TICKET_NAV_TIMEOUT_MS, "
    "}))"
)


def probe_profile(extra_env):
    env = {**os.environ, **extra_env}
    result = subprocess.run(
        [sys.executable, "-c", PROFILE_PROBE, str(CONTAINER_DIR)],
        capture_output=True,
        text=True,
        check=True,
        env=env,
    )
    return json.loads(result.stdout)


DEFAULTS = {
    "cloudflare": False,
    "name": "default",
    "login_nav": 25_000,
    "cookie_wait": 20_000,
    "form_wait": 30_000,
    "ready_poll": 100,
    "ready_attempts": 2,
    "formnav": 25_000,
    "post_submit": 2_500,
    "tab_click": 4_000,
    "launch": 30_000,
    "capture_wait": 8_000,
    "inpage_fetch": 15_000,
    "harvest_overall": 150.0,
    "harvest_nav": 25_000,
    "hydrate_overall": 45.0,
    "ticket_launch": 30_000,
    "ticket_nav": 25_000,
}


CLOUDFLARE = {
    "cloudflare": True,
    "name": "cloudflare",
    "login_nav": 60_000,
    "cookie_wait": 20_000,
    "form_wait": 30_000,
    "ready_poll": 100,
    "ready_attempts": 2,
    "formnav": 60_000,
    "post_submit": 20_000,
    "tab_click": 10_000,
    "launch": 60_000,
    "capture_wait": 30_000,
    "inpage_fetch": 30_000,
    "harvest_overall": 150.0,
    "harvest_nav": 60_000,
    "hydrate_overall": 120.0,
    "ticket_launch": 60_000,
    "ticket_nav": 60_000,
}


def test_default_profile_keeps_domestic_timeouts_without_env():
    assert probe_profile({}) == DEFAULTS


def test_cloudflare_profile_selects_measured_timeouts():
    assert probe_profile({"CQU_BROWSER_PROFILE": "cloudflare"}) == CLOUDFLARE


def test_unrelated_env_value_stays_domestic():
    profile = probe_profile({"CQU_BROWSER_PROFILE": "staging"})
    assert profile["cloudflare"] is False
    assert profile["name"] == "default"
