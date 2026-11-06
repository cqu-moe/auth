import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('CI skips prose but retains generated API contracts and unknown inputs', () => {
  for (const [paths, expected] of [
    [['README.md', 'docs/agents/development.md', 'docs/e2e/results/screenshot.png'], false],
    [['docs/api/README.md'], false],
    [['docs/api/openapi.json'], true],
    [['README.md', 'src/app.ts'], true],
    [['.github/workflows/test.yml'], true],
    [['new\nfile.ts'], true],
    [[], true],
  ]) {
    const result = spawnSync(process.execPath, ['scripts/ci-paths.mjs'], {
      input: paths.join('\0'), encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), `code=${expected}`, JSON.stringify(paths));
  }
});
