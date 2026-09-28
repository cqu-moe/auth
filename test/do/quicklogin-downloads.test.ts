import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { createApiFixture } from './api-fixture';

const base = '/api/v1/cqu/quicklogin';
const bucket = () => (env as typeof env & { QUICKLOGIN_RELEASES: R2Bucket }).QUICKLOGIN_RELEASES;
const payload = new Uint8Array([80, 75, 3, 4, 10, 20, 30, 40]);
async function seed(version = '0.4.0', content = payload) {
  const filename = `cqu-quicklogin-${version}-canary.zip`;
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', content)), b => b.toString(16).padStart(2, '0')).join('');
  const record = { schemaVersion: 1, channel: 'canary', version, filename,
    objectKey: `quicklogin/releases/${version}/${filename}`, size: content.length,
    sha256, sourceCommit: 'a'.repeat(40), protocolVersion: 3, contractDigest: 'b'.repeat(64),
    publishedAt: '2026-09-28T00:00:00Z', notes: ['合成测试版本'] };
  await bucket().put(record.objectKey, content, { customMetadata: { sha256 } });
  await bucket().put(`quicklogin/releases/${version}/release.json`, JSON.stringify(record));
  await bucket().put('quicklogin/channels/canary.json', JSON.stringify(record));
  return record;
}
async function identity(fixture: Awaited<ReturnType<typeof createApiFixture>>) {
  const headers = await fixture.signIn('user');
  const response = await fixture.request('/api/v1/auth/get-session', { headers });
  const { user } = await response.json() as { user: { id: string } };
  return { headers, id: user.id };
}
async function grant(id: string) {
  await env.DATABASE.prepare('INSERT INTO quicklogin_account_projection (user_id, revision, device_limit, master_enabled, updated_at) VALUES (?, 1, 0, 0, 0)').bind(id).run();
}

describe('QuickLogin release downloads', () => {
  it('publishes safe metadata without granting anonymous or bearer downloads, including HEAD', async () => {
    const fixture = await createApiFixture();
    const record = await seed();
    const result = await fixture.request(`${base}/release`);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ data: { version: record.version, filename: record.filename,
      size: record.size, sha256: record.sha256, publishedAt: record.publishedAt, notes: record.notes } });
    for (const method of ['GET', 'HEAD']) {
      expect((await fixture.request(`${base}/download`, { method })).status).toBe(401);
      expect((await fixture.request(`${base}/download`, { method, headers: { authorization: 'Bearer invalid' } })).status).toBe(401);
    }
  });

  it('streams pinned bytes only while a session has eligibility, independent of switches and quota', async () => {
    const fixture = await createApiFixture();
    const { headers, id } = await identity(fixture);
    const record = await seed();
    expect((await fixture.request(`${base}/download`, { headers })).status).toBe(403);
    await grant(id);
    const nextPayload = new Uint8Array([80, 75, 3, 4, 50, 60, 70, 80]);
    const nextRecord = await seed('0.4.1', nextPayload);
    expect(nextRecord.sha256).not.toBe(record.sha256);
    const result = await fixture.request(`${base}/download?version=0.4.0`, { headers });
    expect(result.status).toBe(200);
    const bytes = new Uint8Array(await result.arrayBuffer());
    expect(bytes).toEqual(payload);
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
    expect(digest).toBe(record.sha256);
    expect(digest).not.toBe(nextRecord.sha256);
    expect(result.headers.get('content-disposition')).toBe(`attachment; filename="${record.filename}"`);
    expect(result.headers.get('cache-control')).toBe('private, no-store');
    const head = await fixture.request(`${base}/download?version=0.4.0`, { method: 'HEAD', headers });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    headers.set('authorization', 'Bearer invalid');
    expect((await fixture.request(`${base}/download`, { headers })).status).toBe(401);
    headers.delete('authorization');
    await env.DATABASE.prepare('DELETE FROM quicklogin_account_projection WHERE user_id=?').bind(id).run();
    expect((await fixture.request(`${base}/download`, { headers })).status).toBe(403);
    const htmlHeaders = new Headers(headers); htmlHeaders.set('accept', 'text/html');
    const denied = await fixture.request(`${base}/download`, { headers: htmlHeaders });
    expect(denied.status).toBe(403);
    expect(await denied.text()).toContain('内测中，暂未开放');
  });

  it('fails closed on invalid versions, missing objects, corrupted metadata and storage errors', async () => {
    const fixture = await createApiFixture();
    const { headers, id } = await identity(fixture); await grant(id);
    const record = await seed();
    for (const query of ['version=../secret', 'version=https://evil.test', 'version=0.4.0&version=0.4.1', 'version=', 'version=00.4.0']) {
      expect((await fixture.request(`${base}/release?${query}`)).status).toBe(400);
      expect((await fixture.request(`${base}/download?${query}`, { headers })).status).toBe(400);
    }
    expect((await fixture.request(`${base}/release?version=0.9.0`)).status).toBe(404);
    await bucket().delete(record.objectKey);
    expect((await fixture.request(`${base}/download?version=0.4.0`, { headers })).status).toBe(404);
    await bucket().put('quicklogin/channels/canary.json', JSON.stringify({ ...record, objectKey: 'private-secret' }));
    expect((await fixture.request(`${base}/release`)).status).toBe(503);
    const spy = vi.spyOn(bucket(), 'get').mockRejectedValue(new Error('storage unreachable'));
    try { expect((await fixture.request(`${base}/release`)).status).toBe(503); } finally { spy.mockRestore(); }
    await bucket().delete('quicklogin/channels/canary.json');
    expect((await fixture.request(`${base}/release`)).status).toBe(503);
  });


  it('uses the legacy access flag in mode off and rejects mismatched package metadata', async () => {
    const fixture = await createApiFixture();
    const { headers, id } = await identity(fixture);
    const record = await seed();
    env.QUICKLOGIN_DEVICE_MODE = 'off';
    try {
      await env.DATABASE.prepare("INSERT INTO user_entitlement (user_id, subsystem, capability, value) VALUES (?, 'cqu', 'quicklogin_access', '1')").bind(id).run();
      expect((await fixture.request(`${base}/download`, { headers })).status).toBe(200);
      await bucket().put(record.objectKey, payload, { customMetadata: { sha256: 'f'.repeat(64) } });
      expect((await fixture.request(`${base}/download`, { headers })).status).toBe(503);
    } finally { env.QUICKLOGIN_DEVICE_MODE = 'on'; }
  });

  it('allows credentials only for website status queries and preserves device CORS', async () => {
    const fixture = await createApiFixture(); await seed();
    const { headers } = await identity(fixture);
    headers.set('origin', 'https://quicklogin.cqu.moe');
    const result = await fixture.request(base, { headers });
    expect(result.status).toBe(200);
    expect(result.headers.get('access-control-allow-origin')).toBe('https://quicklogin.cqu.moe');
    expect(result.headers.get('access-control-allow-credentials')).toBe('true');
    expect(result.headers.get('vary')).toContain('Origin');
    const preflight = await fixture.request(base, { method: 'OPTIONS', headers: { origin: 'https://quicklogin.cqu.moe', 'access-control-request-method': 'GET' } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-credentials')).toBe('true');
    const anonymous = await fixture.request(base, { headers: { origin: 'https://quicklogin.cqu.moe' } });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('access-control-allow-credentials')).toBe('true');
    headers.set('origin', 'https://evil.test');
    expect((await fixture.request(base, { headers })).headers.get('access-control-allow-credentials')).toBeNull();
  });
});
