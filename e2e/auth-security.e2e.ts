import { test, beforeEach, afterEach } from '@e2e-dev/web';
import { expect, credentials, secrets } from 'e2e';
import { authWebEngine } from '../e2e.config';
import { createVerifiedAccount, signIn, sessionState, protectArtifacts, enrollTotp } from './auth-fixture';
import { surfaceOf } from '@e2e-dev/web';

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

test('profile and email changes persist after reload and the new email can sign in', async ({ app, screen, browser }) => {
  const account = await createVerifiedAccount({ app, screen, browser }, 'profile', 'profileOtp');

  await app.open('/settings');
  await screen.getByRole('button', '修改昵称', { exact: true }).click();
  await screen.getByLabel('昵称').fill('资料保存后');
  await screen.getByRole('button', '保存', { exact: true }).click();
  await expect(screen.getByText('昵称已更新')).toBeVisible();
  await browser.reload();
  await expect(screen.getByText('资料保存后')).toBeVisible();

  await app.open('/settings/email');
  await screen.getByRole('button', '发送验证码', { exact: true }).click();
  await expect(screen.getByText('验证码已发送，请输入邮件中的 6 位数字。')).toBeVisible();
  await browser.locator('#current-email-otp').fill(secrets.get('wrongProfileOtp'));
  await screen.getByRole('button', '验证并继续').click();
  await expect(screen.getByText('验证码不正确')).toBeVisible();
  await browser.locator('#current-email-otp').fill(secrets.get('profileOtp'));
  await screen.getByRole('button', '验证并继续').click();
  await expect(screen.getByRole('heading', '输入新邮箱', { exact: true })).toBeVisible();

  await screen.getByLabel('新邮箱').fill(credentials.user('profileNew').username);
  await screen.getByRole('button', '发送验证码', { exact: true }).click();
  await expect(screen.getByRole('heading', '验证身份后继续', { exact: true })).toBeVisible();
  await screen.getByLabel('当前密码').fill(account.password);
  await screen.getByRole('button', '验证并继续').click();
  await expect(screen.getByRole('heading', '验证新邮箱', { exact: true })).toBeVisible();
  await browser.locator('#new-email-otp').fill(secrets.get('wrongProfileNewOtp'));
  await screen.getByRole('button', '确认更换邮箱').click();
  await expect(screen.getByText('验证码不正确')).toBeVisible();
  await browser.locator('#new-email-otp').fill(secrets.get('profileNewOtp'));
  await screen.getByRole('button', '确认更换邮箱').click();
  await expect(screen.getByText('登录邮箱已更新。')).toBeVisible();

  await app.open('/settings');
  await expect(await sessionState(browser)).toEqual({ status: 200, email: credentials.user('profileNew').username });
  await screen.getByRole('button', '退出登录', { exact: true }).click();
  await expect(browser).toHaveURL(/login/);
  await signIn({ app, screen, browser }, credentials.user('profileNew'));
  await expect(browser).toHaveURL(/\/settings/);
  await expect(await sessionState(browser)).toEqual({ status: 200, email: credentials.user('profileNew').username });
});

