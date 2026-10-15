import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { inspect } from 'node:util';

const syntheticPasswords = ['Synthetic-only-123!', 'Synthetic-reset-only-456!', 'Synthetic-change-only-456!',
  'School-synthetic-123!', 'synthetic-rpc-secret'];

async function files(directory) {
  const result = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) result.push(...await files(path));
    else if (item.isFile()) result.push(path);
    else throw new Error('Non-regular E2E artifact refused');
  }
  return result.sort();
}

// Used by the real runtime with its live mail/token/secret registry, including
// after close(). Also covers discovery before a runtime has acquired secrets.
export async function checkArtifacts(directory, sensitive = []) {
  const values = [...syntheticPasswords, ...sensitive].filter(value => typeof value === 'string' && value);
  for (const path of await files(directory)) {
    const bytes = await readFile(path);
    if (values.some(value => relative(directory, path).includes(value) || bytes.includes(Buffer.from(value)))) {
      throw new Error('Sensitive synthetic value found in E2E artifacts');
    }
  }
}

export async function createArtifactRun(destination) {
  const output = resolve(destination);
  const publicRoot = resolve('.e2e');
  if (!output.startsWith(publicRoot + '/')) throw new Error('E2E output must be a child of .e2e');
  // No raw framework bytes are ever created inside the CI upload glob.
  process.umask(0o077);
  const raw = await mkdtemp(resolve('.auth-e2e-artifacts-'));
  const policies = [];
  const outcomes = [];
  const runnerErrors = [];
  let published = false;
  let finished = false;
  return {
    raw, output,
    add(runtime) {
      if (typeof runtime.checkArtifacts !== 'function') throw new Error('Runtime artifact scanner missing');
      const index = policies.findIndex(policy => policy.checkArtifacts === runtime.checkArtifacts);
      if (index === -1) policies.push(runtime);
      else if (runtime.redact) policies[index] = runtime;
    },
    outcome(primary, cleanup) {
      if (!['passed', 'failed', 'incomplete'].includes(primary)
        || !['passed', 'failed', 'not-started'].includes(cleanup)) throw new Error('Invalid artifact outcome classification');
      outcomes.push({ primary, cleanup });
    },
    finished() { finished = true; },
    failure(error) { runnerErrors.push(error); outcomes.push({ primary: 'failed', cleanup: 'not-started' }); },
    async publish() {
      if (published) throw new Error('Artifacts already finalized');
      published = true;
      const receipt = { schemaVersion: 'auth-artifact-publication-1', outcomes,
        primary: !finished || process.exitCode || outcomes.some(row => row.primary !== 'passed') ? 'failed' : 'passed',
        cleanup: outcomes.some(row => row.cleanup === 'failed') ? 'failed'
          : outcomes.length && outcomes.every(row => row.cleanup === 'passed') ? 'passed' : 'not-started',
        runtimeScanners: policies.length, publication: 'scanned', scan: 'passed' };
      let stage = 'preflight';
      let outputAdmitted = false;
      try {
        // Check every ancestor: renaming through a symlink could publish elsewhere.
        const parents = [];
        for (let path = dirname(output); path !== resolve('.'); path = dirname(path)) parents.unshift(path);
        for (const path of parents) {
          await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
          if (!(await lstat(path)).isDirectory()) throw new Error('Artifact output ancestor is not a directory');
        }
        if (await lstat(output).then(() => true, error => {
          if (error.code === 'ENOENT') return false;
          throw error;
        })) throw new Error('Artifact output already exists; refusing to overwrite evidence');
        outputAdmitted = true;
        stage = 'metadata';
        if (runnerErrors.length) await writeFile(join(raw, 'runner-errors.log'), inspect(runnerErrors,
          { depth: null, maxArrayLength: null, maxStringLength: null, customInspect: false, getters: false }) + '\n');
        await writeFile(join(raw, 'artifact-safety.json'), JSON.stringify(receipt, null, 2) + '\n');
        stage = 'redaction';
        // All callers have finished writing final runtime/aggregate/cleanup data.
        // Never reserialize original objects after these redactors/scanners.
        for (const policy of policies) await policy.redact?.(raw);
        stage = 'scan';
        await checkArtifacts(raw);
        for (const policy of policies) await policy.checkArtifacts(raw);
        stage = 'publication';
        await rename(raw, output); // The exact scanned directory, no later writes.
        return receipt;
      } catch (error) {
        const rejection = { ...receipt, publication: 'quarantined', scan: stage === 'publication' ? 'passed' : stage === 'scan' ? 'failed' : 'not-started',
          failedStage: stage, code: 'ARTIFACT_PUBLICATION_REJECTED', quarantineDirectory: relative(resolve('.'), raw) };
        const errors = [...runnerErrors.map(error => ({ stage: 'runner', error })), { stage, error }];
        const record = async (failureStage, action) => {
          try { return await action(); }
          catch (secondary) { errors.push({ stage: failureStage, error: secondary }); }
        };
        // Never expose an exception's message, stack, cause or custom fields in
        // console/public receipts. Keep the complete chain in private storage.
        const journal = async () => {
          for (const path of [join(raw, 'publication-errors.log'), `${raw}.errors.log`]) {
            let handle;
            try {
              handle = await open(path, 'a', 0o600);
              await handle.write(inspect(errors, { depth: null, maxArrayLength: null,
                maxStringLength: null, customInspect: false, getters: false }) + '\n');
              await handle.sync();
              await handle.close();
              return true;
            } catch (journalError) {
              errors.push({ stage: 'private-journal', error: journalError });
              if (handle) await record('private-journal-close', () => handle.close());
            }
          }
          return false;
        };
        await journal();
        // The private copy must describe the actual rejection too, rather than
        // retaining the provisional success receipt prepared for the scan.
        await record('private-receipt', () => writeFile(join(raw, 'artifact-safety.json'), JSON.stringify(rejection, null, 2) + '\n'));
        const quarantinedFiles = [];
        // Hash only: even filenames or scanner exception messages may be private.
        await record('private-inventory', async () => {
          for (const path of await files(raw)) {
            // The journal can still gain a secondary publication error. Only
            // immutable quarantined data is included in this public manifest.
            if (path === join(raw, 'publication-errors.log')) continue;
            const bytes = await readFile(path);
            quarantinedFiles.push({ sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
          }
        });
        const rejected = { ...rejection, quarantinedFiles };
        if (outputAdmitted) await record('rejection-publication', async () => {
          await mkdir(output, { mode: 0o700 });
          await writeFile(join(output, 'artifact-safety.json'), JSON.stringify(rejected, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
          // Only bounded enums, counts and digests are public on rejection.
          await checkArtifacts(output);
        });
        await journal();
        // Even if both private storage locations are unavailable, retain every
        // Error for the caller without allowing JSON/console projection of it.
        Object.defineProperty(rejected, 'privateErrors', { value: errors });
        return rejected;
      }
    },
  };
}
