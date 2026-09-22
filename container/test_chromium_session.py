import asyncio
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from aiohttp import web

import chromium_session as m
import cqu_login_cdp


@pytest.mark.asyncio
async def test_clean_websocket_eof_fails_pending_commands_immediately():
    stopped = asyncio.Event()
    class WebSocket:
        def __aiter__(self):
            return self
        async def __anext__(self):
            await stopped.wait()
            raise StopAsyncIteration
        async def send_json(self, message):
            stopped.set()
        async def close(self):
            pass
    session = m.CdpSession(WebSocket())
    try:
        with pytest.raises(ConnectionError):
            await asyncio.wait_for(session.call("Page.navigate"), timeout=0.1)
    finally:
        await session.close()


@pytest.mark.asyncio
async def test_response_body_wait_fails_when_browser_disconnects():
    cdp = SimpleNamespace(closed=False, disconnected=asyncio.Event())
    response = m.NetworkResponse(cdp, {'requestId':'synthetic', 'type':'Fetch',
        'response':{'url':'https://my.cqu.edu.cn/api/test', 'status':200, 'headers':{}}})
    body = asyncio.create_task(response.text())
    await asyncio.sleep(0)
    cdp.closed = True
    cdp.disconnected.set()
    with pytest.raises(ConnectionError):
        await asyncio.wait_for(body, timeout=0.1)


@pytest.mark.asyncio
@pytest.mark.parametrize('fulfill_fails', [False, True])
async def test_storage_helper_has_own_deadline_and_closes_target(monkeypatch, fulfill_fails):
    handlers = {}
    closed_targets = []
    async def parent_call(method, params=None, **kwargs):
        if method == 'Target.createTarget':
            return {'targetId': 'synthetic'}
        if method == 'Target.closeTarget':
            closed_targets.append(params['targetId'])
        return {}
    async def page_call(method, params=None, **kwargs):
        if method == 'Page.navigate':
            handlers['Fetch.requestPaused']({'requestId':'synthetic'})
        if method == 'Fetch.fulfillRequest' and fulfill_fails:
            raise RuntimeError('synthetic interception failed')
        return {}
    page = SimpleNamespace(call=page_call, close=AsyncMock(),
        on=lambda event, callback: handlers.update({event: callback}),
        disconnected=asyncio.Event(), closed=False)
    browser = m.ChromiumSession()
    browser.cdp = SimpleNamespace(call=parent_call)
    browser.http = SimpleNamespace(ws_connect=AsyncMock())
    browser.port = 43123
    monkeypatch.setattr(m, 'CdpSession', lambda _: page)
    monkeypatch.setattr(m, '_first_page_websocket', AsyncMock(return_value='ws://synthetic'))
    monkeypatch.setattr(m, 'STORAGE_PAGE_TIMEOUT_S', 0.02, raising=False)
    outer = asyncio.timeout(0.5)
    with pytest.raises(TimeoutError):
        async with outer:
            await browser._storage_page(['https://sso.cqu.edu.cn'])
    assert not outer.expired()
    assert closed_targets == ['synthetic']
    page.close.assert_awaited_once()


@pytest_asyncio.fixture
async def fixture_site():
    app = web.Application()
    calls = []
    async def page(_request):
        return web.Response(text="""<html><body>
          <button id="hidden" style="visibility:hidden">获取验证码</button>
          <button id="send" disabled>获取验证码</button>
          <script>
          setTimeout(()=>document.querySelector('#send').disabled=false,100);
          document.querySelector('#send').onclick=e=>{
            window.clicked=e.isTrusted; fetch('/api/my-table-detail');
          };
          </script></body></html>""", content_type="text/html")
    async def table(request):
        calls.append(request.path)
        response = web.StreamResponse(headers={"Content-Type": "application/json"})
        await response.prepare(request)
        await response.write(b'{"data":')
        await asyncio.sleep(0.15)
        await response.write(b'"complete"}')
        await response.write_eof()
        return response
    async def redirect(request):
        raise web.HTTPFound(request.query.get('service', '/callback') + '?ticket=ST-synthetic')
    async def callback(request):
        calls.append(request.path)
        return web.Response(text="ticket consumed")
    async def curriculum(_request):
        return web.Response(text='''<script>
          localStorage.setItem('cqu_edu_ACCESS_TOKEN','"fixture-token"');
          fetch('/api/my-table-detail', {method:'POST'});
          </script>''', content_type='text/html')
    async def exams(request):
        assert request.headers['Authorization'] == 'Bearer fixture-token'
        calls.append(request.path)
        return web.json_response({'exams': ['complete']})
    async def identity(request):
        return web.json_response({'ua': request.headers['User-Agent']})
    app.add_routes([web.get('/', page), web.get('/api/my-table-detail', table),
                    web.post('/api/my-table-detail', table), web.get('/workspace/curriculum', curriculum),
                    web.get('/api/exams', exams), web.get('/identity', identity),
                    web.get('/login', redirect), web.get('/callback', callback)])
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '127.0.0.1', 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    try:
        yield f'http://127.0.0.1:{port}', calls
    finally:
        await runner.cleanup()


