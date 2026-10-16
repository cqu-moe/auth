import { createArtifactRun } from '../artifacts.mjs';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startSchoolAuth } from './runtime.mjs';

const describeError = error => error instanceof AggregateError
  ? `${error.message}: ${error.errors.map(describeError).join('; ')}`
  : `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`;
const publicOutput = process.env.AUTH_E2E_OUTPUT || `.e2e/school-container-probe-${Date.now()}`;
const artifacts = await createArtifactRun(publicOutput);
const output = artifacts.raw;
const evidence = {result:'failed',cleanup:'not-started'};
let runtime;
try {
  runtime = await startSchoolAuth({expectedCommit:process.env.AUTH_E2E_EXPECT_COMMIT,artifacts});
  artifacts.add(runtime);
  evidence.cleanup = 'pending';
  await runtime.prepare();
  const response = await fetch(`${runtime.schoolOrigin}/fixture`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  const body = await response.json().catch(() => null);
  evidence.fixture = {status:response.status,body};
  assert.equal(response.status,200);
  assert.equal(body?.state?.mode,'success');
  evidence.result = 'passed';
} catch (error) {
  evidence.error = `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`;
  process.exitCode = 1;
  console.error('School container probe failed; details retained in private artifacts');
} finally {
  if (runtime) {
    try {
      evidence.resources = await runtime.close();
      evidence.cleanup = 'passed';
    } catch (error) {
      evidence.cleanup = 'failed';
      evidence.cleanupError = describeError(error);
      process.exitCode = 1;
    }
  }
  try {
    await writeFile(join(output,'runtime.json'),JSON.stringify(evidence,null,2)+'\n');
    artifacts.outcome(evidence.result,evidence.cleanup);
    artifacts.finished();
  } finally {
    if ((await artifacts.publish()).publication !== 'scanned') process.exitCode = 1;
  }
}
