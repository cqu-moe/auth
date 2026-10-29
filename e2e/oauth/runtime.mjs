import { checkArtifacts as checkKnownArtifacts } from '../artifacts.mjs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startSchoolAuth } from '../school/runtime.mjs';
import { prepareSchoolBinding } from '../school/prepare-binding.mjs';
import { startOAuthClientApp } from './client.mjs';
import { turnstileHeaders } from '../turnstile.mjs';

async function registerSecrets(controlOrigin, values) {
  if (!values.length) return;
  const response = await fetch(`${controlOrigin}/artifact-secret`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ values }),
  });
  if (!response.ok) throw new Error('OAuth artifact-secret registration failed');
}

async function prepareRecoveryAdmin(runtime, remember) {
  const email = 'oauth-recovery-admin@example.test';
  const password = 'Synthetic-only-123!';
  const account = await runtime.prepare({ email, password });
  await runtime.db.prepare("UPDATE user SET role='superAdmin' WHERE id=?").bind(account.userId).run();
  const jar = new Map();
  async function request(path, body, method = 'POST') {
    let response;
    const deadline = Date.now() + 90000;
    for (;;) {
      response = await fetch(`${runtime.origin}/api/v1${path}`, {
        method, signal: AbortSignal.timeout(30000),
        headers: {
          origin: runtime.origin, 'content-type': 'application/json',
          ...turnstileHeaders(path, runtime.origin),
          cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; '),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status !== 429) break;
      const seconds = Number(response.headers.get('retry-after') ?? response.headers.get('x-retry-after') ?? NaN);
      await response.arrayBuffer();
      if (!Number.isFinite(seconds) || seconds < 0 || Date.now() + seconds * 1000 > deadline) throw new Error('Admin setup rate limit has no bounded Retry-After');
      await new Promise(resolve => setTimeout(resolve, Math.max(1000, seconds * 1000 + 100)));
    }
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(';')[0]; const index = pair.indexOf('=');
      jar.set(pair.slice(0, index), pair.slice(index + 1));
      await remember(pair.slice(index + 1));
    }
    if (!response.ok) throw new Error(`OAuth recovery-admin preparation failed (${response.status}, ${path})`);
    return response.status === 204 ? null : response.json();
  }
  await request('/auth/sign-in/email', { email, password });
  await request('/auth/security/challenge', { password, purpose: 'mfa' });
  const enrollment = await request('/auth/two-factor/enable', { password });
  await remember(enrollment.totpURI, ...enrollment.backupCodes);
  const { createOTP } = await import('@better-auth/utils/otp');
  const { base32 } = await import('@better-auth/utils/base32');
  const secret = new TextDecoder().decode(base32.decode(new URL(enrollment.totpURI).searchParams.get('secret')));
  await request('/auth/two-factor/verify-totp', { code: await createOTP(secret).totp() });
  const challenge = await request('/auth/security/challenge', { password, purpose: 'admin' });
  await remember(challenge.challenge);
  await request('/auth/security/complete', { challenge: challenge.challenge, method: 'totp', code: await createOTP(secret).totp() });
  const status = await request('/auth/security/status', undefined, 'GET');
  if (status.strong !== true) throw new Error('OAuth recovery-admin strong admission missing');

  return {
    async recover(email) {
      const user = await runtime.db.prepare('SELECT id FROM "user" WHERE email=?').bind(email).first();
      if (!user) throw new Error('Recovery target missing');
      const response = await fetch(`${runtime.origin}/api/v1/auth/admin/reset-authentication`, {
        method: 'POST', signal: AbortSignal.timeout(30000),
        headers: { origin: runtime.origin, 'content-type': 'application/json', cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; ') },
        body: JSON.stringify({ userId: user.id }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.password) throw new Error(`Administrator recovery failed (${response.status})`);
      await remember(result.password);
      return { password: result.password };
    },
  };
}

export async function startOAuthAuth(options = {}) {
  const runtime = await startSchoolAuth({ ...options, authBindings: { QUICKLOGIN_EXTENSION_ORIGIN: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } });
  const secrets = new Set(['synthetic-oauth-first-party-secret', 'synthetic-oauth-ordinary-secret', 'synthetic-oauth-imposter-secret']);
  async function remember(...values) {
    const safe = values.filter(value => typeof value === 'string' && value.length);
    safe.forEach(value => secrets.add(value));
    await registerSecrets(runtime.controlOrigin, safe);
  }
  let app;
  let control;
  let recoveryAdmin;
  try {
    app = await startOAuthClientApp({
      authOrigin: runtime.origin,
      accountPassword: 'Synthetic-only-123!',
      business: async email => {
        const response = await fetch(`${runtime.schoolOrigin}/directory`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }),
          signal: AbortSignal.timeout(150000),
        });
        if (!response.ok) throw new Error('School business readback failed');
        return response.json();
      },
      registerSecret: remember,
    });

    const secretHash = secret => createHash('sha256').update(secret).digest('base64url');
    const now = new Date().toISOString();
    for (const [key, value] of [
      ['auth-oauth-first-party', JSON.stringify({ subsystem: 'calendar' })],
      ['auth-oauth-ordinary', JSON.stringify({ subsystem: 'calendar' })],
      ['auth-oauth-official-imposter', JSON.stringify({ subsystem: 'calendar' })],
    ]) {
      await runtime.db.prepare(`INSERT INTO oauthClient(
        id,clientId,clientSecret,disabled,skipConsent,subjectType,scopes,createdAt,updatedAt,name,
        redirectUris,tokenEndpointAuthMethod,grantTypes,responseTypes,public,type,requirePKCE,metadata,dpopBoundAccessTokens
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(
          crypto.randomUUID(), key, secretHash({
            'auth-oauth-first-party': 'synthetic-oauth-first-party-secret',
            'auth-oauth-ordinary': 'synthetic-oauth-ordinary-secret',
            'auth-oauth-official-imposter': 'synthetic-oauth-imposter-secret',
          }[key]),
          0, key === 'auth-oauth-first-party' ? 1 : 0, 'public',
          JSON.stringify(key === 'auth-oauth-official-imposter'
            ? ['openid', 'offline_access', 'cqu:quicklogin:device']
            : ['openid', 'email', 'offline_access']), now, now, key,
          JSON.stringify([app.redirectUri]), 'client_secret_basic', JSON.stringify(['authorization_code', 'refresh_token']),
          JSON.stringify(['code']), 0, 'web', 1, value, key === 'auth-oauth-first-party' ? 1 : 0,
        ).run();
    }

    control = createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        let body = ''; for await (const chunk of req) body += chunk;
        const input = body ? JSON.parse(body) : {};
        let value;
        if (url.pathname === '/protect') {
          await remember(...input.values); value = { protected: true };
        } else if (url.pathname === '/prepare') {
          const identity = await prepareSchoolBinding(runtime, { email: input.email, password: 'Synthetic-only-123!' });
          value = { email: identity.email, studentId: identity.studentId };
        } else if (url.pathname === '/directory') {
          const response = await fetch(`${runtime.schoolOrigin}/directory`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
            signal: AbortSignal.timeout(150000),
          });
          value = await response.json();
        } else if (url.pathname === '/ban' || url.pathname === '/entitlement') {
          const response = await fetch(`${runtime.schoolOrigin}${url.pathname}`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
            signal: AbortSignal.timeout(30000),
          });
          if (!response.ok) throw new Error(`School admin prerequisite failed (${response.status}, ${url.pathname})`);
          value = await response.json();
        } else if (url.pathname === '/recover') {
          recoveryAdmin ??= await prepareRecoveryAdmin(runtime, remember);
          value = await recoveryAdmin.recover(input.email);
        } else throw new Error('Unknown OAuth control');
        res.setHeader('content-type', 'application/json').end(JSON.stringify(value));
      } catch (error) {
        res.writeHead(500, { 'cache-control': 'no-store' }).end(error.message);
      }
    });
    await new Promise(resolve => control.listen(0, '127.0.0.1', resolve));

    const baseClose = runtime.close.bind(runtime);
    return {
      ...runtime,
      oauthAppOrigin: app.origin,
      oauthControlOrigin: `http://127.0.0.1:${control.address().port}`,
      oauthDiagnostics: () => app.diagnostics(),
      async checkArtifacts(output) {
        await runtime.checkArtifacts(output);
        await checkKnownArtifacts(output, [...secrets]);
      },
      async redact(output) {
        await runtime.redact(output);
        async function visit(dir) {
          for (const item of await readdir(dir, { withFileTypes: true })) {
            const path = join(dir, item.name);
            if (item.isDirectory()) await visit(path);
            else if (/\.(json|md|log|txt)$/.test(item.name)) {
              let content = await readFile(path, 'utf8');
              for (const value of secrets) content = content.split(value).join('[oauth-secret-redacted]');
              await writeFile(path, content);
            }
          }
        }
        await visit(output);
      },
      async close() {
        const results = await Promise.allSettled([
          app.close(),
          new Promise((resolve, reject) => control.close(error => error ? reject(error) : resolve())),
          baseClose(),
        ]);
        const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
        if (errors.length) throw new AggregateError(errors, 'OAuth runtime cleanup failed');
        return results[2].value;
      },
    };
  } catch (error) {
    const cleanup = await Promise.allSettled([app?.close(), control?.listening ? new Promise((resolve, reject) => control.close(error => error ? reject(error) : resolve())) : undefined, runtime.close()]);
    const errors = cleanup.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError([error, ...errors], 'OAuth startup and cleanup failed');
    throw error;
  }
}