@pytest.mark.asyncio
async def test_real_browser_native_click_captures_complete_body(fixture_site, monkeypatch, tmp_path):
    origin, calls = fixture_site
    monkeypatch.setenv('CQU_CDP_RUNTIME_DIR', str(tmp_path))
    async with m.ChromiumSession() as browser:
        responses = []
        browser.on_response(lambda response: responses.append(response)
                            if '/my-table-detail' in response.url else None)
        await browser.navigate(origin + '/', timeout_s=5)
        await browser.click_text('.font-class-text-button,button,span,a', '获取验证码', timeout_s=3)
        await browser.cdp.wait_js('window.clicked === true', 2)
        for _ in range(100):
            if responses:
                break
            await asyncio.sleep(0.02)
        assert await responses[0].text() == '{"data":"complete"}'
        assert calls == ['/api/my-table-detail']
        values = await browser.evaluate("({locale:Intl.DateTimeFormat().resolvedOptions().locale,zone:Intl.DateTimeFormat().resolvedOptions().timeZone,width:innerWidth,height:innerHeight})")
        assert values == {'locale':'zh-CN','zone':'Asia/Shanghai','width':1440,'height':900}
        identity = await browser.evaluate("fetch('/identity').then(r=>r.json()).then(r=>({http:r.ua,js:navigator.userAgent,language:navigator.language}))")
        assert identity['http'] == identity['js']
        assert identity['language'] == 'zh-CN'
        if os.environ.get('DISPLAY'):
            assert 'HeadlessChrome' not in identity['js']
    assert list(tmp_path.iterdir()) == []


@pytest.mark.asyncio
async def test_click_does_not_accept_label_inside_disabled_button(fixture_site, monkeypatch, tmp_path):
    origin, _ = fixture_site
    monkeypatch.setenv('CQU_CDP_RUNTIME_DIR', str(tmp_path))
    async with m.ChromiumSession() as browser:
        await browser.navigate(origin + '/', timeout_s=5)
        await browser.evaluate("document.body.innerHTML='<button disabled><span class=font-class-text-button>获取验证码</span></button>'")
        with pytest.raises(RuntimeError, match='actionable'):
            await browser.click_text('.font-class-text-button,button,span,a', '获取验证码', timeout_s=0.2)


@pytest.mark.asyncio
async def test_real_browser_intercepts_redirect_ticket_before_callback(fixture_site, monkeypatch, tmp_path):
    origin, calls = fixture_site
    monkeypatch.setenv('CQU_CDP_RUNTIME_DIR', str(tmp_path))
    async with m.ChromiumSession() as browser:
        await browser.intercept_requests(lambda url: '/callback' in url)
        try:
            await browser.navigate(origin + '/login', timeout_s=5)
        except RuntimeError:
            pass
        for _ in range(100):
            if browser.tickets:
                break
            await asyncio.sleep(0.02)
        assert m.cqu_login.extract_ticket(browser.tickets) == 'ST-synthetic'
        assert '/callback' not in calls


@pytest.mark.asyncio
async def test_real_browser_seed_restored_once_and_exported(fixture_site, monkeypatch, tmp_path):
    origin, _ = fixture_site
    monkeypatch.setenv('CQU_CDP_RUNTIME_DIR', str(tmp_path))
    monkeypatch.setattr(m, 'is_school_origin', lambda value: value == origin)
    state = {'cookies': [], 'origins': [{'origin':origin,'localStorage':[{'name':'seed','value':'original'}]}]}
    async with m.ChromiumSession(seed_state=state) as browser:
        await browser.navigate(origin + '/', timeout_s=5)
        assert await browser.evaluate("localStorage.getItem('seed')") == 'original'
        await browser.evaluate("localStorage.setItem('seed','refreshed')")
        await browser.reload(timeout_s=5)
        assert await browser.evaluate("localStorage.getItem('seed')") == 'refreshed'
        exported = await browser.storage_state()
        assert exported['origins'] == [{'origin':origin,'localStorage':[{'name':'seed','value':'refreshed'}]}]


@pytest.mark.asyncio
async def test_real_browser_exports_storage_after_cross_origin_navigation(fixture_site, monkeypatch, tmp_path):
    first, _ = fixture_site
    second = first.replace('127.0.0.1', 'localhost')
    monkeypatch.setenv('CQU_CDP_RUNTIME_DIR', str(tmp_path))
    monkeypatch.setattr(m, 'is_school_origin', lambda value: value in (first, second))
    async with m.ChromiumSession() as browser:
        await browser.navigate(first + '/', timeout_s=5)
        await browser.evaluate("localStorage.setItem('first','retained')")
        await browser.navigate(second + '/', timeout_s=5)
        await browser.evaluate("localStorage.setItem('second','current')")
        exported = await browser.storage_state()
        assert {entry['origin']: entry['localStorage'] for entry in exported['origins']} == {
            first: [{'name':'first','value':'retained'}],
            second: [{'name':'second','value':'current'}],
        }


