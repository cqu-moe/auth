import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createArtifactRun } from './artifacts.mjs';
import { prepareAccount } from './prepare-account.mjs';
import { startAuth } from './runtime.mjs';

for (const explicit of [false, true]) test(explicit
  ? 'explicitly registered six-digit secrets still quarantine artifacts'
  : 'delivered OTPs do not misclassify unrelated artifact metadata', { timeout: 90000 }, async () => {
  const run = await createArtifactRun(`.e2e/artifact-mail-${randomUUID()}`);
  let runtime;
  try {
    runtime = await startAuth({ artifacts: run });
    const email = 'artifact-mail@example.test';
    await prepareAccount(runtime, { email, password: 'Synthetic-only-123!' });
    const response = await fetch(`${runtime.controlOrigin}/mail?email=${email}`);
    const { otp } = await response.json();
    assert.match(otp, /^\d{6}$/);
    if (explicit) {
      const registered = await fetch(`${runtime.controlOrigin}/artifact-secret`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ values: [otp] }),
      });
      assert.equal(registered.status, 204);
    }
    const report = JSON.stringify({ schemaVersion: 'report-1', run: {
      id: `aa${otp}-bbbb-4ccc-8ddd-eeeeeeeeeeee`,
      vcs: { commit: `aa${otp}${'b'.repeat(32)}` },
      // Prefixing preserves a serialized collision even for leading-zero OTPs.
      results: [{ attempts: [{ durationMs: Number(`1${otp}`) }] }],
    } });
    await writeFile(join(run.raw, 'report.json'), report);
    await runtime.close(); runtime = undefined;
    run.outcome('passed', 'passed'); run.finished();
    const result = await run.publish();
    assert.equal(result.publication, explicit ? 'quarantined' : 'scanned');
    assert.equal(await readFile(join(explicit ? run.raw : run.output, 'report.json'), 'utf8'), report);
    if (explicit) assert.deepEqual(await readdir(run.output), ['artifact-safety.json']);
  } finally {
    await runtime?.close();
    await rm(run.raw, { recursive: true, force: true });
    await rm(run.output, { recursive: true, force: true });
  }
});
