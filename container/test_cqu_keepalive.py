#!/usr/bin/env python3
"""cqu_keepalive 纯函数单测 —— 探测结果 → 三态(alive/expired/unreachable)判定。
全部不触网。

运行:
    python3 -m pytest container/test_cqu_keepalive.py -v
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pytest  # noqa: E402

from cqu_keepalive import classify_probe  # noqa: E402
from cqu_ticket import TicketError  # noqa: E402


# ── classify_probe: 拿到 ST → alive ────────────────────────────────────────
def test_classify_ticket_is_alive():
    # 探测能换到 ST = 会话有效。
    assert classify_probe(ticket="ST-12345-abc") == "alive"


def test_classify_empty_ticket_is_not_alive():
    # 仅 ticket=None/"" 不该判 alive(无票必带 error 语义)。
    assert classify_probe(ticket="") != "alive"
    assert classify_probe(ticket=None) != "alive"


# ── classify_probe: SESSION_EXPIRED(落回 CAS 登录页) → expired ──────────────
def test_classify_session_expired_is_expired():
    # 对齐 cqu-sso.ts/DO: 落回 cas-login 才判真过期(TGT_EXPIRED → expired)。
    err = TicketError("SESSION_EXPIRED", "fell back to CAS login page")
    assert classify_probe(error=err) == "expired"


# ── classify_probe: NO_TICKET(疑似瑞数误判/未知页) → unreachable ────────────
def test_classify_no_ticket_is_unreachable():
    # 关键: NO_TICKET 不判 expired! 对齐 DO isTransientSsoError —— 瑞数误判/未知页
    # 属 WAF_CHALLENGE 语义(transient), 让 DO 退避而非误触重登。
    err = TicketError("NO_TICKET", "no ST in redirect chain (likely WAF/throttle)")
    assert classify_probe(error=err) == "unreachable"


# ── classify_probe: 缺 cookie 是确定性坏态(expired, 交重登铸新完整 cookie) ─────
def test_classify_missing_cookie_is_expired():
    # cookie 残缺(3 个缺任一)是**确定性坏态**, 不是瞬态: 退避永远修不好。
    # 归 expired 让 DO 重登铸一套新的完整 cookie, 而非无限退避卡死用户。
    err = TicketError("MISSING_COOKIE", "missing CQU SSO cookie(s): SESSION")
    assert classify_probe(error=err) == "expired"


# ── classify_probe: 网络层/未知异常 → unreachable(保守, 重试胜于误判重登) ────
def test_classify_network_error_is_unreachable():
    # 对齐 cqu-sso.ts: 非 CquSsoError(网络层等)保守判 transient → unreachable。
    assert classify_probe(error=RuntimeError("connection reset by peer")) == "unreachable"


def test_classify_timeout_is_unreachable():
    assert classify_probe(error=TimeoutError("read timeout")) == "unreachable"


def test_classify_unknown_ticket_error_code_is_unreachable():
    # 未来新增的未知 TicketError code 保守归 unreachable(只有 SESSION_EXPIRED 才判 expired)。
    err = TicketError("SOMETHING_NEW", "unexpected")
    assert classify_probe(error=err) == "unreachable"
