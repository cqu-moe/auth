// e2e 0.21 can return exit 0 / passed while engine teardown failed.
export function assertAttemptCleanup(report) {
  const selected = (report?.run?.results ?? []).filter(result => result.kind === 'test' && result.selected);
  if (!selected.length) throw new Error('OAuth report has no selected attempt records');
  let attempts = 0;
  for (const result of selected) {
    if (!Array.isArray(result.attempts) || !result.attempts.length) throw new Error(`OAuth selected test has no attempts: ${result.id}`);
    for (const attempt of result.attempts) {
      attempts++;
      if (attempt.cleanup !== 'complete' || attempt.secondaryErrors?.some(error => error.phase === 'cleanup')) {
        throw new Error(`OAuth selected attempt cleanup failed: ${result.id}/${attempt.id} (${attempt.cleanup})`);
      }
    }
  }
  if (report.run.errors?.some(error => error.phase === 'cleanup')) throw new Error('OAuth report contains a run cleanup error');
  return { selected: selected.length, attempts, cleanup: 'complete' };
}
