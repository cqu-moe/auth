import { test, beforeEach, afterEach } from '@e2e-dev/web';
import { expect, credentials, secrets } from 'e2e';
import { administrator, newMember, restore, request, setRole, userRow, login, saveCookies, adminProof, responseFor, surface, identity, sessionAfterRateLimit } from './admin-fixture';
import { createVerifiedAccount, enrollTotp, protectArtifacts } from './auth-fixture';
import { authSecuritySecrets } from './secret-holder';
import { authorization, concealCredentials, createClient, issueTokens, tokenRequest, userinfo } from './oauth-fixture';
import { TURNSTILE_SCRIPT_URL, fulfillTurnstileFixture } from './turnstile.mjs';

let unexpected: string[];
beforeEach(async ({ browser }) => {
  unexpected = [];
  await browser.route('**/*', async route => {
    const url = new URL(route.request.url);
    if (`${url.origin}${url.pathname}` === TURNSTILE_SCRIPT_URL) return await fulfillTurnstileFixture(route);
    const origin = url.origin;
    if (origin !== process.env.AUTH_E2E_URL) { unexpected.push(origin); await route.abort(); }
    else await route.continue();
  });
});

test('strong ordinary administrators retain allowed actions but cannot acquire superAdmin powers', async fixture => {
  const { app, screen, browser } = fixture;
  const admin = await administrator(fixture);
  const reviewer = await newMember(fixture, 'reviewer');
  await enrollTotp(fixture, reviewer.account, { rejectWrong: false });
  const reviewerCookies = await saveCookies();
  await restore(fixture, admin.cookies);
  await setRole(fixture, 'reviewer', '管理员');
  await restore(fixture, reviewerCookies);
  await adminProof(fixture, reviewer.account, 'mfaTotp');
  expect((await request('/api/v1/admin/users')).status).toBe(200);
  const before = await request(`/api/v1/admin/users/${admin.user.id}/entitlements`);
  expect(before.status).toBe(200);

  await userRow(fixture, admin.user.email).getByRole('button', '权益').click();
  await screen.getByRole('checkbox', /^通知存档访问/).check();
  const deniedSave = browser.waitForResponse(new RegExp(`/api/v1/admin/users/${admin.user.id}/entitlements$`));
  await screen.getByRole('button', '保存', { exact: true }).click();
  expect((await deniedSave).status).toBe(403);
  await expect(screen.getByText('需要 superAdmin 权限')).toBeVisible();
  await screen.getByRole('button', '取消', { exact: true }).click();
  const clientBefore = await request('/api/v1/admin/oauth-clients');
  expect(clientBefore.status).toBe(200);
  for (const [path, method, body, code] of [
    [`/api/v1/admin/users/${reviewer.user.id}`, 'PATCH', { role: 'superAdmin' }, 'AUTH_ADMIN_ERROR'],
    ['/api/v1/admin/registration-settings', 'PUT', { invitationRequired: false }, 'FORBIDDEN'],
    ['/api/v1/admin/entitlement-presets/forbidden', 'PUT', { items: [{ subsystem: 'feed', capability: 'access', value: '1' }] }, 'FORBIDDEN'],
    ['/api/v1/admin/registration-invitations', 'POST', { preset: '学生' }, 'FORBIDDEN'],
    ['/api/v1/admin/oauth-clients', 'POST', { client_name: 'Forbidden', redirect_uris: [`${process.env.AUTH_E2E_URL}/callback`], token_endpoint_auth_method: 'none' }, 'FORBIDDEN'],
    [`/api/v1/admin/users/${admin.user.id}/quicklogin-quota/preview`, 'POST', { deviceLimit: 1 }, 'FORBIDDEN'],
  ] as const) {
    const denied = await request(path, method, body);
    expect({ status: denied.status, code: denied.body.code }).toEqual({ status: 403, code });
  }
  const recovery = await request('/api/v1/auth/admin/reset-authentication', 'POST', { userId: admin.user.id });
  expect({ status: recovery.status, message: recovery.body.message }).toEqual({ status: 403, message: '需要管理员权限及近期强认证' });
  const ban = await request('/api/v1/auth/admin/ban-user', 'POST', { userId: admin.user.id });
  expect({ status: ban.status, code: ban.body.code }).toEqual({ status: 403, code: 'CANNOT_BAN_ADMINS' });
  const sessions = await request('/api/v1/auth/admin/list-user-sessions', 'POST', { userId: admin.user.id });
  expect({ status: sessions.status, code: sessions.body.code }).toEqual({ status: 403, code: 'YOU_ARE_NOT_ALLOWED_TO_LIST_USERS_SESSIONS' });
  const revoke = await request('/api/v1/auth/admin/revoke-user-session', 'POST', { sessionToken: admin.session.token });
  expect({ status: revoke.status, code: revoke.body.code }).toEqual({ status: 403, code: 'YOU_ARE_NOT_ALLOWED_TO_REVOKE_USERS_SESSIONS' });
  expect((await request('/api/v1/auth/get-session', 'GET', undefined, admin.cookies)).body.user.id).toBe(admin.user.id);
  expect((await request(`/api/v1/admin/users/${admin.user.id}/entitlements`)).body.data).toEqual(before.body.data);
  expect((await request(`/api/v1/admin/users/${reviewer.user.id}`)).body.data.role).toBe('admin');
  expect((await request(`/api/v1/admin/users/${admin.user.id}`)).body.data.banned).toBe(false);
  expect((await request('/api/v1/admin/oauth-clients')).body.data).toEqual(clientBefore.body.data);
  expect((await request('/api/v1/admin/registration-settings')).body.data.invitationRequired).toBe(true);

  await app.open('/admin/invitations');
  const created = responseFor(/\/api\/v1\/admin\/registration-invitations$/, 'POST');
  await screen.getByRole('button', '生成邀请').click();
  expect((await created).status).toBe(201);
  await expect(screen.getByText('注册链接已生成')).toBeVisible();
  await browser.reload();
  await expect(screen.getByRole('heading', '注册邀请', { exact: true })).toBeVisible();
  expect((await request('/api/v1/admin/registration-invitations')).body.data.some((item: { createdBy: string }) => item.createdBy === reviewer.user.id)).toBe(true);
});

