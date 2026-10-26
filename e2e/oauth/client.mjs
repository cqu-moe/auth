import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { turnstileHeaders } from '../turnstile.mjs';

const b64url = value => Buffer.from(value).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

async function keyPair() {
  const pair = await generateKeyPair('ES256', { extractable: true });
  return { pair, jwk: await exportJWK(pair.publicKey) };
}

async function proof(key, url, accessToken) {
  const token = new SignJWT({
    htm: 'POST',
    htu: new URL(url).origin + new URL(url).pathname,
    ...(accessToken ? { ath: b64url(createHash('sha256').update(accessToken).digest()) } : {}),
  })
    .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk: key.jwk })
    .setIssuedAt(now())
    .setJti(randomUUID())
    .sign(key.pair.privateKey);
  return token;
}

async function resourceProof(key, request, accessToken) {
  return new SignJWT({
    htm: request.method,
    htu: new URL(request.url).origin + new URL(request.url).pathname,
    ath: b64url(createHash('sha256').update(accessToken).digest()),
  })
    .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk: key.jwk })
    .setIssuedAt(now())
    .setJti(randomUUID())
    .sign(key.pair.privateKey);
}

async function challenge(verifier) {
  return b64url(createHash('sha256').update(verifier).digest());
}

function page(title, status, details = []) {
  const rows = details.map(value => `<li>${String(value).replace(/[<>&]/g, '')}</li>`).join('');
  return `<!doctype html><html lang="zh-CN"><body data-status="${status}"><main>
<h1>${title}</h1><ul>${rows}</ul></main></body></html>`;
}

