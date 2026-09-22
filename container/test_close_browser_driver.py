import asyncio
import errno
import signal
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from chromium_session import ChromiumSession
import chromium_session as runtime


@pytest.mark.asyncio
async def test_unstarted_browser_can_be_closed():
    await ChromiumSession().close()


@pytest.mark.asyncio
@pytest.mark.parametrize('component', ['cdp', 'http'])
async def test_independent_cleanup_reaps_process_after_close_failure(tmp_path, component):
    browser = ChromiumSession()
    profile = tmp_path / 'profile'
    profile.mkdir()
    browser.profile_dir = str(profile)
    browser.cdp = SimpleNamespace(call=AsyncMock(), close=AsyncMock())
    browser.http = SimpleNamespace(close=AsyncMock())
    getattr(browser, component).close.side_effect = RuntimeError('synthetic close failure')
    browser.process = SimpleNamespace(returncode=None, terminate=Mock(), wait=AsyncMock())
    await browser.close()
    browser.http.close.assert_awaited_once()
    browser.process.terminate.assert_called_once()
    browser.process.wait.assert_awaited_once()
    assert not profile.exists()


@pytest.mark.asyncio
async def test_cancellation_during_cdp_close_still_reaps_owned_process(tmp_path):
    browser = ChromiumSession()
    browser.profile_dir = str(tmp_path / 'profile')
    browser.cdp = SimpleNamespace(call=AsyncMock(side_effect=asyncio.CancelledError()), close=AsyncMock())
    browser.http = SimpleNamespace(close=AsyncMock())
    browser.process = SimpleNamespace(returncode=None, terminate=Mock(), wait=AsyncMock())
    with pytest.raises(asyncio.CancelledError):
        await browser.close()
    browser.http.close.assert_awaited_once()
    browser.process.wait.assert_awaited_once()


@pytest.mark.asyncio
async def test_shutdown_stops_remaining_owned_group_after_parent_exit(monkeypatch, tmp_path):
    browser = ChromiumSession()
    profile = tmp_path / 'profile'
    profile.mkdir()
    browser.profile_dir = str(profile)
    browser.process = SimpleNamespace(returncode=0, wait=AsyncMock())
    browser._process_group = 987654321
    signals = []
    child_alive = True
    original_rmtree = runtime.shutil.rmtree

    def killpg(group, sig):
        nonlocal child_alive
        assert group == 987654321
        signals.append(sig)
        if sig == signal.SIGKILL:
            child_alive = False

    def rmtree(path, **kwargs):
        if child_alive:
            if kwargs.get('ignore_errors'):
                return
            raise OSError(errno.ENOTEMPTY, 'synthetic late browser write')
        original_rmtree(path, **kwargs)

    monkeypatch.setattr(runtime.os, 'killpg', killpg)
    monkeypatch.setattr(runtime.shutil, 'rmtree', rmtree)
    await browser.close()
    assert signals == [signal.SIGTERM, signal.SIGKILL]
    assert not profile.exists()


@pytest.mark.asyncio
async def test_profile_removal_retries_a_transient_late_write(monkeypatch, tmp_path):
    browser = ChromiumSession()
    profile = tmp_path / 'profile'
    profile.mkdir()
    browser.profile_dir = str(profile)
    original_rmtree = runtime.shutil.rmtree
    calls = 0

    def rmtree(path, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            if kwargs.get('ignore_errors'):
                return
            raise OSError(errno.ENOTEMPTY, 'synthetic late browser write')
        original_rmtree(path, **kwargs)

    monkeypatch.setattr(runtime.shutil, 'rmtree', rmtree)
    await browser.close()
    assert calls == 2
    assert not profile.exists()


@pytest.mark.asyncio
async def test_profile_cleanup_failure_is_bounded_and_not_silent(monkeypatch, tmp_path):
    browser = ChromiumSession()
    profile = tmp_path / 'profile'
    profile.mkdir()
    browser.profile_dir = str(profile)

    def rmtree(path, **kwargs):
        if not kwargs.get('ignore_errors'):
            raise OSError(errno.ENOTEMPTY, 'synthetic persistent browser write')

    monkeypatch.setattr(runtime.shutil, 'rmtree', rmtree)
    monkeypatch.setattr(runtime, 'PROFILE_CLEANUP_TIMEOUT_S', 0.01, raising=False)
    outer = asyncio.timeout(0.5)
    with pytest.raises(RuntimeError, match='^BROWSER_CLEANUP_FAILED$'):
        async with outer:
            await browser.close()
    assert not outer.expired()
