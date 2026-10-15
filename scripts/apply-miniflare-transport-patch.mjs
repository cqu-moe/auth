import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

// Miniflare 4.20260521.0 predates upstream PR #15552. The first releases
// containing that fix are Miniflare 5 alphas, whose worker-options schema is
// incompatible with this repository's E2E runtime. Keep the exact 4.x pin and
// apply only the upstream generation handshake fix after npm installs it.
const patchPath = 'patches/miniflare+4.20260521.0.patch';
const targetPath = 'node_modules/miniflare/dist/src/index.js';
const expectedPatchSha256 = '2967a306b4945926eefa080271b12d3df4076b1c4a5f80f3465b76753078f8b6';

function assertPatched(source) {
  if (!source.includes('function receiveReply(notifyHandle, port, id)')
    || !source.includes('Atomics.store(notifyHandle, /* index */ 0, /* generation */ (id + 1) | 0)')
    || source.includes('Atomics.store(\n      this.#notifyHandle')) {
    throw new Error('Miniflare transport patch verification failed');
  }
}

const patch = await readFile(patchPath);
const patchHash = createHash('sha256').update(patch).digest('hex');
if (patchHash !== expectedPatchSha256) throw new Error(`Miniflare transport patch hash mismatch: ${patchHash}`);
const manifest = JSON.parse(await readFile('node_modules/miniflare/package.json', 'utf8'));
if (manifest.name !== 'miniflare' || manifest.version !== '4.20260521.0') {
  throw new Error(`Unexpected Miniflare version: ${manifest.name}@${manifest.version}`);
}

let source = await readFile(targetPath, 'utf8');
try {
  assertPatched(source);
  console.log('[miniflare-transport] official generation fix already applied');
} catch {
  execFileSync('git', ['apply', '--whitespace=nowarn', patchPath], { stdio: 'inherit' });
  source = await readFile(targetPath, 'utf8');
  assertPatched(source);
  console.log('[miniflare-transport] applied official generation fix');
}
