import { Miniflare, Log, LogLevel } from 'miniflare';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

// Node-side lifecycle API. Never import this from production or expose seed controls on Auth.
export async function startAuth({ expectedCommit } = {}) {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (expectedCommit && expectedCommit !== commit) throw new Error('Auth commit does not match the pinned dependency');
  const dir = await mkdtemp(resolve('.auth-e2e-'));
  const mails = new Map();
  const unexpected = [];
  let mf;
  let db;
  const control = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/mail') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ otp: mails.get(url.searchParams.get('email')) ?? null }));
    } else if (req.method === 'POST' && url.pathname === '/registration') {
      let body = ''; for await (const chunk of req) body += chunk;
      const { required } = JSON.parse(body);
      if (typeof required !== 'boolean') { res.writeHead(400).end(); return; }
      await db.prepare("UPDATE entitlement_config SET value=? WHERE key='invitation_required'").bind(required ? '1' : '0').run();
      res.writeHead(204).end();
    } else { res.writeHead(404).end(); }
  });
  try {
    execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--dry-run', '--config', 'e2e/wrangler.jsonc', '--outdir', dir], {
      stdio: 'pipe', env: { PATH: process.env.PATH, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(dir, 'build.log') },
    });
    // Reserve an OS-selected port without inheriting any developer Wrangler config/secrets.
    const portServer = createServer();
    await new Promise(r => portServer.listen(0, '127.0.0.1', r));
    const port = portServer.address().port;
    await new Promise(r => portServer.close(r));
    const origin = `http://127.0.0.1:${port}`;
    mf = new Miniflare({ name: 'auth-e2e', host: '127.0.0.1', port, modules: [{ type: 'ESModule', path: join(dir, 'index.js'), contents: await readFile(join(dir, 'index.js'), 'utf8') }],
       compatibilityDate: '2026-05-01', compatibilityFlags: ['nodejs_compat'],
      log: new Log(LogLevel.ERROR),
      d1Databases: { DATABASE: 'auth-e2e' }, d1Persist: join(dir, 'd1'),
      durableObjects: { CQU_SESSION: 'CquSessionDO', CQU_LOGIN: { className: 'CquLoginContainer', useSQLite: true },
        CQU_QUICKLOGIN_ACCOUNT: { className: 'CquQuickloginAccountDO', useSQLite: true },
        CQU_QUICKLOGIN_DEVICE: { className: 'CquQuickloginDeviceDO', useSQLite: true } },
      bindings: { BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: 'synthetic-auth-e2e-secret-never-use-outside-tests',
        ENCRYPTION_KEY: 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=',
        RESEND_API_KEY: 're_synthetic', ENVIRONMENT: 'development', BIND_EMAIL_DOMAIN: 'example.test',
        QUICKLOGIN_DEVICE_MODE: 'on', QUICKLOGIN_CLIENT_ID: 'quicklogin-test-client' },
      assets: { workerName: 'auth-e2e', directory: resolve('frontend/dist'), binding: 'ASSETS',
        routerConfig: { invoke_user_worker_ahead_of_assets: true, has_user_worker: true },
        assetConfig: { not_found_handling: 'single-page-application' } },
      outboundService: async request => {
        const url = new URL(request.url);
        if (url.origin === 'https://api.resend.com' && url.pathname === '/emails' && request.method === 'POST') {
          const mail = await request.json();
          const otp = mail.html?.match(/letter-spacing:6px">(\d{6})</)?.[1];
          if (!otp) throw new Error('Unexpected external email payload');
          for (const recipient of [].concat(mail.to)) {
            if (!recipient.endsWith('@example.test')) throw new Error('Non-synthetic email denied');
            mails.set(recipient, otp);
          }
          return Response.json({ id: crypto.randomUUID() });
        }
        unexpected.push(url.origin);
        return new Response('Unexpected external request denied', { status: 502 });
      },
    });
    await mf.ready;
    db = await mf.getD1Database('DATABASE');
    for (const file of (await readdir('drizzle/migrations')).filter(f => f.endsWith('.sql')).sort()) {
      const sql = await readFile(join('drizzle/migrations', file), 'utf8');
      // D1 exec only accepts one SQL statement per line; use workerd's real prepared statements.
      const statements = sql.replace(/^\s*--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean);
      for (const statement of statements) await db.prepare(statement).run();
    }
    await db.prepare("INSERT INTO entitlement_config(key,value) VALUES ('invitation_required','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
    for (const [code, expires] of [['ABCDEFGH','2099-01-01T00:00:00.000Z'], ['JKLMNPQR','2000-01-01T00:00:00.000Z']]) {
      await db.prepare('INSERT INTO registration_invitation(code,created_by,expires_at) VALUES (?,?,?)').bind(code,'synthetic-fixture',expires).run();
    }
    await db.prepare("INSERT INTO registration_invitation(code,created_by,expires_at,used_at) VALUES ('STUVWXYZ','synthetic-fixture','2099-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z')").run();
    await new Promise(r => control.listen(0, '127.0.0.1', r));
    return { origin, controlOrigin: `http://127.0.0.1:${control.address().port}`, db,
      commit,
      async checkArtifacts(outputDir) {
        const sensitive = ['Synthetic-only-123!', ...mails.values()];
        async function inspect(directory) {
          for (const entry of await readdir(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) await inspect(path);
            else if (/\.(json|txt|md|log)$/.test(entry.name)) {
              const text = await readFile(path, 'utf8');
              if (sensitive.some(value => text.includes(value))) throw new Error('Sensitive synthetic value found in E2E text artifacts');
            }
          }
        }
        await inspect(outputDir);
      },
      async close() {
        const results = await Promise.allSettled([
          new Promise((r,j) => control.close(e => e ? j(e) : r())), mf.dispose(),
        ]);
        await rm(dir, { recursive: true });
        const errors = results.filter(result => result.status === 'rejected');
        if (errors.length) throw new Error('Auth runtime cleanup failed');
        if (unexpected.length) throw new Error(`Unexpected Worker egress denied (${unexpected.length} requests)`);
      } };
  } catch (error) {
    control.close();
    if (mf) await mf.dispose();
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
