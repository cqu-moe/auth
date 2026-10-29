import { surfaceOf } from '@e2e-dev/web';
import { credentials, expect, secrets } from 'e2e';
import { authWebEngine } from '../e2e.config';
import { createVerifiedAccount, enrollTotp, protectArtifacts, signIn, type Fixture } from './auth-fixture';
import { authSecuritySecrets } from './secret-holder';
import { turnstileHeaders } from './turnstile.mjs';

export const surface = () => surfaceOf(authWebEngine)!;

// e2e 0.21 waitForResponse matches URLs only. A background GET on the same
// resource raced the invitation POST; retain the engine and narrow this capture.
export async function responseFor(path: RegExp, method: string) {
  const response = await surface().page().waitForResponse(response => path.test(response.url()) && response.request().method() === method);
  return { status: response.status(), headers: response.headers(), json: <T>() => response.json() as Promise<T> };
}

export async function saveCookies() {
  const cookies = await surface().context().cookies();
  await protectArtifacts(cookies.map(cookie => cookie.value).filter(Boolean));
  return cookies;
}

export async function restore(fixture: Fixture, cookies: Awaited<ReturnType<typeof saveCookies>>, path = '/admin/users') {
  await surface().context().clearCookies();
  await surface().context().addCookies(cookies);
  await fixture.app.open(path);
}

/** Real public HTTP only; cookie/credential-bearing arguments and responses stay out of step reports. */
export async function request(path: string, method = 'GET', body?: unknown, cookies?: ReadonlyArray<{ name: string; value: string }>) {
  if (!path.startsWith('/api/v1/')) throw new Error('Expected a canonical local API path');
  const current = cookies ?? await surface().context().cookies();
  const response = await fetch(new URL(path, process.env.AUTH_E2E_URL), {
    method, redirect: 'manual', signal: AbortSignal.timeout(15000),
    headers: {
      origin: process.env.AUTH_E2E_URL!, 'content-type': 'application/json',
      ...turnstileHeaders(path),
      cookie: current.map(cookie => `${cookie.name}=${cookie.value}`).join('; '),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).catch(cause => { throw new Error(`Public API transport failed: ${method} ${new URL(path, process.env.AUTH_E2E_URL).pathname}`, { cause }); });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}

export async function identity() {
  const result = await request('/api/v1/auth/get-session');
  if (result.status !== 200 || !result.body?.user) throw new Error('Expected a real authenticated identity');
  await protectArtifacts([result.body.session.token]);
  return result.body as { user: { id: string; email: string; name: string; role: string; twoFactorEnabled: boolean }; session: { token: string } };
}

// A complete admin journey can consume the unchanged 30/60s session-read bucket.
// Only this safe GET may wait, and only on the provider's explicit bounded 429.
export async function sessionAfterRateLimit() {
  const deadline = Date.now() + 70000;
  for (;;) {
    const result = await request('/api/v1/auth/get-session');
    if (result.status !== 429) return result;
    const seconds = Number(result.headers.get('retry-after') ?? result.headers.get('x-retry-after'));
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60
      || Date.now() + seconds * 1000 > deadline) {
      throw new Error('Session-read 429 has no usable Retry-After within the 70-second budget');
    }
    await new Promise(resolve => setTimeout(resolve, seconds * 1000));
  }
}

export async function administrator(fixture: Fixture, checkWeak = false) {
  const account = await createVerifiedAccount(fixture, 'manager', 'managerOtp');
  const promoted = await fetch(`${process.env.AUTH_E2E_CONTROL}/promote-admin`, {
    method: 'POST', body: JSON.stringify({ email: account.username }),
  });
  expect(promoted.status).toBe(204);
  if (checkWeak) {
    await fixture.app.open('/admin/users');
    await expect(fixture.screen.getByRole('heading', '验证管理身份')).toBeVisible();
    const denied = await request('/api/v1/admin/users');
    expect({ status: denied.status, code: denied.body.code }).toEqual({ status: 403, code: 'STRONG_AUTH_REQUIRED' });
  }
  await enrollTotp(fixture, account, { rejectWrong: false });
  authSecuritySecrets.adminRawSecret = authSecuritySecrets.mfaRawSecret;
  await fixture.screen.getByRole('button', '退出登录', { exact: true }).click();
  await signIn(fixture, account);
  await expect(fixture.browser).toHaveURL(/two-factor/);
  await fixture.browser.locator('#twoFactorCode').fill(secrets.get('adminTotp'));
  await fixture.screen.getByRole('button', '完成验证').click();
  await expect(fixture.browser).toHaveURL(/\/settings$/);
  await adminProof(fixture, account);
  return { account, cookies: await saveCookies(), ...(await identity()) };
}

export async function newMember(fixture: Fixture, name = 'member') {
  await surface().context().clearCookies();
  const account = await createVerifiedAccount(fixture, name, `${name}Otp`);
  return { account, cookies: await saveCookies(), ...(await identity()) };
}

export function userRow(fixture: Fixture, email: string) {
  return process.env.AUTH_E2E_MOBILE
    ? fixture.browser.locator('[class~="sm:hidden"] > div').filter({ hasText: email })
    : fixture.screen.getByRole('row').filter({ hasText: email });
}

export async function setRole(fixture: Fixture, name: string, label: string) {
  await fixture.screen.getByRole('combobox', `Synthetic ${name} 的角色`, { visible: true }).click();
  await fixture.screen.getByRole('option', new RegExp(`^${label}`)).click();
  await expect(fixture.screen.getByRole('combobox', `Synthetic ${name} 的角色`, { visible: true })).toContainText(label);
}

export async function login(fixture: Fixture, name = 'member') {
  await surface().context().clearCookies();
  await signIn(fixture, credentials.user(name));
}

export async function adminProof(fixture: Fixture, account: ReturnType<typeof credentials.user>, totp = 'adminTotp') {
  const expired = await fetch(`${process.env.AUTH_E2E_CONTROL}/expire`, {
    method: 'POST', body: JSON.stringify({ type: 'recent-auth', email: account.username, purpose: 'strong' }),
  });
  expect(expired.status).toBe(204);
  await fixture.app.open('/admin/users');
  await fixture.screen.getByRole('button', '验证并进入').click();
  await fixture.screen.getByLabel('当前密码').fill(account.password);
  await fixture.screen.getByRole('button', '验证并继续').click();
  await fixture.browser.locator('#recent-code').fill(secrets.get(totp));
  await fixture.screen.getByRole('button', '验证并继续').click();
  await expect(fixture.screen.getByRole('heading', '用户管理', { exact: true })).toBeVisible();
  const proof = await request('/api/v1/auth/security/status?purpose=admin');
  expect({ status: proof.status, ...proof.body }).toEqual({ status: 200, strong: true, verified: true });
}
