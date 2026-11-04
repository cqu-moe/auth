import { test, beforeEach, afterEach, surfaceOf } from '@e2e-dev/web';
import { authWebEngine } from '../e2e.config';
import { expect, credentials, secrets } from 'e2e';
import { TURNSTILE_SCRIPT_URL, fulfillTurnstileFixture } from './turnstile.mjs';

let unexpected: string[];
beforeEach(async ({ browser }) => {
  unexpected = [];
  const allowed = new URL(process.env.AUTH_E2E_URL!).origin;
  await browser.route('**/*', async route => {
    const url = new URL(route.request.url);
    if (`${url.origin}${url.pathname}` === TURNSTILE_SCRIPT_URL) return await fulfillTurnstileFixture(route);
    if (url.origin !== allowed) {
      unexpected.push(url.origin);
      await route.abort();
    } else await route.continue();
  });
});
afterEach(async () => { expect(unexpected).toEqual([]); });

test('register, verify, persist, sign out and sign in with slow Turnstile completion', async ({ app, screen, browser }) => {
  const account = credentials.user('journey');
  await app.open('/');
  await expect(screen.getByRole('heading', '校园很大， 一个账号就够。')).toBeVisible();
  await browser.evaluate(() => (localStorage.setItem('__E2E_TURNSTILE_DELAY__', '4000'), null));
  await screen.getByRole('link', '初次见面？创建账号').click();
  await expect(browser).toHaveURL(/\/register(?:\?|$)/);
  await app.open('/register?redirect=%2Fsettings%2Fsecurity');
  if (process.env.AUTH_E2E_BREAK_ASSERTION === '1') {
    await expect(screen.getByRole('heading', '创建账号', { exact: true })).toHaveText('故意错误的注册成功页面');
  }
  await screen.getByLabel('昵称').fill('Synthetic User');
  await screen.getByLabel('邮箱', { exact: true }).fill(account.username);
  await browser.locator('#password').fill(account.password);
  await browser.locator('#confirmPassword').fill(account.password);
  await screen.getByLabel('邀请码').fill('ABCDEFGH');
  const signup = browser.waitForResponse(/\/api\/v1\/auth\/sign-up\/email$/);
  await screen.getByRole('button', '注册', { exact: true }).click();
  await expect(screen.getByRole('button', '正在完成安全验证…', { exact: true })).toBeVisible();
  await expect(browser).toHaveURL(/\/register(?:\?|$)/);
  expect((await signup).status).toBe(200);
  await expect(browser).toHaveURL(/verify-email/);
  await expect(browser).toHaveURL(/redirect=/);
  // A real, unverified session must not reach the protected settings UI.
  await app.open('/settings');
  await expect(browser).toHaveURL(/verify-email/);
  await app.open('/verify-email?redirect=%2Fsettings%2Fsecurity');
  await browser.locator('#email-verification-otp').fill(secrets.get('wrongOtp'));
  await screen.getByRole('button', '验证并继续').click();
  await expect(browser.locator('#email-verification-error')).toBeVisible();
  await expect(browser).toHaveURL(/verify-email/);
  // While session refreshes overlap, verification must hand off to settings once.
  const page = surfaceOf(authWebEngine)!.page();
  const destinations: string[] = [];
  const recordNavigation = (frame: ReturnType<typeof page.mainFrame>) => {
    if (frame === page.mainFrame()) destinations.push(new URL(frame.url()).pathname);
  };
  const slowSession = '**/api/v1/auth/get-session*';
  await page.route(slowSession, async route => {
    await new Promise(resolve => setTimeout(resolve, 300));
    await route.continue();
  });
  page.on('framenavigated', recordNavigation);
  try {
    await browser.locator('#email-verification-otp').fill(secrets.get('otp'));
    await screen.getByRole('button', '验证并继续').click();
    await expect(screen.getByRole('heading', '安全', { exact: true })).toBeVisible();
    expect(destinations).toEqual(['/settings/security']);
  } finally {
    page.off('framenavigated', recordNavigation);
    await page.unroute(slowSession);
  }
  await browser.evaluate(() => {
    localStorage.setItem('__E2E_TURNSTILE_DELAY__', '0');
    localStorage.setItem('__E2E_TURNSTILE_FAILURES__', '1');
    return null;
  });
  await browser.reload();
  await expect(screen.getByRole('button', '退出登录', { exact: true })).toBeVisible();
  const verified = await browser.evaluate(async () => {
    const session = await (await fetch('/api/v1/auth/get-session')).json();
    return { email: session?.user?.email, verified: session?.user?.emailVerified };
  });
  expect(verified).toEqual({ email: account.username, verified: true });
  await app.open('/');
  await expect(screen.getByRole('heading', '校园很大， 一个账号就够。')).toBeVisible();
  await screen.getByRole('link', '账号设置', { exact: true }).click();
  await expect(browser).toHaveURL(/\/settings$/);
  await screen.getByRole('button', '退出登录', { exact: true }).click();
  await expect(browser).toHaveURL(/login/);
  await expect(screen.getByText('安全验证加载失败，请重试后再次提交')).toBeVisible();
  await screen.getByLabel('邮箱', { exact: true }).fill(account.username);
  await browser.locator('#password').fill('deliberately-wrong-password');
  await screen.getByRole('button', '重试登录', { exact: true }).click();
  await expect(browser.locator('#login-error')).toBeVisible();
  expect(await browser.evaluate(async () => (await fetch('/api/v1/cqu/binding')).status)).toBe(401);
  await app.open('/settings');
  await expect(browser).toHaveURL(/login/);
  await screen.getByLabel('邮箱', { exact: true }).fill(account.username);
  await browser.locator('#password').fill(account.password);
  await screen.getByRole('button', '登录', { exact: true }).click();
  await expect(browser).toHaveURL(/\/settings/);
  await browser.reload();
  await expect(screen.getByRole('button', '退出登录', { exact: true })).toBeVisible();
  await screen.getByRole('button', '退出登录', { exact: true }).click();
  await app.open('/login?redirect=https%3A%2F%2Fevil.example%2Fcallback');
  await screen.getByLabel('邮箱', { exact: true }).fill(account.username);
  await browser.locator('#password').fill(account.password);
  // Count session reads only after the password was accepted. A second read
  // used to cancel the first and could exhaust the server's rate limit.
  let accepted = false;
  let sessionReads = 0;
  const onResponse = (response: import('playwright-core').Response) => {
    if (response.url().endsWith('/auth/sign-in/email') && response.status() === 200) accepted = true;
  };
  page.on('response', onResponse);
  await page.route(slowSession, async route => {
    if (accepted) {
      sessionReads++;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    await route.continue();
  });
  try {
    await screen.getByRole('button', '登录', { exact: true }).click();
    await expect(browser).toHaveURL(`${process.env.AUTH_E2E_URL}/settings`);
    expect(sessionReads).toBe(1);
  } finally {
    page.off('response', onResponse);
    await page.unroute(slowSession);
  }
});
test('registration policy rejects missing, invalid, expired and used invitations; optional mode creates an unverified account', async ({ app, screen, browser }) => {
  await app.open('/register');
  await screen.getByLabel('昵称').fill('Policy User');
  await screen.getByLabel('邮箱', { exact: true }).fill('policy@example.test');
  await browser.locator('#password').fill(credentials.user('journey').password);
  await browser.locator('#confirmPassword').fill(credentials.user('journey').password);
  await screen.getByRole('button', '注册', { exact: true }).click();
  await expect(browser.locator('#invitation-code-error')).toHaveText('请输入邀请码');
  for (const [code, message] of [['ZZZZZZZZ', '邀请码无效'], ['JKLMNPQR', '邀请码已过期'], ['STUVWXYZ', '邀请码已使用']]) {
    await screen.getByLabel('邀请码').fill(code);
    await browser.locator('button[type="submit"]').click();
    await expect(screen.getByText(message, { exact: true })).toBeVisible();
    expect(await browser.evaluate(async () => (await fetch('/api/v1/cqu/binding')).status)).toBe(401);
  }
  const response = await fetch(`${process.env.AUTH_E2E_CONTROL}/registration`, {
    method: 'POST', body: JSON.stringify({ required: false }),
  });
  expect(response.status).toBe(204);
  try {
    await app.open('/register');
    await screen.getByLabel('昵称').fill('Optional User');
    await screen.getByLabel('邮箱', { exact: true }).fill('optional@example.test');
    await browser.locator('#password').fill(credentials.user('journey').password);
    await browser.locator('#confirmPassword').fill(credentials.user('journey').password);
    await screen.getByRole('button', '注册', { exact: true }).click();
    await expect(browser).toHaveURL(/verify-email/);
    const result = await browser.evaluate(async () => {
      const session = await (await fetch('/api/v1/auth/get-session')).json();
      return { email: session?.user?.email, verified: session?.user?.emailVerified };
    });
    expect(result).toEqual({ email: 'optional@example.test', verified: false });
    await app.open('/settings');
    await expect(browser).toHaveURL(/verify-email/);
    await screen.getByRole('button', '退出当前账户', { exact: true }).click();
    await app.open('/register');
    await screen.getByLabel('昵称').fill('Duplicate User');
    await screen.getByLabel('邮箱', { exact: true }).fill('optional@example.test');
    await browser.locator('#password').fill(credentials.user('journey').password);
    await browser.locator('#confirmPassword').fill(credentials.user('journey').password);
    await screen.getByRole('button', '注册', { exact: true }).click();
    await expect(browser.locator('[role="alert"]')).toBeVisible();
    await expect(browser).toHaveURL(/register/);
    expect(await browser.evaluate(async () => (await fetch('/api/v1/cqu/binding')).status)).toBe(401);
  } finally {
    const reset = await fetch(`${process.env.AUTH_E2E_CONTROL}/registration`, { method: 'POST', body: JSON.stringify({ required: true }) });
    expect(reset.status).toBe(204);
  }
});
