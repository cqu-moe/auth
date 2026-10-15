import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
if (args.length && (args.length !== 1 || args[0] !== '--self-check')) throw new Error('Only --self-check is supported');
const selfCheck = args.length === 1;
const engines = process.env.AUTH_E2E_BROWSER ? [process.env.AUTH_E2E_BROWSER] : ['firefox', 'webkit'];
if (engines.some(name => !['firefox', 'webkit'].includes(name))) throw new Error('Supplement requires firefox or webkit');
const output = process.env.AUTH_E2E_OUTPUT || `.e2e/cross-browser-${Date.now()}`;
if (!resolve(output).startsWith(resolve('.e2e') + '/')) throw new Error('Output must be inside .e2e');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (process.env.AUTH_E2E_EXPECT_COMMIT) {
  assert.equal(commit, process.env.AUTH_E2E_EXPECT_COMMIT, 'Supplement commit pin mismatch');
  assert.equal(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(), '', 'Pinned supplement requires a clean checkout');
}
await mkdir(output, { recursive: true });
const records = [];
async function run(browser, name, filters = [], extra = {}) {
  const dir = join(output, browser, name);
  const child = spawn(process.execPath, ['e2e/run.mjs', ...filters], {
    stdio: 'inherit', env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, CI: process.env.CI,
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
      AUTH_E2E_EXPECT_COMMIT: process.env.AUTH_E2E_EXPECT_COMMIT,
      AUTH_E2E_BROWSER: browser, AUTH_E2E_OUTPUT: dir,
      DO_NOT_TRACK: '1', E2E_TELEMETRY_DISABLED: '1', WRANGLER_SEND_METRICS: 'false', ...extra },
  });
  const exit = await new Promise((resolveChild, reject) => { child.once('error', reject); child.once('close', code => resolveChild(code ?? 1)); });
  const report = JSON.parse(await readFile(join(dir, 'desktop/report.json'), 'utf8'));
  const runtime = JSON.parse(await readFile(join(dir, 'desktop/runtime.json'), 'utf8'));
  assert.equal(report.run.browser, browser);
  assert.equal(report.run.sourceUnchanged, true);
  assert.equal(runtime.sourceUnchanged, true);
  records.push({ browser, name, exit, report: join(dir, 'desktop/report.json'), cleanup: runtime.cleanup });
  return { exit, report, runtime, dir: join(dir, 'desktop') };
}
async function files(dir) {
  return (await Promise.all((await readdir(dir, { withFileTypes: true })).map(item =>
    item.isDirectory() ? files(join(dir, item.name)) : [join(dir, item.name)]))).flat();
}
try {
  for (const browser of engines) {
    if (!selfCheck) {
      const result = await run(browser, 'journeys');
      assert.equal(result.exit, 0);
      assert.equal(result.report.run.status, 'passed');
      assert.equal(result.runtime.cleanup, 'passed');
      assert.ok(result.report.run.summary.executed > 0);
      assert.equal(result.report.run.summary.passed, result.report.run.summary.selected);
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
  }
  if (selfCheck) {
    const empty = await run(engines[0], 'zero', ['--grep', '^CROSS_BROWSER_ZERO_SELECTION$']);
    assert.equal(empty.exit, 1);
    assert.equal(empty.report.run.groups.length, 0);
    assert.match(empty.report.run.errors[0].message, /NO_TESTS|selected no tests/);
  }
} finally {
  await writeFile(join(output, 'supplement.json'), JSON.stringify({ commit, selfCheck, records }, null, 2) + '\n');
}
