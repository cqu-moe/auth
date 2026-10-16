import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { assertAttemptCleanup } from './report.mjs';
import { assertOAuthAssertionFailure } from './control-evidence.mjs';
import { join } from 'node:path';
const root = `.e2e/oauth-negative-${Date.now()}`;
await mkdir(root, { recursive: true });
const records = [];
async function run(name, variant, args, extra = {}) {
  const dir = join(root, name);
  const child = spawn(process.execPath, ['e2e/oauth/run.mjs', ...args], {
    stdio: 'inherit', env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR,
      E2E_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1', WRANGLER_SEND_METRICS: 'false',
      AUTH_E2E_OUTPUT: dir, AUTH_E2E_MOBILE: variant === 'mobile' ? '1' : '',
      ...(process.env.AUTH_SCHOOL_DOCKER_SOCKET ? { AUTH_SCHOOL_DOCKER_SOCKET: process.env.AUTH_SCHOOL_DOCKER_SOCKET } : {}),
      ...(process.env.AUTH_E2E_EXPECT_COMMIT ? { AUTH_E2E_EXPECT_COMMIT: process.env.AUTH_E2E_EXPECT_COMMIT } : {}), ...extra },
  });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
  assert.equal(code, 1, `${name} unexpectedly succeeded`);
  const runtime = JSON.parse(await readFile(join(dir, variant, 'runtime.json'), 'utf8'));
  const report = JSON.parse(await readFile(join(dir, variant, 'report.json'), 'utf8'));
  assert.equal(runtime.result, 'failed');
  assert.equal(report.run.status, 'failed');
  assert.equal(report.run.exitCode, 1);
  records.push({ name, variant, innerExit: code, cleanup: runtime.cleanup, report: join(dir, variant, 'report.json') });
  return { dir: join(dir, variant), runtime, report };
}
async function files(dir) {
  return (await Promise.all((await readdir(dir, { withFileTypes: true })).map(item =>
    item.isDirectory() ? files(join(dir, item.name)) : [join(dir, item.name)]))).flat();
}
for (const variant of ['desktop', 'mobile']) {
  const result = await run(`assertion-${variant}`, variant, ['--grep', '^OAuth S256'], { AUTH_OAUTH_BREAK_ASSERTION: '1' });
  assert.equal(result.report.run.summary.failed, 1);
  assert.equal(result.report.run.summary.executed, 1);
  assert.equal(result.runtime.cleanup, 'passed');
  assert.equal(result.runtime.sourceUnchanged, true);
  const group = result.runtime.groups[0];
  assert.equal(group.resources.directoryRemoved, true);
  assert.equal(group.resources.platform.containerObjectsRemoved, true);
  assert.equal(group.resources.platform.proxyObjectsRemoved, true);
  assert.equal(group.proxyReadback.absent, true);
  assert.equal(group.resources.platform.fixtureImageRemoved, true);
  assert.equal(group.browser.profileRemoved, true);
  const native = JSON.parse(await readFile(join(result.dir, group.report), 'utf8'));
  assertOAuthAssertionFailure(group, native, variant);
  const paths = await files(result.dir);
  assert.ok(paths.some(path => path.endsWith('.png')), 'Intentional pre-secret failure did not retain screenshot');
  const trace = (await Promise.all(paths.filter(path => path.endsWith('trace.md')).map(path => readFile(path, 'utf8')))).join('\n');
  assert.match(trace, /AUTH04 deliberate failure/);
  assert.match(trace, /ASSERTION_FAILED/);
}
const cleanup = await run('engine-cleanup', 'desktop', [], { AUTH_OAUTH_CLEANUP_CONTROL: '1' });
const cleanupGroup = cleanup.runtime.groups[0];
assert.equal(cleanupGroup.runnerExitCode, 0, 'Native e2e no longer reproduces the passed/cleanup-failed bug; review this control');
assert.equal(cleanupGroup.summary.passed, 1);
assert.equal(cleanup.runtime.cleanup, 'passed');
assert.equal(cleanupGroup.resources.platform.proxyObjectsRemoved, true);
assert.equal(cleanupGroup.proxyReadback.absent, true);
assert.equal(cleanupGroup.browser.profileRemoved, true);
assert.match(cleanupGroup.errors[0].message, /selected attempt cleanup failed/);
const native = JSON.parse(await readFile(join(cleanup.dir, cleanupGroup.report), 'utf8'));
assert.equal(native.run.status, 'passed');
const attempt = native.run.results.find(result => result.kind === 'test' && result.selected).attempts[0];
assert.equal(attempt.cleanup, 'failed');
assert.ok(attempt.secondaryErrors.some(error => error.phase === 'cleanup' && /AUTH04 deliberate engine cleanup failure/.test(error.message)));
// The secondary-error branch must reject even when cleanup is mislabeled complete.
attempt.cleanup = 'complete';
assert.throws(() => assertAttemptCleanup(native), /selected attempt cleanup failed/);
const empty = await run('zero', 'desktop', ['--grep', '^AUTH04_ZERO_SELECTION$']);
assert.equal(empty.runtime.cleanup, 'not-started');
assert.deepEqual(empty.runtime.groups, []);
assert.match(empty.runtime.failure.message, /selected no tests|NO_TESTS/);
const pin = await run('pin', 'desktop', ['--grep', '^OAuth S256'], { AUTH_E2E_EXPECT_COMMIT: 'AUTH04_WRONG_COMMIT' });
assert.equal(pin.runtime.cleanup, 'not-started');
assert.equal(pin.runtime.groups[0].stage, 'startup');
assert.match(pin.runtime.groups[0].errors[0].message, /pinned dependency/);
await writeFile(join(root, 'controls.json'), JSON.stringify({ result: 'passed', records }, null, 2) + '\n');
console.log(`OAuth negative controls passed; evidence: ${root}`);
