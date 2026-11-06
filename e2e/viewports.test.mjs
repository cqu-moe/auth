import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectedViewports } from './browser-custody.mjs';

test('viewport shards partition the complete default run and reject typos', t => {
  const original = { ...process.env };
  t.after(() => { process.env = original; });
  delete process.env.AUTH_E2E_VIEWPORT;
  delete process.env.AUTH_E2E_MOBILE;
  const all = selectedViewports();
  assert.deepEqual(all, ['desktop', 'mobile']);
  process.env.AUTH_E2E_MOBILE = '1';
  assert.deepEqual(selectedViewports(), ['mobile']);
  const shards = all.flatMap(viewport => {
    process.env.AUTH_E2E_VIEWPORT = viewport;
    return selectedViewports();
  });
  assert.deepEqual(shards, all);
  process.env.AUTH_E2E_VIEWPORT = 'typo';
  assert.throws(selectedViewports, /Unsupported AUTH_E2E_VIEWPORT/);
});
