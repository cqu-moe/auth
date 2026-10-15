import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sourceFingerprint } from './school/source.mjs';

const args = process.argv.slice(2);
if (args.length && (args.length !== 1 || args[0] !== '--self-check')) throw new Error('Only --self-check is supported');
const selfCheck = args.length === 1;
const engines = process.env.AUTH_E2E_BROWSER ? [process.env.AUTH_E2E_BROWSER] : ['firefox', 'webkit'];
if (engines.some(name => !['firefox', 'webkit'].includes(name))) throw new Error('Supplement requires firefox or webkit');
const output = process.env.AUTH_E2E_OUTPUT || `.e2e/cross-browser-${Date.now()}`;
if (!resolve(output).startsWith(resolve('.e2e') + '/')) throw new Error('Output must be inside .e2e');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const sourceHash = sourceFingerprint();
if (process.env.AUTH_E2E_EXPECT_COMMIT) {
  assert.equal(commit, process.env.AUTH_E2E_EXPECT_COMMIT, 'Supplement commit pin mismatch');
  assert.equal(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(), '', 'Pinned supplement requires a clean checkout');
}

await mkdir(output, { recursive: true });
const records = [];
async function run(browser, name, filters = [], extra = {}, script = 'e2e/run.mjs') {
  assert.equal(sourceFingerprint(), sourceHash, 'Source changed before dispatch');
  const dir = join(output, browser, name);
  const child = spawn(process.execPath, [script, ...filters], {
    stdio: 'inherit', env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, CI: process.env.CI,
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
      AUTH_E2E_EXPECT_COMMIT: process.env.AUTH_E2E_EXPECT_COMMIT,
      AUTH_E2E_MOBILE: process.env.AUTH_E2E_MOBILE,
      ...(process.env.AUTH_SCHOOL_DOCKER_SOCKET ? { AUTH_SCHOOL_DOCKER_SOCKET: process.env.AUTH_SCHOOL_DOCKER_SOCKET } : {}),
      AUTH_E2E_BROWSER: browser, AUTH_E2E_OUTPUT: dir,
      DO_NOT_TRACK: '1', E2E_TELEMETRY_DISABLED: '1', WRANGLER_SEND_METRICS: 'false', ...extra },
  });
  const exit = await new Promise((resolveChild, reject) => { child.once('error', reject); child.once('close', code => resolveChild(code ?? 1)); });
  const record = { browser, name, script, exit, dir, views: [] };
  records.push(record);
  const variants = process.env.AUTH_E2E_MOBILE ? ['mobile'] : selfCheck ? ['desktop'] : ['desktop', 'mobile'];
  let first;
  for (const variant of variants) {
    const view = join(dir, variant);
    let report, runtime;
    try {
      report = JSON.parse(await readFile(join(view, 'report.json'), 'utf8'));
      runtime = JSON.parse(await readFile(join(view, 'runtime.json'), 'utf8'));
    } catch (error) {
      record.views.push({ variant, evidenceUnavailable: true, error: error.message });
      if (exit) continue; // Keep the failed child/report; never replace it with a later missing viewport.
      throw error;
    }
    assert.equal(runtime.browser, browser);
    assert.equal(runtime.sourceUnchanged, true);
    assert.equal(runtime.sourceHash, sourceHash);
    record.views.push({ variant, report: join(view, 'report.json'), cleanup: runtime.cleanup, summary: report.run.summary });
    first ??= { exit, report, runtime, dir: view };
  }
  assert.equal(sourceFingerprint(), sourceHash, 'Source changed during execution');
  return { ...first, exit, views: record.views };
}
async function files(dir) {
  return (await Promise.all((await readdir(dir, { withFileTypes: true })).map(item =>
    item.isDirectory() ? files(join(dir, item.name)) : [join(dir, item.name)]))).flat();
}
try {
  for (const browser of engines) {
    if (!selfCheck) {
      for (const [name, script, expected] of [
        ['account', 'e2e/run.mjs', 15], ['oauth', 'e2e/oauth/run.mjs', 2], ['school', 'e2e/school/run.mjs', 9],
      ]) {
        const result = await run(browser, name, [], {}, script);
        assert.equal(result.exit, 0);
        for (const view of result.views) {
          assert.equal(view.cleanup, 'passed');
          for (const key of ['selected', 'executed', 'passed']) assert.equal(view.summary[key], expected);
          for (const key of ['failed', 'skipped', 'interrupted', 'flaky']) assert.equal(view.summary[key], 0);
        }
      }
      continue;
    }
    const assertion = await run(browser, 'assertion', ['--grep', '^register, verify'], { AUTH_E2E_BREAK_ASSERTION: '1' });
    assert.equal(assertion.exit, 1);
    assert.equal(assertion.report.run.summary.failed, 1);
    assert.equal(assertion.report.run.summary.executed, 1);
    assert.equal(assertion.runtime.cleanup, 'passed');
    const group = assertion.report.run.groups[0];
    assert.equal(group.resources.directoryRemoved, true);
    assert.ok(Object.values(group.browserSafety).every(Boolean));
    const native = JSON.parse(await readFile(join(assertion.dir, group.report), 'utf8'));
    const selected = native.run.results.filter(result => result.kind === 'test' && result.selected);
    assert.equal(selected.length, 1);
    assert.equal(selected[0].attempts[0].error.code, 'ASSERTION_FAILED');
    assert.match(JSON.stringify(selected[0].attempts[0].error), /故意错误的注册成功页面/);
    assert.ok((await files(assertion.dir)).some(path => path.endsWith('.png')), 'Safe pre-secret screenshot missing');
    const cleanup = await run(browser, 'engine-cleanup', [], { AUTH_E2E_CLEANUP_CONTROL: '1' });
    assert.equal(cleanup.exit, 1);
    assert.equal(cleanup.runtime.cleanup, 'passed');
    const cleanupGroup = cleanup.report.run.groups[0];
    assert.equal(cleanupGroup.runnerExitCode, 0);
    assert.equal(cleanupGroup.resources.directoryRemoved, true);
    assert.ok(Object.values(cleanupGroup.browserSafety).every(Boolean));
    const cleanupNative = JSON.parse(await readFile(join(cleanup.dir, cleanupGroup.report), 'utf8'));
    assert.equal(cleanupNative.run.status, 'passed');
    const attempt = cleanupNative.run.results.find(result => result.kind === 'test' && result.selected).attempts[0];
    assert.equal(attempt.cleanup, 'failed');
    assert.ok(attempt.secondaryErrors.some(error => error.phase === 'cleanup' && error.message.includes('AUTH cross-browser deliberate engine cleanup failure')));
    assert.ok(cleanup.report.run.errors.some(error => error.message.includes('Browser provider cleanup failed')));
    const empty = await run(browser, 'zero', ['--grep', '^CROSS_BROWSER_ZERO_SELECTION$']);
    assert.equal(empty.exit, 1);
    assert.equal(empty.report.run.groups.length, 0);
    assert.equal(empty.report.run.summary.selected, 0);
    assert.equal(empty.report.run.summary.executed, 0);
    assert.equal(empty.report.run.errors.length, 1);
    assert.match(empty.report.run.errors[0].message,
      /^E2E discovery exited 2:\nNO_TESTS: 17 tests were collected but none is runnable: 17 have titles matching none of \/\^CROSS_BROWSER_ZERO_SELECTION\$\//);
  }
} finally {
  await writeFile(join(output, 'supplement.json'), JSON.stringify({ commit, sourceHash,
    sourceUnchanged: sourceFingerprint() === sourceHash, selfCheck,
    capabilityExceptions: ['virtual WebAuthn', 'manual recovery invalidates actual old factors'],
    capabilityReason: 'Both original implementations require Chromium-only CDP virtual authenticators; manual FF/WK hardware-key acceptance remains unverified.',
    records }, null, 2) + '\n');
}
