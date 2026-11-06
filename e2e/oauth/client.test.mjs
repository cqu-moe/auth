import assert from 'node:assert/strict';
import test from 'node:test';
import { startOAuthClientApp } from './client.mjs';

test('client launch commits HTML before the unchanged cross-site PKCE redirect', async t => {
  const authOrigin = 'http://localhost:12345';
  const app = await startOAuthClientApp({ authOrigin, registerSecret: async () => {} });
  t.after(() => app.close());
  const launch = await fetch(`${app.origin}/launch?device=one&client=first`);
  assert.equal(launch.status, 200);
  assert.match(launch.headers.get('content-type'), /text\/html/);
  assert.match(await launch.text(), /href="\/start\?device=one&amp;client=first"/);
  const start = await fetch(`${app.origin}/start?device=one&client=first`, { redirect: 'manual' });
  assert.equal(start.status, 302);
  const target = new URL(start.headers.get('location'));
  assert.equal(target.origin, authOrigin);
  assert.notEqual(new URL(app.origin).hostname, target.hostname);
  assert.equal(target.pathname, '/api/v1/auth/oauth2/authorize');
  assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(target.searchParams.get('code_challenge'));
  assert.ok(target.searchParams.get('state'));
  assert.equal(target.searchParams.get('redirect_uri'), `${app.origin}/callback`);
  for (const route of ['launch', 'start']) {
    assert.equal((await fetch(`${app.origin}/${route}?device=invalid%22&client=first`)).status, 400);
    assert.equal((await fetch(`${app.origin}/${route}?device=one&client=unknown`)).status, 400);
  }
});
