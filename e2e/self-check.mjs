import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
const output = `.e2e/negative-${Date.now()}`;
const run = spawnSync(process.execPath, ['e2e/run.mjs', '--grep', '^register, verify, persist'], {
  stdio: 'inherit', env: { ...process.env, AUTH_E2E_BREAK_ASSERTION: '1', AUTH_E2E_OUTPUT: output,
    E2E_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1' },
});
const report = JSON.parse(await readFile(join(output, 'desktop/report.json'), 'utf8'));
if (run.status !== 1 || report.run.summary.failed !== 1 || report.run.summary.executed !== 1) {
  throw new Error('Deliberately wrong business assertion was not reported as the sole failure');
}
async function screenshots(dir) {
  let count = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    count += entry.isDirectory() ? await screenshots(join(dir,entry.name)) : Number(entry.name.endsWith('.png'));
  }
  return count;
}
if (!await screenshots(join(output,'desktop'))) throw new Error('Expected failure screenshot missing');
const runtime = JSON.parse(await readFile(join(output,'desktop/runtime.json'),'utf8'));
if (runtime.cleanup !== 'passed') throw new Error('Negative run did not clean its resources');
console.log('Negative control passed: wrong business assertion failed, screenshot/report retained, runtime cleaned.');
