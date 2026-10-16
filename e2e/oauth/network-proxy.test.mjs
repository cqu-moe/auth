import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import test from 'node:test';
import { webkit } from 'playwright-core';
import { startNetworkProxy } from './network-proxy.mjs';

test('proxy forwards real bodies and cookies and rejects unplanned origins and tunnels', async t => {
  let reached = 0;
  const server = createServer(async (req, res) => {
    reached++;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.writeHead(201, { 'set-cookie': 'reply=synthetic; Path=/' }).end(`${req.headers.cookie}|${Buffer.concat(chunks)}`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://localhost:${server.address().port}`;
  const proxy = await startNetworkProxy([origin]);
  t.after(() => proxy.close());
  const call = (path, method = 'POST') => new Promise((resolve, reject) => {
    const outgoing = request(proxy.origin, { method, path, headers: { cookie: 'request=synthetic' } });
    outgoing.once('error', reject);
    outgoing.once('connect', (response, socket) => { socket.destroy(); resolve({ status: response.statusCode }); });
    outgoing.once('response', async response => {
      const chunks = [];
      for await (const chunk of response) chunks.push(chunk);
      resolve({ status: response.statusCode, cookie: response.headers['set-cookie'], body: Buffer.concat(chunks).toString() });
    });
    outgoing.end(method === 'POST' ? 'unchanged-body' : undefined);
  });
  assert.deepEqual(await call(origin), { status: 201, cookie: ['reply=synthetic; Path=/'], body: 'request=synthetic|unchanged-body' });
  proxy.assertTraffic();
  assert.equal((await call('http://127.0.0.1:1/')).status, 403);
  assert.equal((await call('unplanned.example:443', 'CONNECT')).status, 403);
  assert.equal(reached, 1);
  assert.throws(() => proxy.assertTraffic(), /unplanned origin/);
});

test('Linux WebKit forwards both loopback origins and cancelled requests while blocking other origins', {
  skip: process.platform !== 'linux' ? 'Proxy adapter is Linux-only; macOS CFNetwork bypasses loopback proxies (Playwright #20328)' : false,
}, async t => {
  let forbiddenHits = 0, proxy, browser;
  async function listen(handler) {
    const server = createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }));
    return `http://localhost:${server.address().port}`;
  }
    const first = await listen(async (req, res) => {
      if (req.url === '/pending') return;
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'proxy-proof=synthetic; Path=/' });
      res.end(req.method === 'POST' ? `${req.headers.cookie}|${Buffer.concat(chunks)}` : 'real first application');
    });
    const second = await listen((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('real second application'); });
    const forbidden = await listen((_req, res) => { forbiddenHits++; res.writeHead(200, { 'content-type': 'text/html' }); res.end('must not reach'); });
    proxy = await startNetworkProxy([first, second]);
    t.after(() => proxy.close());
    browser = await webkit.launch({ headless: true, proxy: { server: proxy.origin } });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(first);
    assert.equal(await page.locator('body').innerText(), 'real first application');
    assert.equal(await page.evaluate(async () => (await fetch('/', { method: 'POST', body: 'unchanged-body' })).text()),
      'proxy-proof=synthetic|unchanged-body');
    await page.evaluate(() => { void fetch('/pending').catch(() => {}); });
    await page.goto(second);
    assert.equal(await page.locator('body').innerText(), 'real second application');
    proxy.assertTraffic();
    assert.equal((await page.goto(forbidden)).status(), 403);
    assert.equal(forbiddenHits, 0);
    assert.throws(() => proxy.assertTraffic(), /unplanned origin/);
});
