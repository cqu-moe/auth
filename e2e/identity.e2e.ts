import { test, beforeEach, afterEach } from '@e2e-dev/web';
import { expect, credentials, secrets } from 'e2e';

let unexpected: string[];
beforeEach(async ({ browser }) => {
  unexpected = [];
  const allowed = new URL(process.env.AUTH_E2E_URL!).origin;
  await browser.route('**/*', async route => {
    if (new URL(route.request.url).origin !== allowed) {
      unexpected.push(new URL(route.request.url).origin);
      await route.abort();
    } else await route.continue();
  });
});
afterEach(async () => { expect(unexpected).toEqual([]); });

test('register, verify, persist, sign out and sign in through the built application', async ({ app, screen, browser }) => {
  const account = credentials.user('journey');
  await app.open('/');
  await expect(screen.getByRole('heading', '校园很大， 一个账号就够。')).toBeVisible();
  await screen.getByRole('link', '初次见面？创建账号').click();
  await expect(browser).toHaveURL(/\/register$/);
  await app.open('/register?redirect=%2Fsettings%2Fsecurity');
  if (process.env.AUTH_E2E_BREAK_ASSERTION === '1') {
    await expect(screen.getByRole('heading', '创建账号', { exact: true })).toHaveText('故意错误的注册成功页面');
  }
  await screen.getByLabel('昵称').fill('Synthetic User');
  await screen.getByLabel('邮箱', { exact: true }).fill(account.username);
  await browser.locator('#password').fill(account.password);
  await browser.locator('#confirmPassword').fill(account.password);
  await screen.getByLabel('邀请码').fill('ABCDEFGH');
  await screen.getByRole('button', '注册', { exact: true }).click();
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
  await browser.locator('#email-verification-otp').fill(secrets.get('otp'));
  await screen.getByRole('button', '验证并继续').click();
  await expect(browser).toHaveURL(/\/settings\/security$/);
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
  expect(await browser.evaluate(async () => (await fetch('/api/v1/cqu/binding')).status)).toBe(401);
  await app.open('/settings');
  await expect(browser).toHaveURL(/login/);
  await screen.getByLabel('邮箱', { exact: true }).fill(account.username);
  await browser.locator('#password').fill('deliberately-wrong-password');
  await screen.getByRole('button', '登录', { exact: true }).click();
  await expect(browser.locator('#login-error')).toBeVisible();
  expect(await browser.evaluate(async () => (await fetch('/api/v1/cqu/binding')).status)).toBe(401);
  await browser.locator('#password').fill(account.password);
  await screen.getByRole('button', '重试登录', { exact: true }).click();
  await expect(browser).toHaveURL(/\/settings/);
  await browser.reload();
  await expect(screen.getByRole('button', '退出登录', { exact: true })).toBeVisible();
  await screen.getByRole('button', '退出登录', { exact: true }).click();
  await app.open('/login?redirect=https%3A%2F%2Fevil.example%2Fcallback');
  await screen.getByLabel('邮箱', { exact: true }).fill(account.username);
  await browser.locator('#password').fill(account.password);
  await screen.getByRole('button', '登录', { exact: true }).click();
  await expect(browser).toHaveURL(`${process.env.AUTH_E2E_URL}/settings`);
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
