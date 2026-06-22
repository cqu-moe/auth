#!/usr/bin/env python3
"""cqu_keepalive.probe_session_browser 单测 —— refreshed state 透传/回退 + 异常脱敏。

probe_session_browser 是 keepalive 回写链路关键一环(DO 直接信任返回的 body.state)。
本测 monkeypatch cqu_ticket_browser._hydrate_navigate 返回构造的 (ticket, body, refreshed)
三元组, 不起真浏览器、不触网, 锁死三条不变式:
  ① alive 且 refreshed=有效 dict → status=="alive" 且 state IS refreshed(原样回吐刷新态)。
  ② refreshed=None(防御分支) → 回吐**原** state(绝不丢失 DO 给的凭证)。
  ③ _hydrate_navigate 抛异常 → {status:"unreachable", state:原state}, detail 含异常类型,
     且 detail **绝不**回显 state/cookie 明文(对齐 CLAUDE.md「ticket/cookies/state 明文绝不进日志」)。

运行:
    python3 -m pytest container/test_probe_session_browser.py -v
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pytest  # noqa: E402

import cqu_keepalive  # noqa: E402
import cqu_ticket_browser  # noqa: E402

_ORIG_STATE = {"cookies": [{"name": "SOURCEID_TGC", "value": "orig-secret"}], "origins": []}
_REFRESHED = {"cookies": [{"name": "SOURCEID_TGC", "value": "refreshed-secret"}], "origins": []}


@pytest.fixture
def patch_hydrate(monkeypatch):
    """返回一个 setter: 给定 (ticket, body, refreshed) 或一个 exc, 替换 _hydrate_navigate。"""
    def _set(*, ticket="", body="", refreshed=None, raises=None):
        async def _fake(service_url, state, *, capture_state=False, overall_timeout=45.0):
            if raises is not None:
                raise raises
            return ticket, body, refreshed
        monkeypatch.setattr(cqu_ticket_browser, "_hydrate_navigate", _fake)
    return _set


# ── ① alive + refreshed 有效 dict → status alive 且原样回吐 refreshed ───────────
@pytest.mark.asyncio
async def test_alive_passes_through_refreshed_state(patch_hydrate):
    patch_hydrate(ticket="ST-1-abc", body="", refreshed=_REFRESHED)
    out = await cqu_keepalive.probe_session_browser(_ORIG_STATE)
    assert out["status"] == "alive"
    # 关键: 回吐的就是 _hydrate_navigate 导出的刷新态(同一对象), 供 DO 保鲜瑞数 cookie。
    assert out["state"] is _REFRESHED


# ── ② refreshed=None(防御分支) → 回吐原 state(绝不丢凭证) ─────────────────────
@pytest.mark.asyncio
async def test_refreshed_none_falls_back_to_original_state(patch_hydrate):
    # 即便换到了票, 若 capture 出来的 refreshed 不是 dict(None), 必须回吐原 state, 绝不传 None。
    patch_hydrate(ticket="ST-1-abc", body="", refreshed=None)
    out = await cqu_keepalive.probe_session_browser(_ORIG_STATE)
    assert out["status"] == "alive"
    assert out["state"] is _ORIG_STATE


@pytest.mark.asyncio
async def test_refreshed_non_dict_falls_back_to_original_state(patch_hydrate):
    # refreshed 是非 dict 杂值(防御) → 同样回吐原 state。
    patch_hydrate(ticket="", body="<html>weird</html>", refreshed="not-a-dict")
    out = await cqu_keepalive.probe_session_browser(_ORIG_STATE)
    # no_ticket → unreachable; state 回退原值。
    assert out["status"] == "unreachable"
    assert out["state"] is _ORIG_STATE


# ── ③ _hydrate_navigate 抛异常 → unreachable + 原 state, 绝不误判过期 ───────────
@pytest.mark.asyncio
async def test_hydrate_raises_maps_to_unreachable_with_original_state(patch_hydrate):
    patch_hydrate(raises=RuntimeError("browser launch failed"))
    out = await cqu_keepalive.probe_session_browser(_ORIG_STATE)
    assert out["status"] == "unreachable"        # 绝不误判过期
    assert out["state"] is _ORIG_STATE
    assert "RuntimeError" in out["detail"]        # detail 含异常类型供诊断


@pytest.mark.asyncio
async def test_hydrate_timeout_maps_to_unreachable(patch_hydrate):
    # 整段超时(_hydrate_navigate 内的 asyncio.wait_for 抛 TimeoutError) → unreachable。
    import asyncio
    patch_hydrate(raises=asyncio.TimeoutError())
    out = await cqu_keepalive.probe_session_browser(_ORIG_STATE)
    assert out["status"] == "unreachable"
    assert out["state"] is _ORIG_STATE
    assert "TimeoutError" in out["detail"]


# ── #3 脱敏: 异常 message 含「像 cookie 的敏感子串」时, detail 绝不回显它 ─────────
@pytest.mark.asyncio
async def test_exception_detail_does_not_leak_state_or_cookie(patch_hydrate):
    # patchright.new_context(storage_state=非法) 的异常 message 可能把出错的 cookie 条目拼进去。
    # 构造一个 message 里"看起来像 cookie 值"的异常, 断言 detail 不含该敏感子串。
    secret = "SOURCEID_TGC=eyJhbGciOiJ-SUPER-SECRET-TGC-VALUE"
    patch_hydrate(raises=ValueError(f"invalid storage_state cookie: {secret}"))
    out = await cqu_keepalive.probe_session_browser(_ORIG_STATE)
    assert out["status"] == "unreachable"
    # 关键: detail 只放异常类型名, 绝不拼 str(e) → 敏感子串不得出现。
    assert secret not in out["detail"], f"cookie/state leaked into detail: {out['detail']!r}"
    assert "SUPER-SECRET-TGC-VALUE" not in out["detail"]
    assert "ValueError" in out["detail"]


@pytest.mark.asyncio
async def test_exception_detail_is_type_name_only(patch_hydrate):
    # detail 应恰为异常类型名(白名单化), 不含任何动态 message 内容。
    patch_hydrate(raises=KeyError("SESSION_cookie_value_xyz"))
    out = await cqu_keepalive.probe_session_browser(_ORIG_STATE)
    assert "SESSION_cookie_value_xyz" not in out["detail"]
    assert out["detail"] == "KeyError"
