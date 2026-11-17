import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

// Miniflare 4.20260521.0 predates upstream PR #15552. The first releases
// containing that fix are Miniflare 5 alphas, whose worker-options schema is
// incompatible with this repository's E2E runtime. Keep the exact 4.x pin and
// verify the upstream generation handshake fix applied by pnpm patchedDependencies.
const patchPath = 'patches/miniflare+4.20260521.0.patch';
const targetPath = 'node_modules/miniflare/dist/src/index.js';
const expectedPatchSha256 = '09cbd995e8e89c6184f123ce3dbdc63e5e21649ecf13241d65a3fbc06502ba90';

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

assertPatched(await readFile(targetPath, 'utf8'));
console.log('[miniflare-transport] verified pnpm-applied generation fix');