test('password recovery rejects invalid, expired and reused links and revokes old sessions', async ({ app, screen, browser }) => {
  const account = await createVerifiedAccount({ app, screen, browser }, 'reset', 'resetOtp');
  const surface = surfaceOf(authWebEngine)!;
  const context = surface.context();
  const oldCookies = await context.cookies();
  const resetUrl = async () => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const response = await fetch(`${process.env.AUTH_E2E_CONTROL}/mail?email=${encodeURIComponent(account.username)}`);
      const mail = await response.json() as { resetUrl?: string };
      if (mail.resetUrl) return mail.resetUrl;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Application reset email was not delivered');
  };
  const requestReset = async () => {
    await app.open('/reset-password');
    await screen.getByLabel('邮箱').fill(account.username);
    await screen.getByRole('button', '发送重置链接').click();
    await expect(screen.getByRole('heading', '邮件已发送', { exact: true })).toBeVisible();
    return await resetUrl();
  };
  const tokenFrom = (url: string) => /\/reset-password\/([^?]+)/.exec(new URL(url).pathname + new URL(url).search)?.[1];

  await app.open('/reset-password/confirm?token=invalid.token.value');
  await browser.locator('#password').fill(credentials.user('resetNew').password);
  await browser.locator('#confirmPassword').fill(credentials.user('resetNew').password);
  await screen.getByRole('button', '重置密码').click();
  await expect(screen.getByText('Invalid token')).toBeVisible();

  const expiredUrl = await requestReset();
  const expiredToken = tokenFrom(expiredUrl);
  if (!expiredToken) throw new Error('Captured reset link had no token');
  const expired = await fetch(`${process.env.AUTH_E2E_CONTROL}/expire`, {
    method: 'POST', body: JSON.stringify({ type: 'reset-token', token: expiredToken }),
  });
  expect(expired.status).toBe(204);
  await surface.page().goto(expiredUrl, { waitUntil: 'commit' });
  await expect(browser).toHaveURL(/error=INVALID_TOKEN/);
  await expect(screen.getByText('链接无效')).toBeVisible();

  const validUrl = await requestReset();
  await surface.page().goto(validUrl, { waitUntil: 'commit' });
  await expect(browser).toHaveURL(/token=/);
  await browser.locator('#password').fill(credentials.user('resetNew').password);
  await browser.locator('#confirmPassword').fill(credentials.user('resetNew').password);
  await screen.getByRole('button', '重置密码').click();
  await expect(browser).toHaveURL(/login/);
  await context.clearCookies();
  await context.addCookies(oldCookies);
  await app.open('/settings');
  await expect(browser).toHaveURL(/login/);
  expect(await sessionState(browser)).toEqual({ status: 200, email: null });

  await context.clearCookies();
  await app.open('/login');
  await screen.getByLabel('邮箱', { exact: true }).fill(account.username);
  await browser.locator('#password').fill(account.password);
  await screen.getByRole('button', '登录', { exact: true }).click();
  await expect(browser.locator('#login-error')).toBeVisible();
  await browser.locator('#password').fill(credentials.user('resetNew').password);
  await screen.getByRole('button', '重试登录', { exact: true }).click();
  await expect(browser).toHaveURL(/\/settings/);

  const reusedToken = tokenFrom(validUrl);
  if (!reusedToken) throw new Error('Captured reset link had no token');
  await surface.page().goto(new URL(`/reset-password/confirm?token=${encodeURIComponent(reusedToken)}`, process.env.AUTH_E2E_URL).href, { waitUntil: 'commit' });
  await browser.locator('#password').fill(credentials.user('resetNew').password);
  await browser.locator('#confirmPassword').fill(credentials.user('resetNew').password);
  await screen.getByRole('button', '重置密码').click();
  await expect(screen.getByText('Invalid token')).toBeVisible();
});

test('TOTP enrollment rejects a wrong code, then backup-code reuse is rejected at login', async ({ app, screen, browser }) => {
  const account = await createVerifiedAccount({ app, screen, browser }, 'mfa', 'mfaOtp');
  await enrollTotp({ app, screen, browser }, account);

  await screen.getByRole('button', '退出登录', { exact: true }).click();
  await expect(browser).toHaveURL(/login/);
  await signIn({ app, screen, browser }, account);
  await expect(browser).toHaveURL(/two-factor/);
  await browser.locator('#twoFactorCode').fill(secrets.get('wrongMfaTotp'));
  await screen.getByRole('button', '完成验证').click();
  await expect(screen.getByText('验证码不正确')).toBeVisible();
  await browser.locator('#twoFactorCode').fill(secrets.get('mfaTotp'));
  await screen.getByRole('button', '完成验证').click();
  await expect(browser).toHaveURL(/\/settings/);

  await screen.getByRole('button', '退出登录', { exact: true }).click();
  await signIn({ app, screen, browser }, account);
  await expect(browser).toHaveURL(/two-factor/);
  await screen.getByRole('tab', '备用恢复码', { exact: true }).click();
  await browser.locator('#twoFactorCode').fill(secrets.get('mfaBackupCode'));
  await screen.getByRole('button', '完成验证').click();
  await expect(browser).toHaveURL(/\/settings/);
  await screen.getByRole('button', '退出登录', { exact: true }).click();
  await signIn({ app, screen, browser }, account);
  await screen.getByRole('tab', '备用恢复码', { exact: true }).click();
  await browser.locator('#twoFactorCode').fill(secrets.get('mfaBackupCode'));
  await screen.getByRole('button', '完成验证').click();
  await expect(screen.getByText('备用恢复码无效或已使用')).toBeVisible();
  await expect(browser).toHaveURL(/two-factor/);
  expect(await sessionState(browser)).toEqual({ status: 200, email: null });
});

