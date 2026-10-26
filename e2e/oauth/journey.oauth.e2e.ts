import { test, beforeEach, afterEach, surfaceOf } from '@e2e-dev/web';
import { expect, credentials } from 'e2e';
import type { TestFixtures } from 'e2e';
import type { Browser } from '@e2e-dev/web';
import { authWebEngine } from '../../e2e.config';
import { responseFor } from '../admin-fixture';
import { authSecuritySecrets } from '../secret-holder';
import { TURNSTILE_SCRIPT_URL, fulfillTurnstileFixture } from '../turnstile.mjs';

type Journey = TestFixtures & { browser: Browser };
const courses = [{ id: '31', name: '合成电路', extra: 'SYN101', courseCode: 'SYN101' }];
let unexpected: string[];
const pendingRoutes = new Map<object, { started: number; origin: string; path: string; decision: string }>();
const diagnosticPaths = new Set(['/api/v1/auth/get-session', '/api/v1/auth/sign-in/email', '/api/v1/auth/list-sessions', '/api/v1/auth/update-user', '/api/v1/cqu/binding', '/login', '/settings', '/settings/security', '/oauth/authorize', '/callback']);

beforeEach(async ({ app, screen, browser }) => {
  unexpected = [];
  const allowedOrigins = [new URL(process.env.AUTH_E2E_URL!).origin, new URL(process.env.AUTH_OAUTH_APP!).origin];
  const allowed = new Set(allowedOrigins);
  await browser.route(`${TURNSTILE_SCRIPT_URL}*`, async route => await fulfillTurnstileFixture(route));
  if (!process.env.AUTH_OAUTH_PROXY) await browser.route('**/*', async route => {
    const url = new URL(route.request.url);
    if (`${url.origin}${url.pathname}` === TURNSTILE_SCRIPT_URL) return await fulfillTurnstileFixture(route);
    pendingRoutes.set(route, { started: Date.now(), origin: url.origin === allowedOrigins[0] ? 'auth' : url.origin === allowedOrigins[1] ? 'oauth-app' : 'other',
      path: diagnosticPaths.has(url.pathname) ? url.pathname : 'other', decision: allowed.has(url.origin) ? 'continue' : 'abort' });
    try {
      if (!allowed.has(url.origin)) { unexpected.push(url.origin); await route.abort(); }
      else await route.continue();
    } finally { pendingRoutes.delete(route); }
  });
  await app.open('/login');
  // Negative gate runs before any Secret fill, retaining a safe screenshot.
  if (process.env.AUTH_OAUTH_BREAK_ASSERTION) {
    await app.open('/login');
    await expect(screen.getByRole('heading', 'AUTH04 deliberate failure')).toBeVisible({ timeout: 1000 });
  }
});
afterEach(async () => {
  if (pendingRoutes.size) console.info('Auth OAuth pending route decisions:', JSON.stringify(
    [...pendingRoutes.values()].map(({ started, ...route }) => ({ ...route, elapsedMs: Date.now() - started }))));
  expect(unexpected).toEqual([]);
});

