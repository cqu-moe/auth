import { Miniflare, Log, LogLevel } from 'miniflare';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

// Node-side lifecycle API. Never import this from production or expose seed controls on Auth.
export async function startAuth({ expectedCommit, platform } = {}) {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (expectedCommit && expectedCommit !== commit) throw new Error('Auth commit does not match the pinned dependency');
  const dir = await mkdtemp(resolve('.auth-e2e-'));
  const mails = new Map();
  const unexpected = [];
  const artifactSecrets = [];
  let mf;
  let db;
  let origin;
  const control = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/mail') {
      res.setHeader('content-type', 'application/json');
      const mail = mails.get(url.searchParams.get('email'));
      res.end(JSON.stringify({ otp: mail?.otp ?? null, resetUrl: mail?.resetUrl ?? null }));
    } else if (req.method === 'POST' && url.pathname === '/artifact-secret') {
      let body = ''; for await (const chunk of req) body += chunk;
      const { values } = JSON.parse(body);
      if (!Array.isArray(values) || values.length > 20 || values.some(value => typeof value !== 'string' || !value || value.length > 10000)) {
        res.writeHead(400).end();
      } else {
        artifactSecrets.push(...values);
        res.writeHead(204).end();
      }
    } else if (req.method === 'POST' && url.pathname === '/real-session') {
      let body = ''; for await (const chunk of req) body += chunk;
      const { email } = JSON.parse(body);
      if (!/^[^@\s]+@example\.test$/.test(email ?? '')) { res.writeHead(400).end(); return; }
      const login = await fetch(`${origin}/api/v1/auth/sign-in/email`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ email, password: 'Synthetic-only-123!' }),
      });
      if (!login.ok) { res.writeHead(502).end(); return; }
      const cookies = login.headers.getSetCookie().map(cookie => {
        const [name, value] = cookie.split(';')[0].split(/=(.*)/s);
        return { name, value: value ?? '' };
      });
      artifactSecrets.push(...cookies.map(cookie => cookie.value).filter(Boolean));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ cookies }));
    } else if (req.method === 'POST' && url.pathname === '/invitation') {
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const bytes = new Uint8Array(8);
      crypto.getRandomValues(bytes);
      const code = Array.from(bytes, byte => alphabet[byte % alphabet.length]).join('');
      await db.prepare('INSERT INTO registration_invitation(code,created_by,expires_at) VALUES (?,?,?)')
        .bind(code, 'synthetic-fixture', new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()).run();
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ code }));
    } else if (req.method === 'POST' && url.pathname === '/promote-admin') {
      let body = ''; for await (const chunk of req) body += chunk;
      const { email } = JSON.parse(body);
      if (!/^[^@\s]+@example\.test$/.test(email ?? '')) { res.writeHead(400).end(); return; }
      const result = await db.prepare("UPDATE \"user\" SET role='superAdmin' WHERE email=?").bind(email).run();
      if (!result.meta.changes) res.writeHead(404).end(); else res.writeHead(204).end();
    } else if (req.method === 'POST' && url.pathname === '/registration') {
      let body = ''; for await (const chunk of req) body += chunk;
      const { required } = JSON.parse(body);
      if (typeof required !== 'boolean') { res.writeHead(400).end(); return; }
      await db.prepare("UPDATE entitlement_config SET value=? WHERE key='invitation_required'").bind(required ? '1' : '0').run();
      res.writeHead(204).end();
    } else if (req.method === 'POST' && url.pathname === '/expire') {
      let body = ''; for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      if (request?.type === 'reset-token' && /^[A-Za-z0-9_-]+$/.test(request.token ?? '')) {
        const result = await db.prepare("UPDATE verification SET \"expiresAt\"='2000-01-01T00:00:00.000Z' WHERE identifier=?")
          .bind(`reset-password:${request.token}`).run();
        if (!result.meta.changes) res.writeHead(404).end(); else res.writeHead(204).end();
      } else if (request?.type === 'recent-auth' && /^[^@\s]+@example\.test$/.test(request.email ?? '') &&
          ['password', 'email', 'mfa', 'admin', 'strong'].includes(request.purpose)) {
        const session = await db.prepare('SELECT s.id FROM session s JOIN "user" u ON u.id=s."userId" WHERE u.email=? ORDER BY s."createdAt" DESC LIMIT 1')
          .bind(request.email).first();
        if (!session) res.writeHead(404).end();
        else {
          await db.prepare("UPDATE verification SET \"expiresAt\"='2000-01-01T00:00:00.000Z' WHERE identifier=?")
            .bind(`security-proof:${session.id}:${request.purpose}`).run();
          res.writeHead(204).end();
        }
      } else res.writeHead(400).end();
    } else { res.writeHead(404).end(); }
  });
  try {
    execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--dry-run', '--config', platform?.buildConfig ?? 'e2e/wrangler.jsonc', '--outdir', dir], {
      stdio: 'pipe', env: { PATH: process.env.PATH, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(dir, 'build.log') },
    });
    // Reserve an OS-selected port without inheriting any developer Wrangler config/secrets.
    const portServer = createServer();
    await new Promise(r => portServer.listen(0, '127.0.0.1', r));
    const port = portServer.address().port;
    await new Promise(r => portServer.close(r));
    // WebAuthn RP IDs are registrable domains; an IP-address origin makes Chrome
    // reject even a valid virtual-authenticator ceremony.
    origin = `http://localhost:${port}`;
    const bundle = join(dir, platform?.bundleName ?? 'index.js');
    const options = { name: 'auth-e2e', host: '127.0.0.1', port, modules: [{ type: 'ESModule', path: bundle, contents: await readFile(bundle, 'utf8') }],
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
          const html = typeof mail.html === 'string' ? mail.html : '';
          const otp = html.match(/letter-spacing:6px">(\d{6})</)?.[1];
          const encodedHref = html.match(/<a href="([^"]+)"/)?.[1];
          const resetUrl = encodedHref?.replace(/&amp;/g, '&');
          if (!otp && !resetUrl) throw new Error('Unexpected external email payload');
          if (resetUrl && new URL(resetUrl).origin !== origin) throw new Error('Non-application reset link denied');
          for (const recipient of [].concat(mail.to)) {
            if (!recipient.endsWith('@example.test')) throw new Error('Non-synthetic email denied');
            mails.set(recipient, { ...(otp ? { otp } : {}), ...(resetUrl ? { resetUrl } : {}) });
          }
          return Response.json({ id: crypto.randomUUID() });
        }
        unexpected.push(url.origin);
        return new Response('Unexpected external request denied', { status: 502 });
      },
    };
    mf = new Miniflare(platform ? platform.configure(options, dir) : options);
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
    const support = await platform?.ready({mf, db, origin});
    return { origin, controlOrigin: `http://127.0.0.1:${control.address().port}`, db, support,
      commit,
      async checkArtifacts(outputDir) {
        const sensitive = ['Synthetic-only-123!', 'Synthetic-reset-only-456!', 'Synthetic-change-only-456!',
          ...mails.values().flatMap(mail => [mail.otp, mail.resetUrl].filter(Boolean)), ...artifactSecrets];
        async function inspect(directory) {
          for (const entry of await readdir(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) await inspect(path);
            else if (/\.(json|txt|md|log)$/.test(entry.name)) {
              const text = await readFile(path, 'utf8');
              if (sensitive.some(value => text.includes(value))) {
                throw new Error('Sensitive synthetic value found in E2E text artifacts');
              }
            }
          }
        }
        await inspect(outputDir);
      },
      async close() {
        const before = await Promise.allSettled([platform?.beforeClose()]);
        const results = await Promise.allSettled([
          new Promise((r,j) => control.close(e => e ? j(e) : r())), mf.dispose(),
        ]);
        const cleanup = await Promise.allSettled([platform?.close(), rm(dir, {recursive:true,force:true})]);
        const errors = [...before,...results,...cleanup].flatMap(result => result.status === 'rejected' ? [result.reason] : []);
        if (unexpected.length) errors.push(new Error(`Unexpected Worker egress denied (${unexpected.length} requests)`));
        if (errors.length) throw new AggregateError(errors, 'Auth runtime cleanup failed');
        return {directoryRemoved:!(await readdir('.')).some(name=>resolve(name)===dir),
          platform:cleanup[0].status==='fulfilled'?cleanup[0].value:undefined};
      } };
  } catch (error) {
    const before = await Promise.allSettled([platform?.beforeClose()]);
    const disposed = await Promise.allSettled([
      mf?.dispose(),
      control.listening ? new Promise((r,j)=>control.close(e=>e?j(e):r())) : undefined,
    ]);
    const cleaned = await Promise.allSettled([platform?.close(), rm(dir, {recursive:true,force:true})]);
    const failures = [...before,...disposed,...cleaned].filter(result=>result.status==='rejected');
    if (failures.length) throw new AggregateError([error,...failures.map(result=>result.reason)], 'Auth startup and cleanup failed');
    throw error;
  }
}