test('virtual WebAuthn completes registration, login and step-up while cancellation creates no session', async ({ app, screen, browser }) => {
  const account = await createVerifiedAccount({ app, screen, browser }, 'passkey', 'passkeyOtp');
  const surface = surfaceOf(authWebEngine)!;
  const cdp = await surface.context().newCDPSession(surface.page());
  await cdp.send('WebAuthn.enable');
  const authenticatorOptions = {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true, defaultBackupEligibility: true, defaultBackupState: true,
  } as const;
  const active = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: authenticatorOptions });
  const cdpProbe = await surface.page().evaluate(async () => {
    try {
      await navigator.credentials.create({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rp: { id: location.hostname, name: 'CDP capability probe' },
          user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'probe@example.test', displayName: 'Probe' },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
          authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
          timeout: 5000,
        },
      });
      return 'ok';
    } catch (error) {
      return `${(error as DOMException).name}: ${(error as DOMException).message}`;
    }
  });
  if (cdpProbe !== 'ok') throw new Error(`CDP WebAuthn capability probe failed: ${cdpProbe}`);
  await cdp.send('WebAuthn.clearCredentials', { authenticatorId: active.authenticatorId });

  await screen.getByLabel('新 Passkey 名称').fill('E2E 虚拟密钥');
  const registrationResponsePromise = browser.waitForResponse(/\/api\/v1\/auth\/passkey\/verify-registration($|\?)/);
  await screen.getByRole('button', '添加 Passkey').click();
  await expect(screen.getByRole('heading', '验证身份后继续', { exact: true })).toBeVisible();
  await screen.getByLabel('当前密码').fill(account.password);
  await screen.getByRole('button', '验证并继续').click();
  const registrationResponse = await registrationResponsePromise;
  expect(registrationResponse.status, await registrationResponse.text()).toBe(200);
  await expect(screen.getByLabel('Passkey 名称 E2E 虚拟密钥')).toBeVisible();
  const stored = await cdp.send('WebAuthn.getCredentials', { authenticatorId: active.authenticatorId });
  expect(stored.credentials.length).toBe(1);

  await screen.getByRole('button', '退出登录', { exact: true }).click();
  await expect(browser).toHaveURL(/login/);
  await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: active.authenticatorId });
  const pending = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { ...authenticatorOptions, transport: 'usb', automaticPresenceSimulation: false },
  });
  await cdp.send('WebAuthn.addCredential', {
    authenticatorId: pending.authenticatorId, credential: stored.credentials[0]!,
  });
  await screen.getByRole('button', '使用 Passkey 登录').click();
  // CDP has no explicit ceremony-cancel command, and removing a disconnected
  // authenticator leaves the pending request unresolved. A real navigation away
  // aborts the browser ceremony; the assertions below prove it created nothing.
  await app.open('/login');
  await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: pending.authenticatorId });
  await expect(screen.getByRole('button', '使用 Passkey 登录')).toBeVisible();
  expect(await sessionState(browser)).toEqual({ status: 200, email: null });

  const usable = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: authenticatorOptions });
  await cdp.send('WebAuthn.addCredential', {
    authenticatorId: usable.authenticatorId, credential: stored.credentials[0]!,
  });
  await screen.getByRole('button', '使用 Passkey 登录').click();
  await expect(browser).toHaveURL(/\/settings/);
  expect(await sessionState(browser)).toEqual({ status: 200, email: account.username });

  await app.open('/settings/email');
  await screen.getByRole('button', '发送验证码', { exact: true }).click();
  await expect(screen.getByText('验证码已发送，请输入邮件中的 6 位数字。')).toBeVisible();
  await browser.locator('#current-email-otp').fill(secrets.get('passkeyOtp'));
  await screen.getByRole('button', '验证并继续').click();
  await expect(screen.getByRole('heading', '输入新邮箱', { exact: true })).toBeVisible();
  await screen.getByLabel('新邮箱').fill(credentials.user('passkeyNew').username);
  await screen.getByRole('button', '发送验证码', { exact: true }).click();
  await expect(screen.getByRole('heading', '验证身份后继续', { exact: true })).toBeVisible();
  await screen.getByRole('button', '使用 Passkey 验证').click();
  await expect(screen.getByRole('heading', '验证新邮箱', { exact: true })).toBeVisible();
});