@pytest.mark.asyncio
async def test_real_harvest_captures_organic_post_then_supplemental_get(fixture_site, monkeypatch, tmp_path):
    import cqu_data_harvest as harvest
    origin, calls = fixture_site
    monkeypatch.setenv('CQU_CDP_RUNTIME_DIR', str(tmp_path))
    monkeypatch.setattr(m, 'is_school_origin', lambda value: value == origin)
    monkeypatch.setattr(harvest, 'classify_harvest_host', lambda url: 'direct' if url.startswith(origin + '/') else None)
    result = await harvest.harvest({'cookies': [], 'origins': []}, {
        'navUrl': origin + '/workspace/curriculum', 'capture': ['/my-table-detail'],
        'fetch': [{'url': origin + '/api/exams'}],
    })
    assert result['captures'][0]['body'] == '{"data":"complete"}'
    assert result['fetches'][0]['body'] == '{"exams": ["complete"]}'
    assert calls == ['/api/my-table-detail', '/api/exams']
    assert result['state']['origins'][0]['origin'] == origin
    assert list(tmp_path.iterdir()) == []


@pytest.mark.asyncio
async def test_real_ticket_and_keepalive_share_interception(fixture_site, monkeypatch, tmp_path):
    import cqu_ticket_browser as ticket
    import cqu_keepalive as keepalive
    origin, calls = fixture_site
    service = origin.replace('127.0.0.1', 'localhost') + '/callback'
    monkeypatch.setenv('CQU_CDP_RUNTIME_DIR', str(tmp_path))
    monkeypatch.setattr(ticket, 'SSO', origin)
    monkeypatch.setattr(ticket, 'SSO_HOST', '127.0.0.1')
    monkeypatch.setattr(keepalive, 'PROBE_SERVICE', service)
    state = {'cookies': [], 'origins': []}
    assert await ticket.fetch_service_ticket_browser(service, state) == 'ST-synthetic'
    result = await keepalive.probe_session_browser(state)
    assert result['status'] == 'alive'
    assert '/callback' not in calls
    assert list(tmp_path.iterdir()) == []


@pytest.mark.asyncio
@pytest.mark.parametrize('send_verdict', ['sent', 'already_valid'])
async def test_real_login_form_preserves_permit_and_code_source(monkeypatch, tmp_path, send_verdict):
    app = web.Application()
    order = []
    async def login(request):
        if request.method == 'GET':
            response = web.Response(text='<div id="login-croypto">MDEyMzQ1Njc4OWFiY2RlZg==</div><div id="login-page-flowkey">flow-1</div>', content_type='text/html')
            for name in ('CtLgrmkSWHBZO', 'CtLgrmkSWHBZP'):
                response.set_cookie(name, 'synthetic')
            return response
        fields = await request.post()
        assert request.query_string == ''
        if fields['type'] == 'UsernamePassword':
            order.append('password')
            assert fields['execution'] == 'flow-1'
            assert fields['password'] != 'synthetic-password'
            return web.Response(text='''<div>二次身份验证</div>
              <div id="login-page-flowkey">flow-2</div>
              <div class="ant-tabs-tab">邮件验证码</div><p>已绑定密保邮箱</p>
              <button onclick="fetch('/sendMailCode')">获取验证码</button>''', content_type='text/html')
        assert fields['type'] == 'mailLogin'
        assert fields['execution'] == 'flow-2'
        assert fields['password'] == ('fresh-code' if send_verdict == 'sent' else 'reusable-code')
        order.append('code-submitted')
        raise web.HTTPFound('/callback?ticket=ST-synthetic-login')
    async def send(_request):
        order.append('send')
        return web.json_response({'code': 200, 'data': {'result': True}} if send_verdict == 'sent'
                                 else {'code': 412, 'message': '您的验证码还在有效期内，请勿重复发送', 'data': {'result': False}})
    async def callback(_request):
        return web.Response(text='done')
    app.add_routes([web.get('/login', login), web.post('/login', login), web.get('/sendMailCode', send),
                    web.get('/callback', callback)])
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '127.0.0.1', 0)
    await site.start()
    origin = 'http://127.0.0.1:' + str(site._server.sockets[0].getsockname()[1])
    async def permit():
        order.append('permit')
    async def code():
        order.append('fresh-provider')
        return 'fresh-code'
    async def reusable():
        order.append('reusable-provider')
        return 'reusable-code'
    monkeypatch.setenv('CQU_CDP_RUNTIME_DIR', str(tmp_path))
    monkeypatch.setattr(cqu_login_cdp.cqu_login, 'SSO', origin)
    monkeypatch.setattr(cqu_login_cdp, 'interaction_jitter', lambda: asyncio.sleep(0))
    monkeypatch.setattr(m.browser_profile, 'TWO_FACTOR_SETTLE_WAIT_MS', 0)
    try:
        result = await cqu_login_cdp.run_login('synthetic', 'synthetic-password', origin+'/callback',
            code_provider=code, reusable_code_provider=reusable, permit_provider=permit)
        assert result['ticket'] == 'ST-synthetic-login'
        assert order == ['password', 'permit', 'send',
                         'fresh-provider' if send_verdict == 'sent' else 'reusable-provider', 'code-submitted']
    finally:
        await runner.cleanup()