test('managed invitations apply saved presets at real registration and revoked invitations cannot register', async fixture => {
  const { app, screen, browser } = fixture;
  const admin = await administrator(fixture);
  await app.open('/admin/presets');
  await screen.getByRole('button', '新建预设').click();
  await screen.getByLabel('预设名称').fill('E2E 通知权益');
  await screen.getByRole('checkbox', /^通知存档访问/).check();
  await screen.getByRole('button', '保存', { exact: true }).click();
  await expect(screen.getByText('预设已创建')).toBeVisible();
  await browser.reload();
  await expect(screen.getByText('E2E 通知权益', { exact: true })).toBeVisible();
  const presets = await request('/api/v1/admin/entitlement-presets');
  expect(presets.body.data.find((preset: { name: string }) => preset.name === 'E2E 通知权益').items)
    .toEqual([{ subsystem: 'feed', capability: 'access', value: '1' }]);

  await app.open('/admin/invitations');
  await surface().page().addStyleTag({ content: '.content-panel .tracking-widest, .content-panel input[readonly], .content-panel tbody td:first-child { visibility:hidden!important; }' });
  await screen.getByRole('combobox', '新邀请的权益预设').click();
  await screen.getByRole('option', /^E2E 通知权益/).click();
  const creation = responseFor(/\/api\/v1\/admin\/registration-invitations$/, 'POST');
  await screen.getByRole('button', '生成邀请').click();
  const invitation = await creation;
  expect(invitation.status).toBe(201);
  const { data: created } = await invitation.json<{ data: { code: string; preset: string } }>();
  authSecuritySecrets.managedInvitation = created.code;
  await protectArtifacts([created.code]);
  await expect(screen.getByText('注册链接已生成')).toBeVisible();
  await surface().context().clearCookies();
  await createVerifiedAccount(fixture, 'member', 'memberOtp', secrets.get('managedInvitation'));
  const member = await identity();
  const caps = await request('/api/v1/auth/get-session');
  expect(caps.body.caps.feed.access).toBe(true);

  await restore(fixture, admin.cookies, '/admin/invitations');
  await surface().page().addStyleTag({ content: '.content-panel .tracking-widest, .content-panel input[readonly], .content-panel tbody td:first-child { visibility:hidden!important; }' });
  const list = await request('/api/v1/admin/registration-invitations');
  const used = list.body.data.find((item: { code: string }) => item.code === created.code);
  expect({ status: used.status, userId: used.usedByUserId, preset: used.preset }).toEqual({ status: 'used', userId: member.user.id, preset: 'E2E 通知权益' });
  await screen.getByRole('combobox', '新邀请的权益预设').click();
  await screen.getByRole('option', /^E2E 通知权益/).click();
  const secondCreation = responseFor(/\/api\/v1\/admin\/registration-invitations$/, 'POST');
  await screen.getByRole('button', '生成邀请').click();
  const second = await secondCreation;
  expect(second.status).toBe(201);
  const revoked = (await second.json<{ data: { code: string } }>()).data;
  // This code is a local-only prerequisite for a rejected registration, never a success fixture.
  authSecuritySecrets.managedInvitation = revoked.code;
  await protectArtifacts([revoked.code]);
  const row = screen.getByRole('row').filter({ hasText: 'E2E 通知权益' }).filter({ hasText: '可使用' });
  await row.getByRole('button', '撤销').click();
  await expect(screen.getByRole('row').filter({ hasText: 'E2E 通知权益' }).getByText('已撤销')).toBeVisible();
  const revokedRead = await request('/api/v1/admin/registration-invitations');
  expect(revokedRead.body.data.find((item: { code: string }) => item.code === revoked.code).status).toBe('revoked');
  await surface().context().clearCookies();
  await app.open('/register');
  await screen.getByLabel('昵称').fill('Synthetic invitee');
  await screen.getByLabel('邮箱', { exact: true }).fill(credentials.user('invitee').username);
  await browser.locator('#password').fill(credentials.user('invitee').password);
  await browser.locator('#confirmPassword').fill(credentials.user('invitee').password);
  await screen.getByLabel('邀请码').fill(secrets.get('managedInvitation'));
  const rejected = responseFor(/\/api\/v1\/auth\/sign-up\/email$/, 'POST');
  await screen.getByRole('button', '注册', { exact: true }).click();
  expect((await rejected).status).toBe(400);
  await expect(screen.getByText(/邀请码.*(无效|撤销)/)).toBeVisible();
  expect((await request('/api/v1/auth/get-session')).body).toBeNull();
});
afterEach(async () => { expect(unexpected).toEqual([]); });

