import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { withBrowserCustody } from './browser-custody.mjs';

const { createArtifactRun } = await import(pathToFileURL(resolve(process.env.AUTH_PUBLICATION_BASELINE || 'e2e/artifacts.mjs')));

test('scanner exception and nested cause survive only in private evidence', async () => {
  const marker = `private-scan-${randomUUID()}`;
  const run = await createArtifactRun(`.e2e/publication-control-${randomUUID()}`);
  const primary = new Error(marker, { cause: new AggregateError([new Error(`nested-${marker}`)], 'scanner cause') });
  run.add({ checkArtifacts: async () => { throw primary; } });
  run.outcome('failed', 'passed'); run.finished();
  await writeFile(join(run.raw, 'runner.log'), 'original child failure\n');
  const result = await run.publish();
  assert.equal(result.publication, 'quarantined');
  assert.equal(result.failedStage, 'scan');
  const journal = await readFile(join(run.raw, 'publication-errors.log'), 'utf8');
  assert.ok(journal.includes(marker));
  assert.ok(journal.includes(`nested-${marker}`));
  assert.equal((await stat(join(run.raw, 'publication-errors.log'))).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(run.output), ['artifact-safety.json']);
  assert.ok(!(await readFile(join(run.output, 'artifact-safety.json'), 'utf8')).includes(marker));
  assert.equal(result.privateErrors[0].error, primary);
});

test('receipt write and journal failures preserve the initial exception and secondary errors', async () => {
  const marker = `private-write-${randomUUID()}`;
  const run = await createArtifactRun(`.e2e/publication-control-${randomUUID()}`);
  run.add({ checkArtifacts: async () => {
    await rm(join(run.raw, 'artifact-safety.json'));
    await mkdir(join(run.raw, 'artifact-safety.json'));
    await mkdir(join(run.raw, 'publication-errors.log'));
    throw new Error(marker, { cause: new Error('original scanner cause') });
  } });
  run.finished();
  const result = await run.publish();
  assert.equal(result.publication, 'quarantined');
  const journal = await readFile(`${run.raw}.errors.log`, 'utf8');
  for (const value of [marker, 'original scanner cause', 'private-journal', 'private-receipt', 'EISDIR']) {
    assert.ok(journal.includes(value), `private journal missing ${value === marker ? 'primary marker' : value}`);
  }
  assert.ok(!JSON.stringify(result).includes(marker));
});

test('publication collision preserves the filesystem error and does not overwrite existing evidence', async () => {
  const run = await createArtifactRun(`.e2e/publication-control-${randomUUID()}`);
  run.add({ checkArtifacts: async () => {
    await mkdir(run.output);
    await writeFile(join(run.output, 'existing.log'), 'existing evidence');
  } });
  run.finished();
  const result = await run.publish();
  assert.equal(result.failedStage, 'publication');
  assert.equal(await readFile(join(run.output, 'existing.log'), 'utf8'), 'existing evidence');
  const journal = await readFile(join(run.raw, 'publication-errors.log'), 'utf8');
  assert.match(journal, /ENOTEMPTY|EEXIST/);
  assert.ok(journal.includes('rejection-publication'));
});

test('actual filesystem operation and custody cleanup errors are both retained in order', async () => {
  const directory = resolve(`.auth-e2e-custody-control-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  let primary, cleanup;
  try {
    await assert.rejects(withBrowserCustody({ close: async () => {
      try { await rm(directory, { recursive: false }); }
      catch (error) { cleanup = error; throw error; }
    } }, async () => {
      try { await writeFile(directory, 'invalid destination'); }
      catch (error) { primary = error; throw error; }
    }), error => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [primary, cleanup]);
      assert.equal(primary.code, 'EISDIR');
      assert.match(cleanup.code, /EISDIR/);
      return true;
    });
  } finally { await rm(directory, { recursive: true }); }
});

for (const stage of ['preflight', 'metadata']) test(`${stage} failure preserves pending runner error before first receipt`, async () => {
  const run = await createArtifactRun(`.e2e/publication-control-${randomUUID()}`);
  const marker = `pending-primary-${randomUUID()}`;
  const primary = new Error(marker, { cause: new Error('pending original cause') });
  run.failure(primary);
  if (stage === 'preflight') {
    await mkdir(run.output, { recursive: true });
    await writeFile(join(run.output, 'existing.log'), 'preexisting evidence');
  } else {
    // Real EISDIR at the first pending-error persistence, before the receipt.
    await mkdir(join(run.raw, 'runner-errors.log'));
  }
  const result = await run.publish();
  assert.equal(result.publication, 'quarantined');
  assert.equal(result.failedStage, stage);
  assert.equal(result.scan, 'not-started');
  assert.equal(result.privateErrors[0].error, primary);
  const journal = await readFile(join(run.raw, 'publication-errors.log'), 'utf8');
  assert.ok(journal.includes(marker));
  assert.ok(journal.includes('pending original cause'));
  assert.ok(journal.includes(stage === 'metadata' ? 'EISDIR' : 'refusing to overwrite'));
  if (stage === 'preflight') assert.equal(await readFile(join(run.output, 'existing.log'), 'utf8'), 'preexisting evidence');
  else assert.ok(!(await readFile(join(run.output, 'artifact-safety.json'), 'utf8')).includes(marker));
});

test('rejected symlink ancestor cannot redirect even the bounded rejection receipt', async () => {
  const outside = resolve(`.auth-e2e-redirect-control-${randomUUID()}`);
  const link = resolve(`.e2e/redirect-control-${randomUUID()}`);
  await mkdir(outside, { mode: 0o700 });
  await mkdir('.e2e', { recursive: true });
  await symlink(outside, link);
  try {
    const run = await createArtifactRun(join(link, 'rejected'));
    const result = await run.publish();
    assert.equal(result.failedStage, 'preflight');
    assert.equal(result.scan, 'not-started');
    await assert.rejects(access(join(outside, 'rejected')), { code: 'ENOENT' });
    assert.ok((await readFile(join(run.raw, 'publication-errors.log'), 'utf8')).includes('ancestor is not a directory'));
  } finally { await rm(link); await rm(outside, { recursive: true }); }
});
