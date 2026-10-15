import { expect, credentials, secrets } from 'e2e';
import type { App, Screen, Secret } from 'e2e';
import type { Browser } from '@e2e-dev/web';
import { surfaceOf } from '@e2e-dev/web';
import { authWebEngine } from '../e2e.config';
import { authSecuritySecrets } from './secret-holder';

export type Fixture = { app: App; screen: Screen; browser: Browser };

export async function createVerifiedAccount({ app, screen, browser }: Fixture, name: string, otpSecret: string, managedInvitation?: Secret | false) {
  const account = credentials.user(name);
  let code: string | Secret | undefined;
  if (managedInvitation === false) code = undefined;
  else if (managedInvitation) code = managedInvitation;
  else {
    const invitation = await fetch(`${process.env.AUTH_E2E_CONTROL}/invitation`, { method: 'POST' });
    if (!invitation.ok) throw new Error('Synthetic invitation prerequisite failed');
    code = (await invitation.json() as { code: string }).code;
  }

  await app.open('/register?redirect=%2Fsettings%2Fsecurity');
  await screen.getByLabel('昵称').fill(`Synthetic ${name}`);
  await screen.getByLabel('邮箱', { exact: true }).fill(account.username);
  await browser.locator('#password').fill(account.password);
  await browser.locator('#confirmPassword').fill(account.password);
  if (code) await screen.getByLabel('邀请码').fill(code);
  await screen.getByRole('button', '注册', { exact: true }).click();
  await expect(browser).toHaveURL(/verify-email/);
  await browser.locator('#email-verification-otp').fill(secrets.get(otpSecret));
  await screen.getByRole('button', '验证并继续').click();
  await expect(browser).toHaveURL(/\/settings\/security$/);
  return account;
}

export async function signIn({ app, screen, browser }: Fixture, account: ReturnType<typeof credentials.user>) {
  await app.open('/login');
  await screen.getByLabel('邮箱', { exact: true }).fill(account.username);
  await browser.locator('#password').fill(account.password);
  await screen.getByRole('button', '登录', { exact: true }).click();
  await expect(browser).toHaveURL(/\/(settings|two-factor)/);
}

export async function sessionState(browser: Browser) {
  return await browser.evaluate(async () => {
    const response = await fetch('/api/v1/auth/get-session');
    const body = await response.json();
    return { status: response.status, email: body?.user?.email ?? null };
  });
}

export async function protectArtifacts(values: string[]) {
  const response = await fetch(`${process.env.AUTH_E2E_CONTROL}/artifact-secret`, {
    method: 'POST', body: JSON.stringify({ values }),
  });
  if (!response.ok) throw new Error('Artifact secret registration failed');
}

export async function hideRevealedCodes() {
  await surfaceOf(authWebEngine)!.page().addStyleTag({
    content: '.content-panel code, .content-panel div.grid code { visibility: hidden !important; font-size: 0 !important; }',
  });
}

export async function enrollTotp({ app, screen, browser }: Fixture, account: ReturnType<typeof credentials.user>, { rejectWrong = true } = {}) {
  await app.open('/settings/two-factor');
  await hideRevealedCodes();
  const responsePromise = browser.waitForResponse(/\/api\/v1\/auth\/two-factor\/enable($|\?)/);
  await screen.getByLabel('当前密码').fill(account.password);
  await screen.getByRole('button', '继续', { exact: true }).click();
  const enabledResponse = await responsePromise;
  expect(enabledResponse.status).toBe(200);
  const enrollment = await enabledResponse.json<{ totpURI: string; backupCodes: string[] }>();
  authSecuritySecrets.mfaRawSecret = enrollment.totpURI;
  authSecuritySecrets.mfaBackupCode = enrollment.backupCodes[0]!;
  await protectArtifacts([enrollment.totpURI, ...enrollment.backupCodes]);
  await expect(screen.getByRole('heading', '扫描二维码', { exact: true })).toBeVisible();
  if (rejectWrong) {
    await browser.locator('#two-factor-totp').fill(secrets.get('wrongMfaTotp'));
    await screen.getByRole('button', '验证并继续').click();
    await expect(screen.getByText('验证码不正确')).toBeVisible();
  }
  await browser.locator('#two-factor-totp').fill(secrets.get('mfaTotp'));
  await screen.getByRole('button', '验证并继续').click();
  await expect(screen.getByRole('heading', '保存备用恢复码', { exact: true })).toBeVisible();
  await screen.getByText('我已保存这些恢复码，知道关闭此页面后将无法再次查看。').click();
  await screen.getByRole('button', '完成设置').click();
  await expect(screen.getByText('二次验证已启用。')).toBeVisible();
}