test('administrator users and roles persist while ordinary and weak sessions cannot enter', async fixture => {
  const { app, screen, browser } = fixture;
  await app.open('/login');
  if (process.env.AUTH_E2E_BREAK_ASSERTION === '1') {
    await expect(screen.getByRole('heading', 'AUTH-05 deliberately missing administration heading')).toBeVisible();
  }
  const admin = await administrator(fixture, true);
  const member = await newMember(fixture);
  await app.open('/admin/users');
  await expect(browser).toHaveURL(/\/settings$/);
  for (const path of ['/api/v1/admin/users', '/api/v1/admin/registration-invitations', '/api/v1/admin/oauth-clients']) {
    const denied = await request(path);
    expect({ status: denied.status, code: denied.body.code }).toEqual({ status: 403, code: 'FORBIDDEN' });
  }

  await restore(fixture, admin.cookies);
  await setRole(fixture, 'member', '管理员');
  await expect(userRow(fixture, member.user.email)).toContainText('管理员');
  expect((await request(`/api/v1/admin/users/${member.user.id}`)).body.data.role).toBe('admin');
  await restore(fixture, member.cookies);
  await expect(screen.getByRole('heading', '验证管理身份')).toBeVisible();
  const weak = await request('/api/v1/admin/users');
  expect({ status: weak.status, code: weak.body.code }).toEqual({ status: 403, code: 'STRONG_AUTH_REQUIRED' });

  await restore(fixture, admin.cookies);
  await browser.reload();
  await expect(userRow(fixture, member.user.email)).toContainText('管理员');
  expect((await request(`/api/v1/admin/users/${member.user.id}`)).body.data.role).toBe('admin');
});