async function control(path: string, body: Record<string, unknown> = {}) {
  const response = await fetch(`${process.env.AUTH_OAUTH_CONTROL}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(150000),
  });
  if (!response.ok) throw new Error(`OAuth test control failed (${response.status}, ${path})`);
  return response.json();
}
async function appJson(path: string, init: RequestInit = {}) {
  const response = await fetch(`${process.env.AUTH_OAUTH_APP}${path}`, {
    ...init, method: init.method ?? (init.body ? 'POST' : 'GET'), signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`OAuth application request failed (${response.status}, ${path})`);
  return response.json();
}
async function background(email: string) { return control('/directory', { email }); }
async function expectBackgroundCourses(email: string) {
  const result = await background(email);
  expect(result.error ?? null).toBe(null);
  expect(result.items).toEqual(courses);
}
const surface = () => surfaceOf(authWebEngine)!;
async function signInUi({ app, screen, browser }: Journey, account: ReturnType<typeof credentials.user>) {
  await app.open('/login');
  await screen.getByLabel('邮箱', { exact: true }).fill(account.username);
  await browser.locator('#password').fill(account.password);
  const deadline = Date.now() + 90000;
  for (;;) {
    const pending = responseFor(/\/api\/v1\/auth\/sign-in\/email$/, 'POST');
    await screen.getByRole('button', /^(登录|重试登录)$/).click();
    const response = await pending;
    if (response.status !== 429) { expect(response.status).toBe(200); break; }
    const seconds = Number(response.headers['retry-after'] ?? response.headers['x-retry-after']);
    if (!Number.isFinite(seconds) || seconds < 0 || Date.now() + seconds * 1000 > deadline) throw new Error('Login rate limit did not provide a bounded Retry-After');
    await new Promise(resolve => setTimeout(resolve, Math.max(1000, seconds * 1000 + 100)));
  }
  await expect(browser).toHaveURL(/settings/);
  await control('/protect', { values: (await surface().context().cookies()).map(cookie => cookie.value).filter(Boolean) });
}
async function authorize(context: Journey, account: ReturnType<typeof credentials.user>, device: string, client = 'first') {
  await signInUi(context, account);
  await surface().page().goto(`${process.env.AUTH_OAUTH_APP}/start?device=${device}&client=${client}`, { waitUntil: 'commit' });
  if (client === 'ordinary') {
    await context.browser.waitForURL(/\/oauth\/authorize/);
    await context.screen.getByRole('button', '授权', { exact: true }).click();
  }
  await context.browser.waitForURL(/\/callback\?/);
  await expect(context.screen.getByRole('heading', `OAuth ${device} ready`, { exact: true })).toBeVisible();
  const callback = new URL(await context.browser.url());
  expect(Boolean(callback.searchParams.get('code') && callback.searchParams.get('state'))).toBe(true);
  return appJson(`/authority/${device}`);
}
async function device(context: Journey, name: string, status = 'active') {
  await surface().page().goto(`${process.env.AUTH_OAUTH_APP}/device/${name}`, { waitUntil: 'commit', timeout: 150000 });
  expect(await context.browser.evaluate(() => document.body.dataset.status ?? '')).toBe(status);
  if (status === 'active') await expect(context.screen.getByText('合成电路', { exact: true })).toBeVisible();
}
async function ended(context: Journey, name: string) {
  await device(context, name, 'unauthorized');
  expect(await appJson(`/refresh-result/${name}`, { method: 'POST' })).toEqual({ refreshed: false, status: 400 });
}
async function unbind(context: Journey) {
  await context.app.open('/settings');
  expect(await context.browser.evaluate(async () => (await fetch('/api/v1/cqu/binding', { method: 'DELETE' })).status)).toBe(204);
}

test('OAuth S256 authorization, DPoP, refresh and one-device revocation preserve independent website and other-device business', async context => {
  const { app, screen, browser } = context;
  const account = credentials.user('oauthCore');
  await control('/prepare', { email: account.username });
  const first = await authorize(context, account, 'one');
  const second = await authorize(context, account, 'two');
  expect(first).toMatchObject({ active: true, tokenType: 'dpop', hasBusinessClaims: true, external: true, client: 'auth-oauth-first-party' });
  expect(first.sessionId).toBeTruthy();
  expect(second.sessionId).not.toBe(first.sessionId);
  await device(context, 'one');
  await device(context, 'two');

  const ordinary = await authorize(context, account, 'ordinary', 'ordinary');
  expect(ordinary).toMatchObject({ active: true, tokenType: 'bearer', hasBusinessClaims: false, client: 'auth-oauth-ordinary' });
  // Bearer remains usable at its allowed resource, but grants no business or official-device identity.
  expect(await appJson('/userinfo/ordinary')).toEqual({ status: 200, email: account.username });
  await device(context, 'ordinary', 'forbidden');
  expect(await appJson('/official-device/ordinary')).toEqual({ status: 403, code: 'FORBIDDEN' });

  const negative = await appJson('/negative', { body: JSON.stringify({ email: account.username }) });
  expect(negative.firstExchange).toEqual({ status: 200, issued: true, tokenType: 'dpop' });
  expect(negative.wrongVerifier).toEqual({ status: 401, error: 'invalid_request', rejected: true });
  for (const name of ['wrongCallback', 'replay']) {
    expect(negative[name]).toEqual({ status: 400, error: 'invalid_grant', rejected: true });
  }
  expect(negative.invalidResource).toMatchObject({ error: 'invalid_target', rejected: true });
  expect(negative.invalidScope).toMatchObject({ error: 'invalid_scope', rejected: true });
  expect(negative.officialDeviceIdentity).toMatchObject({ status: 403, rejected: true });
  expect(negative.missingIssueProof).toEqual({ status: 400, error: 'invalid_dpop_proof', rejected: true });

  // A fresh website session is independent of both issued device sessions.
  await signInUi(context, account);
  await app.open('/settings/security');
  const websiteId = await browser.evaluate(async () => (await (await fetch('/api/v1/auth/get-session')).json()).session.id);
  expect([first.sessionId, second.sessionId]).not.toContain(websiteId);
  await screen.getByRole('button', '查看登录设备').click();
  const sessionIds = await browser.evaluate(async () => (await (await fetch('/api/v1/auth/list-sessions')).json()).map((row: { id: string }) => row.id));
  const index = sessionIds.indexOf(first.sessionId);
  expect(index).toBeGreaterThanOrEqual(0);
  await screen.getByRole('button', '退出此设备', { exact: true }).nth(index).click();
  await ended(context, 'one');
  await device(context, 'two');
  await app.open('/settings');
  expect(await browser.evaluate(async () => (await fetch('/api/v1/auth/update-user', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'OAuth surviving website' }),
  })).status)).toBe(200);
  await app.open('/settings');
  expect(await browser.evaluate(async () => (await (await fetch('/api/v1/auth/get-session')).json()).user.name)).toBe('OAuth surviving website');

  // Default first-party approval survives independent business entitlement removal.
  await control('/entitlement', { email: account.username, enabled: false });
  expect(await appJson('/authority/two')).toMatchObject({ active: true, external: false });
  await device(context, 'two', 'forbidden');
  expect(await background(account.username)).toEqual({ error: 'FORBIDDEN' });
  await control('/entitlement', { email: account.username, enabled: true });
  await device(context, 'two');
  expect(await appJson('/dpop/two')).toEqual({
    userinfo: 200, replay: 401, missingProof: 401, bearerDowngrade: 401, sameKeyRefresh: true,
    wrongKeyRefresh: { status: 400, error: 'invalid_dpop_proof' },
    missingRefresh: { status: 400, error: 'invalid_dpop_proof' },
    refreshProofReplay: { status: 400, error: 'invalid_dpop_proof' }, continuedRefresh: 200,
    afterRefresh: 200, afterRefreshEmail: account.username, refreshedType: 'dpop', afterRefreshBearer: 401,
  });
  await device(context, 'two');
  // Rotation/reuse detection intentionally terminates the refresh family; run last.
  expect(await appJson('/refresh-result/two?replay=1', { method: 'POST' })).toEqual({
    refreshed: true, rotated: true, oldRefreshRejected: true, status: 200,
  });
  await expectBackgroundCourses(account.username);
  await unbind(context);
});

test('password change, administrator recovery and all-device logout each revoke active devices while background survives until ban or unbind', async context => {
  const { app, screen, browser } = context;
  const account = credentials.user('oauthLifecycle');
  const changed = credentials.user('oauthLifecycleNew');
  await control('/prepare', { email: account.username });
  await authorize(context, account, 'password-device');
  await device(context, 'password-device');
  await signInUi(context, account);
  await app.open('/settings/security');
  await screen.getByRole('button', '修改密码', { exact: true }).click();
  await screen.getByLabel('当前密码').fill(account.password);
  await screen.getByLabel('新密码').fill(changed.password);
  await screen.getByLabel('确认新密码').fill(changed.password);
  await browser.locator('#change-password-form button[type="submit"]').click();
  await expect(screen.getByText('密码已更新')).toBeVisible();
  await ended(context, 'password-device');
  await expectBackgroundCourses(account.username);

  await authorize(context, changed, 'recovery-device');
  await device(context, 'recovery-device');
  const recovered = await control('/recover', { email: account.username }) as { password: string };
  authSecuritySecrets.recoveryPassword = recovered.password;
  await ended(context, 'recovery-device');
  await app.open('/settings');
  await expect(browser).toHaveURL(/login/);
  await expectBackgroundCourses(account.username);

  const recoveredAccount = credentials.user('oauthRecovered');
  await authorize(context, recoveredAccount, 'logout-device');
  await device(context, 'logout-device');
  await signInUi(context, recoveredAccount);
  await app.open('/settings/security');
  await screen.getByRole('button', '查看登录设备').click();
  await screen.getByRole('button', '退出全部设备（包括当前设备）').click();
  await expect(browser).toHaveURL(/login/);
  await ended(context, 'logout-device');
  await expectBackgroundCourses(account.username);

  await authorize(context, recoveredAccount, 'ban-device');
  await device(context, 'ban-device');
  await control('/ban', { email: account.username, banned: true });
  await ended(context, 'ban-device');
  expect(await background(account.username)).toEqual({ error: 'FORBIDDEN' });
  await control('/ban', { email: account.username, banned: false });
  await expectBackgroundCourses(account.username);
  await authorize(context, recoveredAccount, 'unbind-device');
  await device(context, 'unbind-device');
  await unbind(context);
  expect(await background(account.username)).toEqual({ error: 'NO_CQU_BINDING' });
  await device(context, 'unbind-device', 'forbidden');
});
