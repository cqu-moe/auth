import asyncio
from types import SimpleNamespace

import pytest

import cqu_login_cdp as m


@pytest.mark.asyncio
@pytest.mark.parametrize('form_at,cookie_at', [(1, 3), (3, 1)])
async def test_login_waits_for_both_form_and_cookie_readiness(monkeypatch, form_at, cookie_at):
    polls = 0
    async def evaluate(*args, **kwargs):
        nonlocal polls
        polls += 1
        return {'croypto': 'crypto' if polls >= form_at else '',
                'execution': 'flow' if polls >= form_at else ''}
    async def call(*args, **kwargs):
        return {'cookies': [] if polls < cookie_at else [
            {'name':'CtLgrmkSWHBZO','value':'synthetic'},
            {'name':'CtLgrmkSWHBZP','value':'synthetic'}]}
    monkeypatch.setattr(m.browser_profile, 'LOGIN_READY_POLL_MS', 1)
    assert await m._wait_login_ready(SimpleNamespace(evaluate=evaluate, call=call)) == ('crypto', 'flow')
    assert polls == 3


@pytest.mark.asyncio
@pytest.mark.parametrize('waiter', ['ready', 'first_factor'])
async def test_disconnected_browser_fails_without_polling_until_stage_deadline(waiter):
    polls = 0
    async def evaluate(*args, **kwargs):
        nonlocal polls
        polls += 1
        raise ConnectionError('synthetic CDP closed')
    cdp = SimpleNamespace(evaluate=evaluate)
    with pytest.raises(RuntimeError, match='^CONTAINER_UNAVAILABLE$'):
        await (m._wait_login_ready(cdp) if waiter == 'ready' else m._wait_first_factor(cdp, []))
    assert polls == 1


@pytest.mark.asyncio
async def test_captcha_after_password_submission_is_a_terminal_verdict(monkeypatch):
    async def evaluate(*args, **kwargs):
        return {'url':'https://sso.cqu.edu.cn/login', 'text':'校验码', 'error':'', 'captcha':True}
    monkeypatch.setattr(m.browser_profile, 'FORMNAV_TIMEOUT_MS', 1)
    assert await m._wait_first_factor(SimpleNamespace(evaluate=evaluate), []) == 'captcha'
