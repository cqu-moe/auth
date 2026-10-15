import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { startAuth } from './runtime.mjs';

const output = process.env.AUTH_E2E_OUTPUT || `.e2e/run-${Date.now()}`;
if (!resolve(output).startsWith(resolve('.e2e') + '/')) throw new Error('E2E output must be a child of .e2e');
const variants = process.env.AUTH_E2E_MOBILE ? ['mobile'] : ['desktop', 'mobile'];
for (const variant of variants) {
  const dir = join(output, variant);
  await mkdir(dir, { recursive: true });
  const runtime = await startAuth({ expectedCommit: process.env.AUTH_E2E_EXPECT_COMMIT });
  const evidence = { commit: runtime.commit, variant, cleanup: 'pending' };
  console.log(`Auth built Worker ready; commit ${runtime.commit}; ${variant}`);
  try {
    // No model/provider keys or developer credentials are inherited by the test process.
    const child = spawn(process.execPath, ['node_modules/e2e/dist/cli/bin.js', 'run', ...process.argv.slice(2)], {
      stdio: ['ignore', 'pipe', 'pipe'], env: {
        PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, CI: process.env.CI,
        AUTH_E2E_URL: runtime.origin, AUTH_E2E_CONTROL: runtime.controlOrigin,
        AUTH_E2E_MOBILE: variant === 'mobile' ? '1' : '', AUTH_E2E_OUTPUT: dir,
        AUTH_E2E_BREAK_ASSERTION: process.env.AUTH_E2E_BREAK_ASSERTION || '',
        DO_NOT_TRACK: '1', E2E_TELEMETRY_DISABLED: '1', WRANGLER_SEND_METRICS: 'false',
      },
    });
    let log = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk; process.stdout.write(chunk); });
    const stop = () => child.kill('SIGTERM');
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
      process.exitCode = await new Promise((r,j) => { child.on('error',j); child.on('exit',code => r(code ?? 1)); });
    } finally { process.removeListener('SIGINT',stop); process.removeListener('SIGTERM',stop); }
    await writeFile(join(dir, 'runner.log'), log);
    const report = JSON.parse(await readFile(join(dir,'report.json'),'utf8'));
    if (!report.run.summary.executed || report.run.summary.skipped || report.run.summary.interrupted) {
      throw new Error('Required E2E suite was empty, skipped or interrupted');
    }
    if (process.exitCode === 0 && (report.run.summary.failed || report.run.status !== 'passed')) throw new Error('Runner result mismatch');
    await runtime.checkArtifacts(dir);
  } finally {
    await runtime.close();
    evidence.cleanup = 'passed';
    await writeFile(join(dir, 'runtime.json'), JSON.stringify(evidence,null,2)+'\n');
  }
  if (process.exitCode) break;
}
console.log(`Evidence: ${output}`);
