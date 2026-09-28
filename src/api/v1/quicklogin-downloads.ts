import { Hono, type Context } from 'hono';
import { html } from 'hono/html';
import type { HonoEnv } from '../../types';
import { requireSession } from '../../middleware/authentication';
import { hasQuickloginAccess } from '../../services/quicklogin/eligibility';
import { PublicReleaseSchema, readRelease, ReleaseError, requestedVersion } from '../../services/quicklogin/releases';
import { problem } from '../problem';

function failure(c: Context<HonoEnv>, error: unknown, navigation = false) {
  const failure = error instanceof ReleaseError ? error
    : new ReleaseError(503, 'RELEASE_UNAVAILABLE', '下载服务暂不可用，请稍后重试。');
  if (!navigation || !c.req.header('Accept')?.includes('text/html')) {
    return problem(c, failure.code, failure.message, failure.status);
  }
  c.header('Cache-Control', 'private, no-store');
  c.header('Content-Security-Policy', "default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  c.header('X-Content-Type-Options', 'nosniff');
  return c.html(html`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QuickLogin 下载</title></head><body><main><h1>${failure.message}</h1><p><a href="https://quicklogin.cqu.moe/download/">返回下载页</a></p></main></body></html>`, failure.status);
}

export function createQuickloginDownloadsApi() {
  const api = new Hono<HonoEnv>();
  api.get('/release', async c => {
    c.header('Cache-Control', 'no-store');
    try {
      return c.json({ data: PublicReleaseSchema.parse(await readRelease(c.env.QUICKLOGIN_RELEASES, requestedVersion(c.req.url))) });
    } catch (error) { return failure(c, error); }
  });
  api.get('/download', async c => {
    c.header('Cache-Control', 'private, no-store');
    try {
      if (c.req.header('Authorization')) throw new ReleaseError(401, 'UNAUTHORIZED', '请登录后下载');
      const denied = await requireSession(c, async () => {});
      if (denied) throw new ReleaseError(401, 'UNAUTHORIZED', '请登录后下载');
      if (!(await hasQuickloginAccess(c.env, c.get('user').id))) {
        throw new ReleaseError(403, 'FORBIDDEN', '内测中，暂未开放');
      }
      const record = await readRelease(c.env.QUICKLOGIN_RELEASES, requestedVersion(c.req.url));
      const bucket = c.env.QUICKLOGIN_RELEASES!;
      const object = await bucket.get(record.objectKey);
      if (!object) throw new ReleaseError(404, 'PACKAGE_NOT_FOUND', '安装包暂不可用，请返回下载页重试。');
      if (object.size !== record.size || object.customMetadata?.sha256 !== record.sha256) {
        await object.body.cancel();
        throw new ReleaseError(503, 'INVALID_PACKAGE', '安装包校验信息不一致，请稍后重试。');
      }
      c.header('Content-Type', 'application/zip');
      c.header('Content-Disposition', `attachment; filename="${record.filename}"`);
      c.header('Content-Length', String(record.size));
      c.header('X-Content-Type-Options', 'nosniff');
      if (c.req.method === 'HEAD') {
        await object.body.cancel();
        return c.body(null);
      }
      return c.body(object.body);
    } catch (error) { return failure(c, error, true); }
  });
  return api;
}