test('recent authentication and administrator purpose cannot be restored by session renewal', async ({ app, screen, browser }) => {
  const account = await createVerifiedAccount({ app, screen, browser }, 'recent', 'recentOtp');
  const denied = await browser.evaluate(async () => {
    const response = await fetch('/api/v1/auth/passkey/generate-register-options');
    const body = await response.json();
    return { status: response.status, code: body?.code ?? null };
  });
  expect(denied).toEqual({ status: 403, code: 'RECENT_AUTH_REQUIRED' });

  await enrollTotp({ app, screen, browser }, account);

  const expired = await fetch(`${process.env.AUTH_E2E_CONTROL}/expire`, {
    method: 'POST', body: JSON.stringify({ type: 'recent-auth', email: account.username, purpose: 'mfa' }),
  });
  expect(expired.status).toBe(204);
  const renewed = await browser.evaluate(async () => {
    const session = await fetch('/api/v1/auth/get-session');
    const body = await session.json();
    const status = await fetch('/api/v1/auth/security/status?purpose=mfa');
    const proof = await status.json();
    const sensitive = await fetch('/api/v1/auth/passkey/generate-register-options');
    const rejection = await sensitive.json();
    return { session: session.status, email: body?.user?.email ?? null, proof, rejection: { status: sensitive.status, code: rejection?.code ?? null } };
  });
  expect(renewed).toEqual({
    session: 200, email: account.username,
    proof: { strong: true, verified: false }, rejection: { status: 403, code: 'RECENT_AUTH_REQUIRED' },
  });

  const promotion = await fetch(`${process.env.AUTH_E2E_CONTROL}/promote-admin`, {
    method: 'POST', body: JSON.stringify({ email: account.username }),
  });
  expect(promotion.status).toBe(204);
  const protectedOperation = () => browser.evaluate(async () => {
    const response = await fetch('/api/v1/auth/admin/reset-authentication', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: '00000000-0000-0000-0000-000000000000' }),
    });
    const body = await response.json();
    return { status: response.status, message: body?.message ?? null };
  });
  expect(await protectedOperation()).toEqual({ status: 403, message: '请重新验证身份后继续' });

  const strongExpired = await fetch(`${process.env.AUTH_E2E_CONTROL}/expire`, {
    method: 'POST', body: JSON.stringify({ type: 'recent-auth', email: account.username, purpose: 'strong' }),
  });
  expect(strongExpired.status).toBe(204);
  await app.open('/admin');
  await screen.getByRole('button', '验证并进入', { exact: true }).click();
  await screen.getByLabel('当前密码').fill(account.password);
  await screen.getByRole('button', '验证并继续', { exact: true }).click();
  await browser.locator('#recent-code').fill(secrets.get('mfaTotp'));
  await screen.getByRole('button', '验证并继续', { exact: true }).click();
  await expect(screen.getByRole('heading', '用户管理', { exact: true })).toBeVisible();
  expect(await protectedOperation()).toEqual({ status: 404, message: '用户不存在' });

  const adminExpired = await fetch(`${process.env.AUTH_E2E_CONTROL}/expire`, {
    method: 'POST', body: JSON.stringify({ type: 'recent-auth', email: account.username, purpose: 'admin' }),
  });
  expect(adminExpired.status).toBe(204);
  const adminRenewed = await browser.evaluate(async () => {
    const session = await fetch('/api/v1/auth/get-session');
    const body = await session.json();
    const status = await fetch('/api/v1/auth/security/status?purpose=admin');
    const proof = await status.json();
    const sensitive = await fetch('/api/v1/auth/admin/reset-authentication', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: '00000000-0000-0000-0000-000000000000' }),
    });
    const rejection = await sensitive.json();
    return { session: session.status, email: body?.user?.email ?? null, proof, rejection: { status: sensitive.status, message: rejection?.message ?? null } };
  });
  expect(adminRenewed).toEqual({
    session: 200, email: account.username, proof: { strong: true, verified: false },
    rejection: { status: 403, message: '请重新验证身份后继续' },
  });
});

test('password change and whole-device logout invalidate restored interactive cookies', async ({ app, screen, browser }) => {
  const account = await createVerifiedAccount({ app, screen, browser }, 'revoke', 'revokeOtp');
  const context = surfaceOf(authWebEngine)!.context();
  const otherLogin = await fetch(`${process.env.AUTH_E2E_CONTROL}/real-session`, {
    method: 'POST', body: JSON.stringify({ email: account.username }),
  });
  expect(otherLogin.status).toBe(200);
  const { cookies } = await otherLogin.json() as { cookies: Array<{ name: string; value: string }> };
  const otherSession = cookies.map(cookie => ({ ...cookie, url: process.env.AUTH_E2E_URL }));
  expect(otherSession.length).toBeGreaterThan(0);

  await app.open('/settings/security');
  await screen.getByRole('button', '修改密码', { exact: true }).click();
  await screen.getByLabel('当前密码').fill(account.password);
  await screen.getByLabel('新密码').fill(credentials.user('revokeNew').password);
  await screen.getByLabel('确认新密码').fill(credentials.user('revokeNew').password);
  await browser.locator('#change-password-form button[type="submit"]').click();
  await expect(screen.getByText('密码已更新')).toBeVisible();
  await context.clearCookies();
  await context.addCookies(otherSession);
  await app.open('/settings');
  await expect(browser).toHaveURL(/login/);
  expect(await sessionState(browser)).toEqual({ status: 200, email: null });

  await context.clearCookies();
  await signIn({ app, screen, browser }, credentials.user('revokeNew'));
  await expect(browser).toHaveURL(/\/settings/);
  const secondSession = await context.cookies();
  await app.open('/settings/security');
  await screen.getByRole('button', '查看登录设备').click();
  await screen.getByRole('button', '退出全部设备（包括当前设备）').click();
  await expect(browser).toHaveURL(/login/);
  await context.clearCookies();
  await context.addCookies(secondSession);
  await app.open('/settings');
  await expect(browser).toHaveURL(/login/);
  expect(await sessionState(browser)).toEqual({ status: 200, email: null });
});
