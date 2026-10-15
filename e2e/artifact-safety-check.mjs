import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { sourceFingerprint } from './school/source.mjs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const self = fileURLToPath(import.meta.url);
if (process.env.AUTH_ARTIFACT_STDIO_CHILD === '1') {
  // This import executes inside the actual framework CLI process, before its
  // selected native journey. Exercise both real child output pipes.
  process.stdout.write(process.env.AUTH_ARTIFACT_CONTROL_MARKER + '\n');
  process.stderr.write(process.env.AUTH_ARTIFACT_CONTROL_MARKER + '\n');
} else if (process.env.AUTH_ARTIFACT_CONTROL_LOADER === '1') {
  // Fault injection is local to the real runner's final metadata write. There is
  // no application/runtime success seam, synthetic report, or substitute scan.
  registerHooks({ load(url, context, next) {
    const loaded = next(url, context);
    const runner = url === pathToFileURL(resolve('e2e/run.mjs')).href;
    const runtime = url === pathToFileURL(resolve('e2e/runtime.mjs')).href;
    const baseline = process.env.AUTH_ARTIFACT_BASELINE;
    if (!runner && !(runtime && baseline)) return loaded;
    let source = baseline
      ? requireSource(join(baseline, runner ? 'run.mjs' : 'runtime.mjs'))
      : Buffer.from(loaded.source).toString();
    if (runner) {
      const argv = "['node_modules/e2e/dist/cli/bin.js', 'run',";
      assert.equal(source.split(argv).length, 2, 'Actual framework child boundary not found');
      source = source.replace(argv, `['--import', ${JSON.stringify(self)}, 'node_modules/e2e/dist/cli/bin.js', 'run',`);
      const childOutput = '      AUTH_E2E_OUTPUT: dir,';
      assert.equal(source.split(childOutput).length, 2, 'Actual child environment boundary not found');
      source = source.replace(childOutput, `${childOutput}
      AUTH_ARTIFACT_STDIO_CHILD: '1', AUTH_ARTIFACT_CONTROL_MARKER: process.env.AUTH_ARTIFACT_CONTROL_MARKER,`);
      const start = /runtime = await startAuth\([^\n]+\);/;
      assert.equal((source.match(new RegExp(start, 'g')) ?? []).length, 1, 'Artifact registration boundary not found');
      source = source.replace(start, match => `${match}
        const registered = await fetch(runtime.controlOrigin + '/artifact-secret', {
          method: 'POST', headers: {'content-type':'application/json'},
          body: JSON.stringify({values:[process.env.AUTH_ARTIFACT_CONTROL_MARKER]})});
        if (registered.status !== 204) throw new Error('Artifact fault registration failed');`);
      const terminal = '  if (process.exitCode) break;';
      assert.equal(source.split(terminal).length, 2, 'Final runtime write boundary not found');
      source = source.replace(terminal, `  const latePath = join(variantDir, 'runtime.json');
  const late = JSON.parse(await readFile(latePath, 'utf8'));
  late.artifactControl = process.env.AUTH_ARTIFACT_CONTROL_MARKER;
  await writeJson(latePath, late);
${terminal}`);
      if (baseline) {
        const guard = "if (!resolve(output).startsWith(resolve('.e2e') + '/')) throw new Error('E2E output must be a child of .e2e');";
        assert.equal(source.split(guard).length, 2, 'Baseline output admission boundary not found');
        // RED's emulated upload root is private, outside the actual upload glob.
        source = source.replace(guard, "if (output !== process.env.AUTH_ARTIFACT_PRIVATE_OUTPUT) throw new Error('Private RED output mismatch');");
        const scan = '        await runtime.checkArtifacts(dir);';
        assert.equal(source.split(scan).length, 2, 'Baseline scanner boundary not found');
        source = source.replace(scan, `        try {
${scan}
          await writeFile(process.env.AUTH_ARTIFACT_SCANNER_WITNESS, JSON.stringify({state:'returned'}));
        } catch(error) {
          await writeFile(process.env.AUTH_ARTIFACT_SCANNER_WITNESS, JSON.stringify({state:'rejected',name:error.name,message:error.message}));
          throw error;
        }`);
      }
    }
    return { ...loaded, source };
  } });
} else {
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--baseline-dir'), 'Only --baseline-dir is supported');
  const baseline = args.length ? resolve(args[1]) : undefined;
  if (baseline) assert.ok(baseline.startsWith(resolve('.auth-e2e-artifact-baseline-')), 'Baseline must remain private');
  process.umask(0o077);
  const privateRoot = await mkdtemp(resolve('.auth-e2e-artifact-control-'));
  const marker = `synthetic-artifact-${randomUUID()}`;
  const sourceHash = sourceFingerprint();
  const publicOutput = `.e2e/artifact-control-${randomUUID()}`;
  const output = baseline ? join(privateRoot, 'emulated-upload') : publicOutput;
  const child = spawn(process.execPath, ['--import', self, 'e2e/run.mjs', '--grep', '^register, verify'], {
    stdio: ['ignore', 'pipe', 'pipe'], env: {
      PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, CI: process.env.CI,
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
      AUTH_E2E_BROWSER: process.env.AUTH_E2E_BROWSER || 'chromium',
      AUTH_E2E_OUTPUT: output, AUTH_E2E_BREAK_ASSERTION: '1',
      AUTH_ARTIFACT_CONTROL_LOADER: '1', AUTH_ARTIFACT_CONTROL_MARKER: marker,
      ...(baseline ? { AUTH_ARTIFACT_BASELINE: baseline, AUTH_ARTIFACT_PRIVATE_OUTPUT: output, AUTH_ARTIFACT_SCANNER_WITNESS: join(privateRoot, 'scanner-witness.txt') } : {}),
      DO_NOT_TRACK: '1', E2E_TELEMETRY_DISABLED: '1', WRANGLER_SEND_METRICS: 'false',
    },
  });
  let log = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk; });
  const exit = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
  await writeFile(join(privateRoot, 'runner.log'), log);
  assert.equal(exit, 1, 'Actual intended assertion must fail');
  async function containsMarker(dir) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, item.name);
      if (item.isDirectory() ? await containsMarker(path) : (await readFile(path)).includes(Buffer.from(marker))) return true;
    }
    return false;
  }
  const leaked = await containsMarker(output);
  const consoleLeaked = log.includes(marker);
  let raw = output;
  if (!baseline) {
    assert.equal(leaked, false, 'Unsafe bytes reached public artifacts');
    assert.equal(consoleLeaked, false, 'Unsafe child output reached public console');
    const receipt = JSON.parse(await readFile(join(output, 'artifact-safety.json'), 'utf8'));
    assert.equal(receipt.publication, 'quarantined');
    assert.equal(receipt.failedStage, 'scan');
    assert.equal(receipt.primary, 'failed');
    assert.equal(receipt.cleanup, 'passed');
    assert.ok(receipt.runtimeScanners > 0);
    assert.deepEqual(await readdir(output), ['artifact-safety.json']);
    assert.match(receipt.quarantineDirectory, /^\.auth-e2e-artifacts-[A-Za-z0-9]+$/);
    raw = receipt.quarantineDirectory;
    assert.equal(await containsMarker(raw), true, 'Quarantine must retain actual failure evidence');
  } else {
    assert.equal(leaked, true, 'Baseline did not reproduce the publication defect');
    assert.equal(consoleLeaked, true, 'Baseline did not reproduce the stdout/stderr bypass');
    // The old scanner rejects the logged stdout marker, but the same bytes
    // already escaped through console. Rejection must not be mistaken for
    // having protected the actual publication boundary.
    const scan = JSON.parse(await readFile(join(privateRoot, 'scanner-witness.txt'), 'utf8'));
    assert.equal(scan.state, 'rejected');
    assert.match(scan.message, /sensitive/i);
  }
  const report = JSON.parse(await readFile(join(raw, 'desktop/report.json'), 'utf8'));
  assert.equal(report.run.summary.executed, 1);
  assert.equal(report.run.summary.failed, 1);
  assert.equal(report.run.groups.length, 1);
  const native = JSON.parse(await readFile(join(raw, 'desktop', report.run.groups[0].report), 'utf8'));
  const selected = native.run.results.filter(row => row.kind === 'test' && row.selected);
  assert.equal(selected.length, 1);
  const attempt = selected[0].attempts[0];
  assert.equal(attempt.error.code, 'ASSERTION_FAILED');
  assert.match(JSON.stringify(attempt.error), /故意错误的注册成功页面/);
  assert.equal(attempt.cleanup, 'complete');
  assert.equal(report.run.groups[0].cleanup, 'passed');
  assert.equal(report.run.groups[0].resources.directoryRemoved, true);
  assert.equal(sourceFingerprint(), sourceHash, 'Source changed during artifact control');
  const result = { sourceHash, sourceUnchanged: true,
    baselineFiles: baseline ? await Promise.all(['run.mjs', 'runtime.mjs'].map(async path => ({ path,
      sha256: createHash('sha256').update(await readFile(join(baseline, path))).digest('hex') }))) : null,
    state: baseline ? 'baseline-defect-reproduced' : 'fixed-owner-boundary-passed',
    commandExit: exit, actualAttempts: 1, intendedAssertion: true, attemptCleanup: attempt.cleanup,
    runtimeCleanup: 'passed', markerSha256: createHash('sha256').update(marker).digest('hex'),
    emulatedUploadContainsMarker: baseline ? leaked : null, publicContainsMarker: baseline ? null : leaked,
    consoleContainsMarker: consoleLeaked,
    actualRawDirectory: resolve(raw), privateControlDirectory: privateRoot,
    publicDirectory: baseline ? null : resolve(output), attemptId: attempt.id };
  await mkdir('.e2e', { recursive: true });
  const resultPath = `.e2e/artifact-safety-${baseline ? 'red' : 'green'}-${Date.now()}.json`;
  await writeFile(resultPath, JSON.stringify(result, null, 2) + '\n');
  console.log(`Artifact safety control ${result.state}; receipt: ${resultPath}`);
}

function requireSource(path) {
  // load hooks are synchronous, and never evaluate credential-bearing files.
  return process.getBuiltinModule('fs').readFileSync(path, 'utf8');
}
