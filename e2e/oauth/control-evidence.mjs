import assert from 'node:assert/strict';
import { assertAttemptCleanup } from './report.mjs';

// Check the actual negative attempt, independently of the runner's error serialization.
export function assertOAuthAssertionFailure(group, report, variant) {
  assert.equal(group.runnerExitCode, 1);
  assert.equal(group.stage, 'journey');
  assert.equal(group.errors.length, 1);
  const [error] = group.errors;
  assert.equal(error.name, 'Error');
  assert.equal(error.message, 'OAuth journey failed (exit 1)');
  assert.match(error.stack, /^Error: OAuth journey failed \(exit 1\)\n\s+at .+\/e2e\/oauth\/run\.mjs:\d+:\d+/);
  assert.equal(error.cause, undefined);
  assert.equal(error.errors, undefined);
  assert.equal(report.run.status, 'failed');
  assert.equal(report.run.exitCode, 1);
  assert.deepEqual(report.run.errors, []);
  for (const [key, value] of Object.entries({ selected: 1, executed: 1, passed: 0, failed: 1, interrupted: 0, flaky: 0, skipped: 0 })) {
    assert.equal(report.run.summary[key], value, `Unexpected ${key} count`);
  }
  const selected = report.run.results.filter(result => result.selected);
  assert.equal(selected.length, 1);
  const [test] = selected;
  assert.equal(test.kind, 'test');
  assert.deepEqual(test.titlePath, [group.test]);
  assert.equal(group.test, 'OAuth S256 authorization, DPoP, refresh and one-device revocation preserve independent website and other-device business');
  assert.equal(test.file, 'e2e/oauth/journey.oauth.e2e.ts');
  assert.equal(test.targetId, variant);
  assert.equal(test.status, 'failed');
  assert.equal(test.attempts.length, 1);
  assert.deepEqual(assertAttemptCleanup(report), { selected: 1, attempts: 1, cleanup: 'complete' });
  const [attempt] = test.attempts;
  assert.equal(attempt.status, 'failed');
  assert.deepEqual(attempt.secondaryErrors, []);
  assert.equal(attempt.error.category, 'test');
  assert.equal(attempt.error.code, 'ASSERTION_FAILED');
  assert.equal(attempt.error.phase, 'beforeEach');
  assert.equal(attempt.error.details.locator, 'getByRole("heading", name: "AUTH04 deliberate failure")');
  assert.match(attempt.error.message, /AUTH04 deliberate failure/);
}
