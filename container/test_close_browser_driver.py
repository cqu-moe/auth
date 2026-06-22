#!/usr/bin/env python3
"""cqu_ticket_browser._close_browser_driver 单测 —— cleanup 的 best-effort / None 安全。

cleanup 被刻意移出持槽窗口(M4:先 release 再 cleanup),且对 start() 握手期被取消、句柄
仍为 None 的情形(M3)必须安全跳过。本测用记录式假句柄(非 mock 被测函数本身)锁:
  · 正常句柄 → close + stop 都被调用一次。
  · None 句柄(M3:pw/browser 还没赋值就被取消)→ 不抛、安全跳过。
  · close 抛异常 → 不向上冒泡, 仍尝试 stop(各自独立兜底)。

运行:
    python3 -m pytest container/test_close_browser_driver.py -v
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pytest  # noqa: E402

import cqu_ticket_browser as m  # noqa: E402


class _FakeBrowser:
    def __init__(self, raise_on_close=False):
        self.closed = False
        self._raise = raise_on_close

    async def close(self):
        if self._raise:
            raise RuntimeError("wedged close")
        self.closed = True


class _FakePw:
    def __init__(self):
        self.stopped = False

    async def stop(self):
        self.stopped = True


@pytest.mark.asyncio
async def test_closes_browser_and_stops_driver():
    b, pw = _FakeBrowser(), _FakePw()
    await m._close_browser_driver(b, pw)
    assert b.closed is True
    assert pw.stopped is True


@pytest.mark.asyncio
async def test_none_handles_are_safe():
    # M3: start() 握手期被取消、句柄仍 None → 安全跳过, 绝不抛。
    await m._close_browser_driver(None, None)  # 不抛即通过


@pytest.mark.asyncio
async def test_browser_none_driver_present():
    # M3 变体: pw 已赋值但 browser 还没起 → 只停驱动, 不抛。
    pw = _FakePw()
    await m._close_browser_driver(None, pw)
    assert pw.stopped is True


@pytest.mark.asyncio
async def test_close_failure_does_not_block_stop():
    # close 抛异常(wedged)→ 不冒泡, 仍尝试 stop(各自独立兜底)。
    b, pw = _FakeBrowser(raise_on_close=True), _FakePw()
    await m._close_browser_driver(b, pw)  # 不抛
    assert pw.stopped is True