test('administrator ban and unban change real access while self ban is rejected', async fixture => {
  const { screen, browser } = fixture;
  const admin = await administrator(fixture);
  const member = await newMember(fixture);
  await restore(fixture, admin.cookies);
  await userRow(fixture, member.user.email).getByRole('button', '封禁').click();
  await expect(userRow(fixture, member.user.email)).toContainText('已封禁');
  await browser.reload();
  await expect(userRow(fixture, member.user.email)).toContainText('已封禁');
  expect((await request(`/api/v1/admin/users/${member.user.id}`)).body.data.banned).toBe(true);
  await restore(fixture, member.cookies, '/settings');
  await expect(browser).toHaveURL(/login/);
  expect((await request('/api/v1/auth/get-session')).body).toBeNull();
  await screen.getByLabel('邮箱', { exact: true }).fill(member.account.username);
  await browser.locator('#password').fill(member.account.password);
  const blockedLogin = browser.waitForResponse(/\/api\/v1\/auth\/sign-in\/email$/);
  await screen.getByRole('button', '登录', { exact: true }).click();
  expect((await blockedLogin).status).toBe(403);
  await expect(browser).toHaveURL(/login/);

  await restore(fixture, admin.cookies);
  await userRow(fixture, member.user.email).getByRole('button', '解封').click();
  await expect(userRow(fixture, member.user.email)).toContainText('正常');
  await browser.reload();
  await expect(userRow(fixture, member.user.email)).toContainText('正常');
  expect((await request(`/api/v1/admin/users/${member.user.id}`)).body.data.banned).toBe(false);
  await userRow(fixture, admin.user.email).getByRole('button', '封禁').click();
  await expect(screen.getByText('操作失败，请稍后重试')).toBeVisible();
  expect((await request(`/api/v1/admin/users/${admin.user.id}`)).body.data.banned).toBe(false);
  const self = await request('/api/v1/auth/admin/ban-user', 'POST', { userId: admin.user.id });
  expect({ status: self.status, code: self.body.code }).toEqual({ status: 400, code: 'YOU_CANNOT_BAN_YOURSELF' });
  expect((await request('/api/v1/admin/users')).status).toBe(200);
  await login(fixture);
  await expect(browser).toHaveURL(/\/settings$/);
  const live = await sessionAfterRateLimit();
  expect(live.status).toBe(200);
  expect({ email: live.body.user.email, role: live.body.user.role }).toEqual({ email: credentials.user('member').username, role: 'user' });
});

test('saved user entitlements and device quota affect only the intended account and revoke real access', async fixture => {
  const { screen, browser } = fixture;
  const admin = await administrator(fixture);
  const member = await newMember(fixture);
  expect((await request('/api/v1/cqu/quicklogin')).body.data).toEqual({ eligible: false });
  const denied = await request('/api/v1/cqu/quicklogin', 'PUT', { enabled: true });
  expect({ status: denied.status, code: denied.body.code }).toEqual({ status: 403, code: 'FORBIDDEN' });

  await restore(fixture, admin.cookies);
  await userRow(fixture, member.user.email).getByRole('button', '权益').click();
  await screen.getByRole('checkbox', /^通知存档访问/).check();
  await screen.getByRole('button', '保存', { exact: true }).click();
  await expect(screen.getByRole('alert').filter({ hasText: /^已保存$/ })).toBeVisible();
  const granted = await request(`/api/v1/admin/users/${member.user.id}/entitlements`);
  expect(granted.body.data.map(({ subsystem, capability, value }: { subsystem: string; capability: string; value: string }) => ({ subsystem, capability, value })))
    .toEqual([{ subsystem: 'feed', capability: 'access', value: '1' }]);
  expect((await request('/api/v1/auth/get-session', 'GET', undefined, member.cookies)).body.caps.feed.access).toBe(true);

  await screen.getByLabel('设备数').fill('2');
  await screen.getByRole('button', '预览调整').click();
  await expect(screen.getByText('不会停用设备')).toBeVisible();
  await screen.getByRole('button', '确认保存额度').click();
  await expect(screen.getByText('设备额度已保存')).toBeVisible();
  const eligible = await request('/api/v1/cqu/quicklogin', 'GET', undefined, member.cookies);
  expect({ status: eligible.status, eligible: eligible.body.data.eligible }).toEqual({ status: 200, eligible: true });
  expect((await request('/api/v1/cqu/quicklogin', 'PUT', { enabled: true }, member.cookies)).body.data.masterEnabled).toBe(true);
  await screen.getByRole('button', '取消', { exact: true }).click();
  await browser.reload();
  await userRow(fixture, member.user.email).getByRole('button', '权益').click();
  await expect(screen.getByRole('checkbox', /^通知存档访问/)).toBeChecked();
  await expect(screen.getByLabel('快捷登录设备额度当前值')).toContainText('2');
  const deviceRead = await request('/api/v1/cqu/quicklogin', 'GET', undefined, member.cookies);
  expect(deviceRead.body.data).toEqual({ eligible: true, masterEnabled: true, deviceLimit: 2, used: 0 });
  expect((await request('/api/v1/cqu/quicklogin', 'GET', undefined, admin.cookies)).body.data).toEqual({ eligible: false });
  const forbiddenQuota = await request(`/api/v1/admin/users/${admin.user.id}/quicklogin-quota/preview`, 'POST', { deviceLimit: 99 }, member.cookies);
  expect({ status: forbiddenQuota.status, code: forbiddenQuota.body.code }).toEqual({ status: 403, code: 'FORBIDDEN' });
  const bypass = await request(`/api/v1/admin/users/${member.user.id}/entitlements`, 'PUT', {
    items: [{ subsystem: 'cqu', capability: 'quicklogin_device_limit', value: '99' }],
  });
  expect({ status: bypass.status, code: bypass.body.code }).toEqual({ status: 409, code: 'QUICKLOGIN_PREVIEW_REQUIRED' });
  await screen.getByRole('checkbox', /^通知存档访问/).uncheck();
  await screen.getByRole('button', '保存', { exact: true }).click();
  await expect(screen.getByRole('alert').filter({ hasText: /^已保存$/ })).toBeVisible();
  expect((await request('/api/v1/cqu/quicklogin', 'PUT', { enabled: false }, member.cookies)).body.data.masterEnabled).toBe(false);
  await screen.getByLabel('设备数').fill('0');
  await screen.getByRole('button', '预览调整').click();
  await expect(screen.getByText('不会停用设备')).toBeVisible();
  await screen.getByRole('button', '确认保存额度').click();
  await expect(screen.getByText('设备额度已保存')).toBeVisible();
  await screen.getByRole('button', '取消', { exact: true }).click();
  await browser.reload();
  await userRow(fixture, member.user.email).getByRole('button', '权益').click();
  await expect(screen.getByRole('checkbox', /^通知存档访问/)).not.toBeChecked();
  expect((await request('/api/v1/auth/get-session', 'GET', undefined, member.cookies)).body.caps.feed.access).toBe(false);
  expect((await request('/api/v1/cqu/quicklogin', 'GET', undefined, member.cookies)).body.data).toEqual({ eligible: false });
  expect((await request('/api/v1/cqu/quicklogin', 'PUT', { enabled: true }, member.cookies)).status).toBe(403);
});

