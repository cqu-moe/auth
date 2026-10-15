import { test, beforeEach, afterEach } from '@e2e-dev/web';
import { expect, credentials, secrets } from 'e2e';
import { base32 } from '@better-auth/utils/base32';
import { createOTP } from '@better-auth/utils/otp';
import { enrollTotp, protectArtifacts, signIn } from './auth-fixture';
import { identity, newMember, request, responseFor, restore, saveCookies, setRole, surface, userRow } from './admin-fixture';
import { authorization, concealCredentials, createClient, issueTokens, tokenRequest, userinfo } from './oauth-fixture';
import { passkeyAdministrator, registerPasskey } from './recovery-fixture';
import { authSecuritySecrets } from './secret-holder';

let unexpected: string[];
beforeEach(async ({ browser }) => {
  unexpected = [];
  await browser.route('**/*', async route => {
    const origin = new URL(route.request.url).origin;
    if (origin !== process.env.AUTH_E2E_URL) { unexpected.push(origin); await route.abort(); }
    else await route.continue();
  });
});
afterEach(async () => { expect(unexpected).toEqual([]); });

test('manual recovery invalidates actual old factors and interactive credentials while preserving business data', { timeout: 180000 }, async fixture => {
  const { app, screen, browser } = fixture;
  const admin = await passkeyAdministrator(fixture);
  const client = await createClient(fixture);
  const member = await newMember(fixture);
  await registerPasskey(fixture, member.account, '恢复前用户密钥');
  await enrollTotp(fixture, member.account, { rejectWrong: false });
  const oldTotpUri = authSecuritySecrets.mfaRawSecret!;
  const oldBackup = authSecuritySecrets.mfaBackupCode!;
  await screen.getByRole('button', '退出登录', { exact: true }).click();
  await expect(browser).toHaveURL(/login/);
  await signIn(fixture, member.account);
  await expect(browser).toHaveURL(/two-factor/);
  await browser.locator('#twoFactorCode').fill(secrets.get('mfaTotp'));
  await screen.getByRole('checkbox', '在这台设备上保持信任 30 天').check();
  await screen.getByRole('button', '完成验证').click();
  await expect(browser).toHaveURL(/\/settings$/);
  const oldCookies = await saveCookies();
  const trustCookies = oldCookies.filter(cookie => /trust_device/.test(cookie.name));
  expect(trustCookies.length).toBe(1);
  const oldGrant = await issueTokens(client);
  expect((await userinfo(oldGrant.access_token)).status).toBe(200);
  const pendingAuthorization = await authorization(client.clientId, client.redirectUri);
  if (!pendingAuthorization.code) throw new Error('Expected an actual pending authorization code before recovery');
  const resetRequested = await request('/api/v1/auth/request-password-reset', 'POST', { email: member.user.email });
  expect(resetRequested.status).toBe(200);
  const delivered = await fetch(`${process.env.AUTH_E2E_CONTROL}/mail?email=${encodeURIComponent(member.user.email)}`);
  const { resetUrl } = await delivered.json() as { resetUrl: string };
  if (!resetUrl) throw new Error('Application reset email was not captured');
  await protectArtifacts([resetUrl]);
  const resetToken = new URL(resetUrl).pathname.split('/').at(-1)!;
  await protectArtifacts([resetToken]);

  await surface().context().clearCookies();
  await signIn(fixture, member.account);
  await expect(browser).toHaveURL(/two-factor/);
  const pendingMfaCookies = await saveCookies();
  await restore(fixture, admin.cookies);
  await concealCredentials();
  await setRole(fixture, 'member', '管理员');
  await userRow(fixture, member.user.email).getByRole('button', '权益').click();
  await screen.getByRole('checkbox', /^通知存档访问/).check();
  await screen.getByRole('button', '保存', { exact: true }).click();
  await expect(screen.getByText('已保存', { exact: true })).toBeVisible();
  await screen.getByRole('button', '取消', { exact: true }).click();
  expect((await request('/api/v1/auth/get-session', 'GET', undefined, oldCookies)).body.caps.feed.access).toBe(true);

  await userRow(fixture, member.user.email).getByRole('button', '重置认证').click();
  await expect(screen.getByRole('heading', '重置全部认证')).toBeVisible();
  await screen.getByRole('button', '取消', { exact: true }).click();
  expect((await request('/api/v1/auth/get-session', 'GET', undefined, oldCookies)).body.user.id).toBe(member.user.id);
  await userRow(fixture, member.user.email).getByRole('button', '重置认证').click();
  await screen.getByRole('button', '确认重置').click();
  const authenticationDialog = screen.getByRole('dialog').filter({ hasText: '验证身份后继续' });
  await authenticationDialog.getByRole('button', '取消', { exact: true }).click();
  await expect(screen.getByRole('button', '确认重置')).toBeEnabled();
  expect((await request('/api/v1/auth/get-session', 'GET', undefined, oldCookies)).body.user.id).toBe(member.user.id);

  await screen.getByRole('button', '确认重置').click();
  const recoveryResponse = responseFor(/\/api\/v1\/auth\/admin\/reset-authentication$/, 'POST');
  await screen.getByRole('button', '使用 Passkey 验证').click();
  const recovered = await recoveryResponse;
  expect(recovered.status).toBe(200);
  expect(recovered.headers['cache-control']).toBe('no-store');
  const { password, status } = await recovered.json<{ status: boolean; password: string }>();
  authSecuritySecrets.recoveryPassword = password;
  await protectArtifacts([password]);
  expect({ status, generatedPasswordLength: password.length }).toEqual({ status: true, generatedPasswordLength: 32 });
  expect(await surface().page().locator('#recovery-password').inputValue() === password).toBe(true);
  await screen.getByRole('button', '已保存，关闭').click();
  await expect(browser.locator('#recovery-password')).toHaveCount(0);
  await userRow(fixture, member.user.email).getByRole('button', '重置认证').click();
  await expect(screen.getByRole('heading', '重置全部认证')).toBeVisible();
  await expect(browser.locator('#recovery-password')).toHaveCount(0);
  await screen.getByRole('button', '取消', { exact: true }).click();

  expect((await request('/api/v1/auth/get-session', 'GET', undefined, oldCookies)).body).toBeNull();
  expect((await request('/api/v1/auth/security/status', 'GET', undefined, oldCookies)).status).toBe(401);
  const encodedSecret = new URL(oldTotpUri).searchParams.get('secret')!;
  const oldTotp = await createOTP(new TextDecoder().decode(base32.decode(encodedSecret))).totp();
  await protectArtifacts([oldTotp]);
  const oldTotpResult = await request('/api/v1/auth/two-factor/verify-totp', 'POST', { code: oldTotp }, pendingMfaCookies);
  expect({ status: oldTotpResult.status, code: oldTotpResult.body.code }).toEqual({ status: 401, code: 'INVALID_TWO_FACTOR_COOKIE' });
  const oldBackupResult = await request('/api/v1/auth/two-factor/verify-backup-code', 'POST', { code: oldBackup }, pendingMfaCookies);
  expect({ status: oldBackupResult.status, code: oldBackupResult.body.code }).toEqual({ status: 401, code: 'INVALID_TWO_FACTOR_COOKIE' });
  // This complete recovery crosses the unchanged 30/min public session-read
  // window. Wait through real 429s using safe GETs; never rewrite rate rows or
  // replay writes. Every other transport/status failure remains an immediate failure.
  let pendingSession: Awaited<ReturnType<typeof request>> | undefined;
  await expect.poll(async () => {
    pendingSession = await request('/api/v1/auth/get-session', 'GET', undefined, pendingMfaCookies);
    if (pendingSession.status !== 200 && pendingSession.status !== 429) throw new Error(`Unexpected session-read status ${pendingSession.status}`);
    return pendingSession.status;
  }, { timeout: 70000, interval: 1000 }).toBe(200);
  expect(pendingSession!.body).toBeNull();
  expect((await userinfo(oldGrant.access_token)).status).toBe(401);
  const oldRefresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: oldGrant.refresh_token }, client.clientId, client.clientSecret);
  expect({ status: oldRefresh.status, error: oldRefresh.body.error }).toEqual({ status: 400, error: 'invalid_grant' });
  const oldAuthorization = await tokenRequest({ grant_type: 'authorization_code', code: pendingAuthorization.code, code_verifier: pendingAuthorization.verifier, redirect_uri: client.redirectUri }, client.clientId, client.clientSecret);
  expect({ status: oldAuthorization.status, error: oldAuthorization.body.error }).toEqual({ status: 400, error: 'invalid_grant' });
  const unusedPassword = crypto.randomUUID() + 'A1!';
  await protectArtifacts([unusedPassword]);
  const oldReset = await request('/api/v1/auth/reset-password', 'POST', { token: resetToken, newPassword: unusedPassword }, []);
  expect({ status: oldReset.status, code: oldReset.body.code }).toEqual({ status: 400, code: 'INVALID_TOKEN' });
  expect((await request('/api/v1/auth/get-session')).body.user.id).toBe(admin.user.id);
  expect((await request('/api/v1/admin/oauth-clients')).body.data.some((item: { client_id: string }) => item.client_id === client.clientId)).toBe(true);

  await admin.authenticator.cdp.send('WebAuthn.removeCredential', {
    authenticatorId: admin.authenticator.authenticatorId, credentialId: admin.credential.credentialId,
  });
  await surface().context().clearCookies();
  await app.open('/login');
  const obsoletePasskey = responseFor(/\/api\/v1\/auth\/passkey\/verify-authentication$/, 'POST');
  await screen.getByRole('button', '使用 Passkey 登录').click();
  const rejectedPasskey = await obsoletePasskey;
  const passkeyError = await rejectedPasskey.json<{ code: string }>();
  expect({ status: rejectedPasskey.status, code: passkeyError.code }).toEqual({ status: 401, code: 'PASSKEY_NOT_FOUND' });
  await expect(screen.getByText('Passkey 登录未完成，请重试或使用密码登录')).toBeVisible();
  expect((await request('/api/v1/auth/get-session')).body).toBeNull();
  await app.open('/login');
  await screen.getByLabel('邮箱', { exact: true }).fill(member.account.username);
  await browser.locator('#password').fill(member.account.password);
  const oldPassword = responseFor(/\/api\/v1\/auth\/sign-in\/email$/, 'POST');
  await screen.getByRole('button', '登录', { exact: true }).click();
  expect((await oldPassword).status).toBe(401);
  await expect(browser).toHaveURL(/login/);

  await app.open('/login');
  const account = credentials.user('recovered');
  await screen.getByLabel('邮箱', { exact: true }).fill(account.username);
  await browser.locator('#password').fill(account.password);
  await screen.getByRole('button', '登录', { exact: true }).click();
  await expect(browser).toHaveURL(/\/settings$/);
  const fresh = await identity();
  expect({ id: fresh.user.id, name: fresh.user.name, role: fresh.user.role, mfa: fresh.user.twoFactorEnabled }).toEqual({ id: member.user.id, name: 'Synthetic member', role: 'admin', mfa: false });
  expect((await request('/api/v1/auth/get-session')).body.caps.feed.access).toBe(true);
  expect((await request('/api/v1/auth/passkey/list-user-passkeys')).body).toEqual([]);
  const weakAdmin = await request('/api/v1/admin/users');
  expect({ status: weakAdmin.status, code: weakAdmin.body.code }).toEqual({ status: 403, code: 'STRONG_AUTH_REQUIRED' });
  await enrollTotp(fixture, account, { rejectWrong: false });
  await screen.getByRole('button', '退出登录', { exact: true }).click();
  await expect(browser).toHaveURL(/login/);
  await surface().context().clearCookies();
  await surface().context().addCookies(trustCookies);
  await signIn(fixture, account);
  await expect(browser).toHaveURL(/two-factor/);
  expect((await request('/api/v1/auth/get-session')).body).toBeNull();
  await browser.locator('#twoFactorCode').fill(secrets.get('mfaTotp'));
  await screen.getByRole('button', '完成验证').click();
  await expect(browser).toHaveURL(/\/settings$/);
  await app.open('/admin/users');
  await expect(screen.getByRole('heading', '用户管理', { exact: true })).toBeVisible();
  expect((await request('/api/v1/admin/users')).status).toBe(200);
});
