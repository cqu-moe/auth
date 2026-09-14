"""浏览器运行 profile:国内默认时限 vs Cloudflare Containers 时限。

通过环境变量 CQU_BROWSER_PROFILE=cloudflare 选择海外(实测加长)时限;缺失或为其他值时
一律保持国内原时限。常量在 import 时固定,模块只做 env 读取,不依赖 playwright/aiohttp,
便于用 subprocess 隔离测试。验证码有效期相关等待(CODE_WAIT_TIMEOUT=570s 等)不在此处,
任何 profile 都不得拉长。
"""

import os

CLOUDFLARE_PROFILE = os.environ.get("CQU_BROWSER_PROFILE") == "cloudflare"
PROFILE_NAME = "cloudflare" if CLOUDFLARE_PROFILE else "default"

# ── 登录页/表单导航(cqu_login.py) ────────────────────────────────────────────
# goto/reload 25s→60s;formnav 25s→60s;提交后 2.5s→20s;二次认证稳定 1.5s→3s;
# 4s 操作超时→10s;浏览器启动 30s→60s。(逐 hunk 对齐 2026-09-08 登录/采集实测补丁)
LOGIN_NAV_TIMEOUT_MS = 60_000 if CLOUDFLARE_PROFILE else 25_000
LOGIN_COOKIE_WAIT_MS = 20_000
LOGIN_FORM_WAIT_MS = 30_000
LOGIN_READY_POLL_MS = 100
LOGIN_READY_ATTEMPTS = 2
FORMNAV_TIMEOUT_MS = 60_000 if CLOUDFLARE_PROFILE else 25_000
POST_SUBMIT_WAIT_MS = 20_000 if CLOUDFLARE_PROFILE else 2_500
TWO_FACTOR_SETTLE_WAIT_MS = 3_000 if CLOUDFLARE_PROFILE else 1_500
TAB_CLICK_TIMEOUT_MS = 10_000 if CLOUDFLARE_PROFILE else 4_000
BROWSER_LAUNCH_TIMEOUT_MS = 60_000 if CLOUDFLARE_PROFILE else 30_000
# 点击发码后等待真实 HTTP response；此前固定 3.5s 会在按钮仍转圈时误判 status=None。
SEND_CODE_RESPONSE_TIMEOUT_MS = 60_000 if CLOUDFLARE_PROFILE else 30_000

# ── 采集(cqu_data_harvest.py) ───────────────────────────────────────────────
# Generic capture wait 8s→30s; GET 15s→30s; navigation 25s→60s.
# Table stages share a 150s work ceiling: queue 35s + cleanup 15s + margin 10s = 210s.
CAPTURE_WAIT_MS = 30_000 if CLOUDFLARE_PROFILE else 8_000
INPAGE_FETCH_TIMEOUT_MS = 30_000 if CLOUDFLARE_PROFILE else 15_000
HARVEST_OVERALL_TIMEOUT_S = 150.0
HARVEST_NAV_TIMEOUT_MS = 60_000 if CLOUDFLARE_PROFILE else 25_000

# ── CAS 取票/保活(cqu_ticket_browser.py) ────────────────────────────────────
# 整段 45s→120s;启动 30s→60s;导航 25s→60s。(2026-09-08 CAS 实测补丁)
HYDRATE_OVERALL_TIMEOUT_S = 120.0 if CLOUDFLARE_PROFILE else 45.0
TICKET_LAUNCH_TIMEOUT_MS = 60_000 if CLOUDFLARE_PROFILE else 30_000
TICKET_NAV_TIMEOUT_MS = 60_000 if CLOUDFLARE_PROFILE else 25_000