export function startOAuthClientApp({ authOrigin, accountPassword, business, registerSecret }) {
  const issuer = `${authOrigin}/api/auth`;
  const tokenEndpoint = `${authOrigin}/api/v1/auth/oauth2/token`;
  const userinfoEndpoint = `${authOrigin}/api/v1/auth/oauth2/userinfo`;
  const clients = {
    first: {
      id: 'auth-oauth-first-party', secret: 'synthetic-oauth-first-party-secret', dpop: true,
      scopes: ['openid', 'email', 'offline_access'],
    },
    ordinary: {
      id: 'auth-oauth-ordinary', secret: 'synthetic-oauth-ordinary-secret', dpop: false,
      scopes: ['openid', 'email', 'offline_access'],
    },
    imposter: {
      id: 'auth-oauth-official-imposter', secret: 'synthetic-oauth-imposter-secret', dpop: false,
      scopes: ['openid', 'offline_access', 'cqu:quicklogin:device'],
    },
  };
  const events = [];
  const fingerprint = value => createHash("sha256").update(value ?? "").digest("hex").slice(0, 12);
  const pendings = new Map();
  const grants = new Map();

  async function tokenRequest(client, body, key, proofOverride) {
    const headers = {
      origin: authOrigin,
      authorization: `Basic ${Buffer.from(`${client.id}:${client.secret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    };
    if (client.dpop && key) headers.dpop = proofOverride ?? await proof(key, tokenEndpoint);
    if (headers.dpop) await registerSecret(headers.dpop);
    const response = await fetch(tokenEndpoint, { method: 'POST', headers, body: new URLSearchParams(body) });
    const result = await response.json().catch(() => ({}));
    events.push({ kind: 'token', grant: body.grant_type, code: body.code ? fingerprint(body.code) : undefined, status: response.status, error: result.error, description: result.error_description });
    for (const value of [result.access_token, result.refresh_token, result.id_token].filter(Boolean)) await registerSecret(value);
    return { status: response.status, result };
  }

  async function resourceRequest(grant, authorizationMode = 'dpop') {
    const headers = new Headers();
    headers.set('authorization', `${grant.client.dpop ? 'DPoP' : 'Bearer'} ${grant.accessToken}`);
    if (grant.client.dpop) {
      if (authorizationMode === 'dpop') headers.set('dpop', await resourceProof(grant.key, new Request(userinfoEndpoint), grant.accessToken));
      else if (authorizationMode === 'replay') headers.set('dpop', grant.lastProof);
    }
    if (grant.client.dpop && authorizationMode === 'dpop') grant.lastProof = headers.get('dpop');
    if (headers.get('dpop')) await registerSecret(headers.get('dpop'));
    return fetch(userinfoEndpoint, { headers });
  }

  async function exchange(pending, code, verifierOverride, redirectOverride) {
    return tokenRequest(pending.client, {
      grant_type: 'authorization_code',
      client_id: pending.client.id,
      code,
      code_verifier: verifierOverride ?? pending.verifier,
      redirect_uri: redirectOverride ?? pending.redirectUri,
      resource: issuer,
    }, pending.key);
  }

  async function authority(grant) {
    const response = await fetch(`${authOrigin}/api/v1/auth/oauth2/introspect`, {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { authorization: `Basic ${Buffer.from(`${grant.client.id}:${grant.client.secret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: grant.accessToken, token_type_hint: 'access_token' }),
    });
    if (!response.ok) throw new Error(`OAuth authority unavailable (${response.status})`);
    const result = await response.json();
    return { ...result, active: result.active === true && result.client_id === grant.client.id
      && typeof result.sub === 'string' && typeof result.sid === 'string' && result.exp > now() };
  }

  async function authorizeCode(email, overrides = {}, client = clients.first, reusedCookie) {
    let login = null;
    if (!reusedCookie) {
      const deadline = Date.now() + 45000;
      for (;;) {
        login = await fetch(`${authOrigin}/api/v1/auth/sign-in/email`, {
          method: 'POST', headers: { origin: authOrigin, 'content-type': 'application/json', ...turnstileHeaders('/auth/sign-in/email', authOrigin) },
          body: JSON.stringify({ email, password: accountPassword }),
          signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        });
        events.push({ kind: 'negative-login', status: login.status });
        if (login.status !== 429) break;
        const seconds = Number(login.headers.get('retry-after') ?? login.headers.get('x-retry-after') ?? NaN);
        await login.arrayBuffer();
        const delay = Math.max(1000, seconds * 1000 + 100);
        if (!Number.isFinite(seconds) || seconds < 0 || Date.now() + delay >= deadline) {
          throw new Error('Negative-control login rate limit has no bounded Retry-After');
        }
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    let cookie = reusedCookie;
    if (login) {
      if (!login.ok) throw new Error(`Negative-control login failed (${login.status})`);
      cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
      await login.arrayBuffer();
    }
    const verifier = b64url(randomBytes(48));
    const key = await keyPair();
    const query = new URLSearchParams({
      response_type: 'code', client_id: client.id, redirect_uri: overrides.redirectUri ?? `${origin}/callback`,
      scope: overrides.scope ?? client.scopes.join(' '), state: randomUUID(), prompt: 'consent', resource: overrides.resource ?? issuer,
      code_challenge: await challenge(overrides.verifier ?? verifier), code_challenge_method: 'S256',
    });
    const response = await fetch(`${authOrigin}/api/v1/auth/oauth2/authorize?${query}`, {
      headers: { cookie, accept: 'application/json' }, redirect: 'manual',
    });
    const body = await response.json().catch(() => ({}));
    let target = response.headers.get('location') ?? body.url ?? body.redirect_uri;
    if ((!response.ok && response.status !== 302) || !target) return { status: response.status, code: null, error: body.error ?? body.code };
    await registerSecret(verifier, ...cookie.split('; ').map(value => value.slice(value.indexOf('=') + 1)));
    let callback = new URL(target, authOrigin);
    if (callback.pathname === '/oauth/authorize') {
      const consent = await fetch(`${authOrigin}/api/v1/auth/oauth2/consent`, {
        method: 'POST',
        headers: { cookie, accept: 'application/json', origin: authOrigin, 'content-type': 'application/json' },
        body: JSON.stringify({ accept: true, oauth_query: callback.searchParams.toString() }),
      });
      const consentBody = await consent.json().catch(() => ({}));
      target = consent.headers.get('location') ?? consentBody.url ?? consentBody.redirect_uri;
      if (!consent.ok || !target) return { status: consent.status, code: null, error: consentBody.error ?? consentBody.code };
      callback = new URL(target, authOrigin);
    }
    if (callback.searchParams.get('code')) await registerSecret(callback.searchParams.get('code'));
    return { error: callback.searchParams.get('error'), status: response.ok && callback.searchParams.get('code') ? 200 : response.status,
      code: callback.searchParams.get('code'), verifier, cookie, client, redirectUri: `${origin}/callback`, key };
  }

  let origin;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      let body = '';
      for await (const chunk of req) body += chunk;
      const input = body ? JSON.parse(body) : {};

      if (req.method === 'GET' && url.pathname === '/start') {
        const deviceName = url.searchParams.get('device') ?? '';
        const device = /^[a-z0-9-]{1,48}$/i.test(deviceName);
        const client = clients[url.searchParams.get('client') ?? ''];
        if (!device || !client) return res.writeHead(400).end('Invalid OAuth device');
        const verifier = b64url(randomBytes(48));
        const state = b64url(randomBytes(32));
        const key = client.dpop ? await keyPair() : null;
        const redirectUri = `${origin}/callback`;
        pendings.set(state, { device: deviceName, client, verifier, redirectUri, key });
        await registerSecret(verifier, state);
        const query = new URLSearchParams({
          response_type: 'code', client_id: client.id, redirect_uri: redirectUri,
          scope: client.scopes.join(' '), state, prompt: 'consent', resource: issuer,
          code_challenge: await challenge(verifier), code_challenge_method: 'S256',
        });
        res.writeHead(302, { location: `${authOrigin}/api/v1/auth/oauth2/authorize?${query}` }).end();
        return;
      }

      if (req.method === 'GET' && url.pathname === '/callback') {
        const state = url.searchParams.get('state') ?? '';
        const pending = pendings.get(state);
        events.push({ kind: 'callback', device: pending?.device, code: fingerprint(url.searchParams.get('code')), pending: Boolean(pending) });
        const code = url.searchParams.get('code');
        if (!pending || !code) return res.writeHead(400).end(page('OAuth callback rejected', 'invalid')).end();
        await registerSecret(code);
        const issued = await exchange(pending, code);
        if (issued.status !== 200 || !issued.result.access_token || !issued.result.refresh_token) {
          return res.writeHead(401).end(page('OAuth token exchange failed', 'unauthorized', [
            `error=${issued.result.error ?? 'unknown'}`,
            `description=${issued.result.error_description ?? issued.result.message ?? 'unknown'}`,
          ]));
        }
        grants.set(pending.device, {
          device: pending.device, client: pending.client, key: pending.key,
          accessToken: issued.result.access_token, refreshToken: issued.result.refresh_token,
          email: null, tokenType: issued.result.token_type,
        });
        pendings.delete(state);
        return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          .end(page(`OAuth ${pending.device} ready`, 'active'));
      }

      const deviceMatch = /^\/device\/([a-z0-9-]+)$/i.exec(url.pathname);
      if (req.method === 'GET' && deviceMatch) {
        const grant = grants.get(deviceMatch[1]);
        if (!grant) return res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' }).end(page('OAuth device unavailable', 'unauthorized'));
        const current = await authority(grant);
        if (!current.active) return res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' }).end(page('OAuth authority ended', 'unauthorized'));
        const response = await resourceRequest(grant);
        if (!response.ok) return res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' }).end(page(`OAuth ${grant.device} unavailable`, 'unauthorized'));
        const claims = await response.json();
        grant.email = claims.email;
        if (current.caps?.calendar?.external !== true) return res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' }).end(page('OAuth business entitlement required', 'forbidden'));
        const result = await business(grant.email);
        if (result.error) return res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' }).end(page(`OAuth ${grant.device} business denied`, 'forbidden'));
        return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          .end(page(`OAuth ${grant.device} active`, 'active', [grant.email, result.items[0].name]));
      }

      const authorityMatch = /^\/authority\/([a-z0-9-]+)$/i.exec(url.pathname);
      if (req.method === 'GET' && authorityMatch) {
        const grant = grants.get(authorityMatch[1]);
        if (!grant) return res.writeHead(404).end(JSON.stringify({ error: 'unknown-device' }));
        const result = await authority(grant);
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          active: result.active, tokenType: grant.tokenType.toLowerCase(),
          hasBusinessClaims: Boolean(result.caps), external: result.caps?.calendar?.external ?? null,
          client: grant.client.id, sessionId: result.sid ?? null,
        }));
      }

      const infoMatch = /^\/userinfo\/([a-z0-9-]+)$/i.exec(url.pathname);
      if (req.method === 'GET' && infoMatch && grants.has(infoMatch[1])) {
        const response = await resourceRequest(grants.get(infoMatch[1]));
        const claims = await response.json();
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: response.status, email: claims.email ?? null }));
      }

      const officialMatch = /^\/official-device\/([a-z0-9-]+)$/i.exec(url.pathname);
      if (req.method === 'GET' && officialMatch) {
        const grant = grants.get(officialMatch[1]);
        if (!grant) return res.writeHead(404).end(JSON.stringify({ error: 'unknown-device' }));
        const response = await fetch(`${authOrigin}/api/v1/cqu/quicklogin/devices`, {
          method: 'POST', headers: { authorization: `Bearer ${grant.accessToken}`,
            origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'content-type': 'application/json' },
          body: JSON.stringify({ deviceName: 'ordinary-imposter', browserFamily: 'chrome', browserVersion: '140' }),
        });
        const result = await response.json();
        return res.writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ status: response.status, code: result.error?.code ?? null }));
      }

      const refreshMatch = /^\/refresh-result\/([a-z0-9-]+)$/i.exec(url.pathname);
      if (refreshMatch && grants.has(refreshMatch[1])) {
        const grant = grants.get(refreshMatch[1]);
        if (req.method !== 'POST') return res.writeHead(405).end();
        const previous = grant.refreshToken;
        const issued = await tokenRequest(grant.client, {
          grant_type: 'refresh_token', client_id: grant.client.id, refresh_token: previous, resource: issuer,
        }, grant.key);
        if (issued.status !== 200 || !issued.result.access_token || !issued.result.refresh_token) {
          return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ refreshed: false, status: issued.status }));
        }
        grant.accessToken = issued.result.access_token;
        grant.refreshToken = issued.result.refresh_token;
        const replay = url.searchParams.has('replay') ? await tokenRequest(grant.client, {
          grant_type: 'refresh_token', client_id: grant.client.id, refresh_token: previous, resource: issuer,
        }, grant.key) : null;
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ refreshed: true, rotated: previous !== grant.refreshToken, oldRefreshRejected: replay ? replay.status === 400 && replay.result.error === 'invalid_grant' : null, status: issued.status }));
      }

      const dpopMatch = /^\/dpop\/([a-z0-9-]+)$/i.exec(url.pathname);
      if (req.method === 'GET' && dpopMatch && grants.has(dpopMatch[1])) {
        const grant = grants.get(dpopMatch[1]);
        if (!grant.client.dpop) return res.writeHead(400).end(JSON.stringify({ error: 'not-dpop' }));
        const userinfo = await resourceRequest(grant, 'dpop');
        const replay = await resourceRequest(grant, 'replay');
        const missing = await resourceRequest(grant, 'missing');
        const bearer = await fetch(userinfoEndpoint, { headers: { authorization: `Bearer ${grant.accessToken}` } });
        const refreshFields = () => ({ grant_type: 'refresh_token', client_id: grant.client.id,
          refresh_token: grant.refreshToken, resource: issuer });
        // Wrong/missing proofs use an unconsumed credential. A later same-key
        // success proves those denials came from proof binding, not rotation.
        const wrongRefresh = await tokenRequest(grant.client, refreshFields(), await keyPair());
        const missingRefresh = await tokenRequest(grant.client, refreshFields());
        const refreshProof = await proof(grant.key, tokenEndpoint);
        const refreshed = await tokenRequest(grant.client, refreshFields(), grant.key, refreshProof);
        if (refreshed.status === 200 && refreshed.result.access_token && refreshed.result.refresh_token) {
          grant.accessToken = refreshed.result.access_token;
          grant.refreshToken = refreshed.result.refresh_token;
          grant.tokenType = refreshed.result.token_type;
        }
        const proofReplay = await tokenRequest(grant.client, refreshFields(), grant.key, refreshProof);
        const continued = await tokenRequest(grant.client, refreshFields(), grant.key);
        if (continued.status === 200) {
          grant.accessToken = continued.result.access_token; grant.refreshToken = continued.result.refresh_token;
          grant.tokenType = continued.result.token_type;
        }
        const after = await resourceRequest(grant);
        const afterClaims = await after.json();
        const afterBearer = await fetch(userinfoEndpoint, { headers: { authorization: `Bearer ${grant.accessToken}` } });
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          userinfo: userinfo.status, replay: replay.status, missingProof: missing.status,
          bearerDowngrade: bearer.status, sameKeyRefresh: refreshed.status === 200,
          wrongKeyRefresh: { status: wrongRefresh.status, error: wrongRefresh.result.error },
          missingRefresh: { status: missingRefresh.status, error: missingRefresh.result.error },
          refreshProofReplay: { status: proofReplay.status, error: proofReplay.result.error },
          continuedRefresh: continued.status, afterRefresh: after.status, afterRefreshEmail: afterClaims.email ?? null,
          refreshedType: grant.tokenType.toLowerCase(), afterRefreshBearer: afterBearer.status,
        }));
      }

      if (req.method === 'POST' && url.pathname === '/negative') {
        const initial = await authorizeCode(input.email);
        if (!initial.code || !initial.cookie) throw new Error('Negative controls require a real authorized source');
        const authorize = (overrides = {}, client = clients.first) => authorizeCode(input.email, overrides, client, initial.cookie);
        const authorized = async (overrides = {}) => {
          const value = await authorize(overrides);
          if (!value.code) throw new Error(`Control authorization failed (${value.status}, ${value.error})`);
          return value;
        };
        const denial = value => ({ status: value.status, error: value.result?.error ?? value.error,
          rejected: !value.result?.access_token && !value.code });
        const wrongSource = await authorized();
        const wrongVerifier = await exchange(wrongSource, wrongSource.code, 'wrong-verifier-012345678901234567890123456789');
        const callbackSource = await authorized();
        const wrongCallback = await exchange(callbackSource, callbackSource.code, undefined, 'http://127.0.0.1:1/attacker');
        const invalidResource = await authorize({ resource: 'https://attacker.example/resource' });
        const invalidScope = await authorize({ scope: 'openid unauthorized:scope' });
        const imposter = await authorize({}, clients.imposter);
        const officialDeviceIdentity = imposter.code ? await exchange(imposter, imposter.code) : imposter;
        const noProofSource = await authorized();
        const missingIssueProof = await tokenRequest(clients.first, {
          grant_type: 'authorization_code', client_id: clients.first.id, code: noProofSource.code,
          code_verifier: noProofSource.verifier, redirect_uri: noProofSource.redirectUri, resource: issuer,
        });
        const first = await exchange(initial, initial.code);
        if (first.status !== 200 || !first.result.access_token) throw new Error('Code replay control requires successful first exchange');
        const replay = await exchange(initial, initial.code);
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          wrongVerifier: denial(wrongVerifier), wrongCallback: denial(wrongCallback),
          invalidResource: denial(invalidResource), invalidScope: denial(invalidScope),
          officialDeviceIdentity: denial(officialDeviceIdentity), missingIssueProof: denial(missingIssueProof),
          firstExchange: { status: first.status, issued: true, tokenType: first.result.token_type.toLowerCase() },
          replay: denial(replay),
        }));
      }

      return res.writeHead(404).end('Unknown OAuth application route');
    } catch (error) {
      events.push({ kind: 'client-error', message: error.message });
      res.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        .end(JSON.stringify({ error: error.message }));
    }
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve({
        origin,
        redirectUri: `${origin}/callback`,
        diagnostics: () => [...events],
        async close() { await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())); },
      });
    });
  });
}