test('administrator session revocation preserves other devices and user session APIs cannot revoke another owner', async fixture => {
  const { screen, browser } = fixture;
  const admin = await administrator(fixture);
  const member = await newMember(fixture);
  const otherLogin = await fetch(`${process.env.AUTH_E2E_CONTROL}/real-session`, {
    method: 'POST', body: JSON.stringify({ email: member.user.email }),
  });
  expect(otherLogin.status).toBe(200);
  const { cookies: otherCookies } = await otherLogin.json() as { cookies: Array<{ name: string; value: string }> };
  const other = await request('/api/v1/auth/get-session', 'GET', undefined, otherCookies);
  expect(other.body.user.id).toBe(member.user.id);
  await protectArtifacts([other.body.session.token]);
  await screen.getByRole('button', '查看登录设备').click();
  await expect(screen.getByRole('button', '退出此设备')).toHaveCount(2);
  const ownSessions = await request('/api/v1/auth/list-sessions');
  expect(ownSessions.body.every((session: { userId: string }) => session.userId === member.user.id)).toBe(true);
  const crossOwner = await request('/api/v1/auth/revoke-session', 'POST', { token: admin.session.token });
  expect(crossOwner.status).toBe(200); // Native non-owner revocation is deliberately a no-op.
  expect((await request('/api/v1/auth/get-session', 'GET', undefined, admin.cookies)).body.user.id).toBe(admin.user.id);
  const adminDenial = await request('/api/v1/auth/admin/revoke-user-session', 'POST', { sessionToken: admin.session.token });
  expect(adminDenial.status).toBe(403);
  const listed = await request('/api/v1/auth/admin/list-user-sessions', 'POST', { userId: member.user.id }, admin.cookies);
  expect(listed.status).toBe(200);
  expect(listed.body.sessions.length).toBe(2);
  const revoked = await request('/api/v1/auth/admin/revoke-user-session', 'POST', { sessionToken: other.body.session.token }, admin.cookies);
  expect({ status: revoked.status, success: revoked.body.success }).toEqual({ status: 200, success: true });
  expect((await request('/api/v1/auth/get-session', 'GET', undefined, otherCookies)).body).toBeNull();
  expect((await request('/api/v1/auth/get-session')).body.user.id).toBe(member.user.id);
  expect((await request('/api/v1/auth/get-session', 'GET', undefined, admin.cookies)).body.user.id).toBe(admin.user.id);
  await browser.reload();
  await screen.getByRole('button', '查看登录设备').click();
  await expect(screen.getByRole('button', '退出此设备')).toHaveCount(1);
});

