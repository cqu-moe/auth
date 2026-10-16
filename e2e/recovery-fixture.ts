import { expect } from 'e2e';
import { createVerifiedAccount, protectArtifacts, type Fixture } from './auth-fixture';
import { identity, responseFor, saveCookies, surface } from './admin-fixture';

export async function virtualAuthenticator() {
  const cdp = await surface().context().newCDPSession(surface().page());
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}

export async function registerPasskey(fixture: Fixture, account: Awaited<ReturnType<typeof createVerifiedAccount>>, name: string) {
  const { screen } = fixture;
  await screen.getByRole('button', '添加 Passkey', { exact: true }).click();
  const editor = screen.getByRole('dialog', '添加 Passkey', { exact: true });
  await editor.getByLabel('名称', { exact: true }).fill(name);
  const registration = responseFor(/\/api\/v1\/auth\/passkey\/verify-registration$/, 'POST');
  await editor.getByRole('button', '添加并保存', { exact: true }).click();
  await screen.getByLabel('当前密码').fill(account.password);
  await screen.getByRole('button', '验证并继续').click();
  expect((await registration).status).toBe(200);
  await expect(screen.getByRole('list', '已添加的 Passkey').getByText(name, { exact: true })).toBeVisible();
}

/** Real UV Passkey admission avoids spending the target's native TOTP rate window on fixture setup. */
export async function passkeyAdministrator(fixture: Fixture) {
  const account = await createVerifiedAccount(fixture, 'manager', 'managerOtp');
  const promoted = await fetch(`${process.env.AUTH_E2E_CONTROL}/promote-admin`, {
    method: 'POST', body: JSON.stringify({ email: account.username }),
  });
  expect(promoted.status).toBe(204);
  const authenticator = await virtualAuthenticator();
  await registerPasskey(fixture, account, '管理员恢复密钥');
  const keys = await authenticator.cdp.send('WebAuthn.getCredentials', { authenticatorId: authenticator.authenticatorId });
  const credential = keys.credentials[0]!;
  await protectArtifacts([credential.privateKey]);
  await fixture.screen.getByRole('button', '退出登录', { exact: true }).click();
  await expect(fixture.browser).toHaveURL(/login/);
  await fixture.screen.getByRole('button', '使用 Passkey 登录').click();
  await expect(fixture.browser).toHaveURL(/\/settings$/);
  await fixture.app.open('/admin/users');
  await expect(fixture.screen.getByRole('heading', '用户管理', { exact: true })).toBeVisible();
  return { account, authenticator, credential, cookies: await saveCookies(), ...(await identity()) };
}
