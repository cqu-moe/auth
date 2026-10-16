import { createHash, randomBytes } from 'node:crypto';
import { expect } from 'e2e';
import { protectArtifacts, type Fixture } from './auth-fixture';
import { request, responseFor, surface, type saveCookies } from './admin-fixture';

export async function concealCredentials() {
  await surface().page().addStyleTag({ content: 'body code, #recovery-password { visibility:hidden!important; }' });
}

export async function createClient(fixture: Fixture) {
  const { app, screen } = fixture;
  await app.open('/admin/oauth');
  await concealCredentials();
  await screen.getByRole('button', '新建客户端').click();
  await screen.getByLabel('名称', { exact: true }).fill('E2E 管理客户端');
  // The real provider requires HTTPS for confidential web clients. Protocol
  // assertions read the Location without following this synthetic callback.
  const redirectUri = 'https://client.example.test/callback?e2e=initial';
  await screen.getByLabel('添加回调 URI 第 1 项').fill(redirectUri);
  await screen.getByLabel('允许的 scope').fill('openid profile email offline_access');
  await screen.getByRole('checkbox', /^刷新令牌/).check();
  await screen.getByRole('switch', '跳过同意页').check();
  const creation = responseFor(/\/api\/v1\/admin\/oauth-clients$/, 'POST');
  await screen.getByRole('button', '创建', { exact: true }).click();
  const response = await creation;
  expect(response.status).toBe(201);
  const { data } = await response.json<{ data: { client_id: string; client_secret: string } }>();
  if (!data.client_secret) throw new Error('Confidential client creation returned no secret');
  await protectArtifacts([data.client_secret]);
  await expect(screen.getByRole('heading', '客户端创建成功')).toBeVisible();
  await screen.getByRole('button', '我已保存').click();
  await expect(screen.getByRole('heading', 'E2E 管理客户端')).toBeVisible();
  return { clientId: data.client_id, clientSecret: data.client_secret, redirectUri };
}

export async function authorization(clientId: string, redirectUri: string, cookies?: Awaited<ReturnType<typeof saveCookies>>) {
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
    scope: 'openid profile email offline_access', state: 'synthetic-admin-journey',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  });
  const response = await request(`/api/v1/auth/oauth2/authorize?${query}`, 'GET', undefined, cookies);
  const location = response.headers.get('location') ?? response.body?.url ?? response.body?.redirect_uri;
  const url = location ? new URL(location, process.env.AUTH_E2E_URL) : null;
  const code = url?.searchParams.get('code') ?? null;
  if (code) await protectArtifacts([code, verifier]);
  return { status: response.status, error: response.body?.error ?? url?.searchParams.get('error') ?? null, code, verifier };
}

export async function tokenRequest(fields: Record<string, string>, clientId: string, clientSecret: string) {
  const response = await fetch(`${process.env.AUTH_E2E_URL}/api/v1/auth/oauth2/token`, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
    headers: {
      origin: process.env.AUTH_E2E_URL!, 'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    }, body: new URLSearchParams(fields),
  });
  const body = await response.json();
  const values = [body.access_token, body.refresh_token, body.id_token].filter((value): value is string => typeof value === 'string');
  if (values.length) await protectArtifacts(values);
  return { status: response.status, body };
}

export async function issueTokens(client: Awaited<ReturnType<typeof createClient>>, cookies?: Awaited<ReturnType<typeof saveCookies>>) {
  const authorized = await authorization(client.clientId, client.redirectUri, cookies);
  if (!authorized.code) throw new Error(`Real OAuth authorization returned no code (HTTP ${authorized.status}, ${authorized.error ?? 'no protocol error'})`);
  const issued = await tokenRequest({
    grant_type: 'authorization_code', code: authorized.code,
    code_verifier: authorized.verifier, redirect_uri: client.redirectUri,
  }, client.clientId, client.clientSecret);
  if (issued.status !== 200) throw new Error(`Real OAuth token exchange failed (HTTP ${issued.status}, ${issued.body.error ?? 'no protocol error'})`);
  if (!issued.body.access_token || !issued.body.refresh_token) throw new Error('Real offline OAuth grant did not issue both tokens');
  return issued.body as { access_token: string; refresh_token: string };
}

export async function userinfo(accessToken: string) {
  const response = await fetch(`${process.env.AUTH_E2E_URL}/api/v1/auth/oauth2/userinfo`, {
    headers: { authorization: `Bearer ${accessToken}` }, redirect: 'manual', signal: AbortSignal.timeout(15000),
  });
  return { status: response.status, body: await response.json() };
}