test('OAuth client edits, secret rotation and deletion change the real provider configuration', async fixture => {
  const { app, screen, browser } = fixture;
  const admin = await administrator(fixture);
  const client = await createClient(fixture);
  await browser.reload();
  await concealCredentials();
  await screen.getByRole('button', '编辑', { exact: true }).click();
  await expect(screen.getByLabel('名称', { exact: true })).toHaveValue('E2E 管理客户端');
  await expect(screen.getByLabel('添加回调 URI 第 1 项')).toHaveValue(client.redirectUri);
  const nextRedirect = 'https://client.example.test/callback?e2e=changed';
  await screen.getByLabel('名称', { exact: true }).fill('E2E 已保存客户端');
  await screen.getByLabel('添加回调 URI 第 1 项').fill(nextRedirect);
  await screen.getByRole('checkbox', /^教务系统/).check();
  const saved = responseFor(new RegExp(`/api/v1/admin/oauth-clients/${client.clientId}$`), 'PATCH');
  await screen.getByRole('button', '保存', { exact: true }).click();
  expect((await saved).status).toBe(200);
  await expect(screen.getByRole('heading', 'E2E 已保存客户端')).toBeVisible();
  await browser.reload();
  await concealCredentials();
  await screen.getByRole('button', '编辑', { exact: true }).click();
  await expect(screen.getByLabel('名称', { exact: true })).toHaveValue('E2E 已保存客户端');
  await expect(screen.getByLabel('添加回调 URI 第 1 项')).toHaveValue(nextRedirect);
  await screen.getByRole('button', '取消', { exact: true }).click();
  const inventory = await request('/api/v1/admin/oauth-clients');
  const configured = inventory.body.data.find((item: { client_id: string }) => item.client_id === client.clientId);
  expect({ name: configured.client_name, callbacks: configured.redirect_uris, pkce: configured.require_pkce }).toEqual({ name: 'E2E 已保存客户端', callbacks: [nextRedirect], pkce: true });
  expect(Object.keys(configured).some(key => /secret/i.test(key))).toBe(false);
  expect((await request(`/api/v1/admin/oauth-clients/${client.clientId}/scopes`)).body.data.scopes).toEqual(['cqu:ticket:jwxt']);

  const member = await newMember(fixture);
  const oldCallback = await authorization(client.clientId, client.redirectUri);
  expect({ error: oldCallback.error, hasCode: Boolean(oldCallback.code) }).toEqual({ error: 'invalid_redirect', hasCode: false });
  const updatedClient = { ...client, redirectUri: nextRedirect };
  const oldGrant = await issueTokens(updatedClient);
  const consumer = await userinfo(oldGrant.access_token);
  expect({ status: consumer.status, email: consumer.body.email }).toEqual({ status: 200, email: member.user.email });

  await restore(fixture, admin.cookies, '/admin/oauth');
  await concealCredentials();
  await screen.getByRole('button', '编辑', { exact: true }).click();
  const rotatedResponse = responseFor(new RegExp(`/api/v1/admin/oauth-clients/${client.clientId}/secrets$`), 'POST');
  await screen.getByRole('button', '重新生成密钥').click();
  const rotated = await rotatedResponse;
  expect(rotated.status).toBe(201);
  const nextSecret = (await rotated.json<{ data: { client_secret: string } }>()).data.client_secret;
  await protectArtifacts([nextSecret]);
  expect(Boolean(nextSecret) && nextSecret !== client.clientSecret).toBe(true);
  await expect(screen.getByRole('heading', '新的客户端密钥')).toBeVisible();
  await screen.getByRole('button', '我已保存').click();
  await screen.getByRole('button', '取消', { exact: true }).click();
  const pending = await authorization(client.clientId, nextRedirect, member.cookies);
  if (!pending.code) throw new Error('Expected real OAuth authorization before testing rotated credentials');
  const obsolete = await tokenRequest({ grant_type: 'authorization_code', code: pending.code, code_verifier: pending.verifier, redirect_uri: nextRedirect }, client.clientId, client.clientSecret);
  expect({ status: obsolete.status, error: obsolete.body.error }).toEqual({ status: 401, error: 'invalid_client' });
  const fresh = await issueTokens({ ...updatedClient, clientSecret: nextSecret }, member.cookies);
  expect((await userinfo(fresh.access_token)).status).toBe(200);
  await screen.getByRole('button', '删除', { exact: true }).click();
  const deletion = responseFor(new RegExp(`/api/v1/admin/oauth-clients/${client.clientId}$`), 'DELETE');
  await screen.getByRole('dialog').getByRole('button', '删除', { exact: true }).click();
  expect((await deletion).status).toBe(204);
  await expect(screen.getByText('暂无 OAuth 客户端')).toBeVisible();
  await browser.reload();
  await expect(screen.getByText('暂无 OAuth 客户端')).toBeVisible();
  expect((await request('/api/v1/admin/oauth-clients')).body.data).toEqual([]);
  expect((await request(`/api/v1/admin/oauth-clients/${client.clientId}/scopes`)).body.data.scopes).toEqual([]);
  const deleted = await authorization(client.clientId, nextRedirect, member.cookies);
  expect(Boolean(deleted.code)).toBe(false);
  expect(deleted.error).toBe('invalid_client');
});

