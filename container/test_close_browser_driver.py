import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from chromium_session import ChromiumSession


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
