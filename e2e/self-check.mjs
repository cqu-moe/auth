import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

async function screenshots(dir) {
  let count = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    count += entry.isDirectory() ? await screenshots(join(dir, entry.name)) : Number(entry.name.endsWith('.png'));
  }
  return count;
}

for (const scenario of [
  { name: 'identity', title: '^register, verify, persist', expected: '故意错误的注册成功页面' },
  { name: 'admin', title: '^administrator users and roles', expected: 'AUTH-05 deliberately missing administration heading' },
]) {
  for (const variant of process.env.AUTH_E2E_MOBILE ? ['mobile'] : ['desktop', 'mobile']) {
    const output = `.e2e/negative-${scenario.name}-${variant}-${Date.now()}`;
    // The ordinary runner stops after its first failing viewport. Run each
    // negative viewport independently so both faults are actually exercised.
    const run = spawnSync(process.execPath, ['e2e/run.mjs', '--grep', scenario.title], {
      stdio: 'inherit', env: { ...process.env, AUTH_E2E_BREAK_ASSERTION: '1', AUTH_E2E_OUTPUT: output,
        AUTH_E2E_MOBILE: variant === 'mobile' ? '1' : '', E2E_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1' },
    });
    if (run.status !== 1) throw new Error(`${scenario.name}/${variant}: deliberately wrong assertion did not exit 1`);
    const dir = join(output, variant);
    const report = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8'));
    if (report.run.summary.failed !== 1 || report.run.summary.executed !== 1 || report.run.groups.length !== 1) {
      throw new Error(`${scenario.name}/${variant}: deliberate assertion was not the sole failure`);
    }
    const group = JSON.parse(await readFile(join(dir, report.run.groups[0].report), 'utf8'));
    const results = group.run.results.filter(result => result.selected && result.kind === 'test');
    const assertion = results[0]?.attempts?.at(-1)?.error;
    if (results.length !== 1 || assertion?.code !== 'ASSERTION_FAILED' || !JSON.stringify(assertion).includes(scenario.expected)) {
      throw new Error(`${scenario.name}/${variant}: failed for an unrelated reason`);
    }
    if (!await screenshots(dir)) throw new Error(`${scenario.name}/${variant}: expected failure screenshot missing`);
    const runtime = JSON.parse(await readFile(join(dir, 'runtime.json'), 'utf8'));
    if (runtime.cleanup !== 'passed') throw new Error(`${scenario.name}/${variant}: runtime did not clean up`);
    console.log(`Negative control passed (${scenario.name}/${variant}): intended assertion failed, screenshot/report retained, runtime cleaned. Evidence: ${output}`);
  }
}