test('saved registration policy and default entitlements govern a real signup without a seeded invitation', async fixture => {
  const { app, screen, browser } = fixture;
  const admin = await administrator(fixture);
  await app.open('/admin/presets');
  await screen.getByRole('button', '新建预设').click();
  await screen.getByLabel('预设名称').fill('E2E 默认通知');
  await screen.getByRole('checkbox', /^通知存档访问/).check();
  await screen.getByRole('button', '保存', { exact: true }).click();
  await expect(screen.getByText('预设已创建')).toBeVisible();
  const defaultSaved = responseFor(/\/api\/v1\/admin\/entitlement-default$/, 'PUT');
  await screen.getByRole('combobox', '新用户默认权益').click();
  await screen.getByRole('option', /^E2E 默认通知/).click();
  expect((await defaultSaved).status).toBe(200);
  await browser.reload();
  await expect(screen.getByRole('combobox', '新用户默认权益')).toContainText('E2E 默认通知');
  expect((await request('/api/v1/admin/entitlement-default')).body.data.preset).toBe('E2E 默认通知');
  await app.open('/admin/invitations');
  const opened = responseFor(/\/api\/v1\/admin\/registration-settings$/, 'PUT');
  await screen.getByRole('switch', '强制邀请码注册').uncheck();
  expect((await opened).status).toBe(200);
  await browser.reload();
  await expect(screen.getByRole('switch', '强制邀请码注册')).not.toBeChecked();
  expect((await request('/api/v1/registration-settings')).body.data.invitationRequired).toBe(false);
  await surface().context().clearCookies();
  await createVerifiedAccount(fixture, 'member', 'memberOtp', false);
  const memberCookies = await saveCookies();
  expect((await request('/api/v1/auth/get-session')).body.caps.feed.access).toBe(true);
  await restore(fixture, admin.cookies, '/admin/invitations');
  const closed = responseFor(/\/api\/v1\/admin\/registration-settings$/, 'PUT');
  await screen.getByRole('switch', '强制邀请码注册').check();
  expect((await closed).status).toBe(200);
  await browser.reload();
  await expect(screen.getByRole('switch', '强制邀请码注册')).toBeChecked();
  expect((await request('/api/v1/registration-settings')).body.data.invitationRequired).toBe(true);
  expect((await request('/api/v1/auth/get-session', 'GET', undefined, memberCookies)).body.caps.feed.access).toBe(true);
  await surface().context().clearCookies();
  await app.open('/register');
  await screen.getByLabel('昵称').fill('Synthetic invitee');
  await screen.getByLabel('邮箱', { exact: true }).fill(credentials.user('invitee').username);
  await browser.locator('#password').fill(credentials.user('invitee').password);
  await browser.locator('#confirmPassword').fill(credentials.user('invitee').password);
  await screen.getByRole('button', '注册', { exact: true }).click();
  await expect(screen.getByText('请输入邀请码', { exact: true })).toBeVisible();
  await expect(browser).toHaveURL(/register/);
  expect((await request('/api/v1/auth/get-session')).body).toBeNull();
});
