import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { relative, resolve, join } from 'node:path';
import { startAuth } from './runtime.mjs';
import { tmpdir } from 'node:os';
import { readdirSync } from 'node:fs';
import { sourceFingerprint } from './school/source.mjs';

const browserName = process.env.AUTH_E2E_BROWSER || 'chromium';
if (!['chromium', 'firefox', 'webkit'].includes(browserName)) throw new Error('Unsupported AUTH_E2E_BROWSER');
const supplement = browserName !== 'chromium';
const config = supplement ? 'e2e.cross-browser.config.ts' : 'e2e.config.ts';
const browserEnv = { AUTH_E2E_BROWSER: browserName, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
  AUTH_E2E_CLEANUP_CONTROL: process.env.AUTH_E2E_CLEANUP_CONTROL || '' };
const applicable = supplement && !process.env.AUTH_E2E_CLEANUP_CONTROL ? ['--grep-invert', '^virtual WebAuthn'] : [];

const output = process.env.AUTH_E2E_OUTPUT || `.e2e/run-${Date.now()}`;
if (!resolve(output).startsWith(resolve('.e2e') + '/')) throw new Error('E2E output must be a child of .e2e');
const variants = process.env.AUTH_E2E_MOBILE ? ['mobile'] : supplement ? ['desktop'] : ['desktop', 'mobile'];
const userArgs = process.argv.slice(2);
if (supplement) for (let i = 0; i < userArgs.length; i++) {
  if (userArgs[i] === '--grep' && userArgs[i + 1]) i++;
  else if (!userArgs[i].startsWith('--grep=')) throw new Error(`Unsupported supplement option: ${userArgs[i]}`);
}
// Discovery already applied the user's title filters. Repeating them would OR
// with the group's exact titles and run unrelated journeys in this runtime.
const executionArgs = userArgs.filter((arg, index) =>
  arg !== '--grep' && !arg.startsWith('--grep=') && userArgs[index - 1] !== '--grep');

const slug = value => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function serializeError(error) {
  return {
    name: error?.name ?? 'Error',
    message: error?.message ?? String(error),
    stack: error?.stack ?? String(error),
  };
}

async function discoverTests(variant, args) {
  const child = spawn(process.execPath, ['node_modules/e2e/dist/cli/bin.js', 'list', '--reporter', 'json', '--config', config, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...browserEnv,
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      DO_NOT_TRACK: '1',
      E2E_TELEMETRY_DISABLED: '1',
      AUTH_E2E_MOBILE: variant === 'mobile' ? '1' : '',
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const stop = () => child.kill('SIGTERM');
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const close = await new Promise((resolveChild, rejectChild) => {
      child.once('error', rejectChild);
      child.once('close', (code, signal) => resolveChild({ code, signal }));
    });
    if (close.code) {
      throw new Error(`E2E discovery exited ${close.code ?? `via ${close.signal}`}:\n${stderr.trim()}`);
    }
    const parsed = JSON.parse(stdout);
    const pairs = (parsed.pairs ?? []).filter(pair => pair.kind === 'test' && pair.disposition === 'run');
    if (!pairs.length) throw new Error(`E2E discovery selected no tests for ${variant}`);
    return pairs.map(({ id, file, title, titlePath, source, target }) => ({
      id, file, title, titlePath, source, target,
    }));
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

function runtimeGroups(discovered) {
  const identity = discovered.filter(pair => pair.file === 'e2e/identity.e2e.ts');
  const journeys = discovered.filter(pair => pair.file !== 'e2e/identity.e2e.ts')
    .map(pair => ({
      name: `${pair.id.slice(0, 12)}-${slug(pair.titlePath.join(' ')) || 'journey'}`,
      pairs: [pair],
    }));
  return [
    ...identity.length ? [{ name: 'identity', pairs: identity }] : [],
    ...journeys,
  ];
}

function selectionArgsFor(pairs) {
  const files = [...new Set(pairs.map(pair => pair.file))];
  if (files.length !== 1) throw new Error('A runtime group must contain tests from exactly one file');
  return [
    files[0],
    ...pairs.flatMap(pair => ['--grep', `^${escapeRegExp(pair.titlePath.join(' '))}$`]),
  ];
}

async function runE2EGroup({ args, dir, variant, runtime }) {
  const browserTmp = supplement ? await mkdtemp(join(tmpdir(), 'auth-browser-')) : undefined;
  const profiles = new Set();
  const child = spawn(process.execPath, ['node_modules/e2e/dist/cli/bin.js', 'run', '--config', config, ...applicable, ...args, '--output', dir], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...browserEnv,
      PATH: process.env.PATH,
      TMPDIR: browserTmp ?? process.env.TMPDIR,
      CI: process.env.CI,
      ...(supplement ? { DEBUG: 'pw:browser' } : {}),
      AUTH_E2E_URL: runtime.origin,
      AUTH_E2E_CONTROL: runtime.controlOrigin,
      AUTH_E2E_MOBILE: variant === 'mobile' ? '1' : '',
      AUTH_E2E_OUTPUT: dir,
      AUTH_E2E_BREAK_ASSERTION: process.env.AUTH_E2E_BREAK_ASSERTION || '',
      DO_NOT_TRACK: '1',
      E2E_TELEMETRY_DISABLED: '1',
      WRANGLER_SEND_METRICS: 'false',
    },
  });
  let log = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', chunk => {
      log += chunk;
      if (browserTmp) for (const name of readdirSync(browserTmp)) {
        if (name.startsWith(`playwright_${browserName}dev_profile-`)) profiles.add(join(browserTmp, name));
      }
      process.stdout.write(chunk);
    });
  }
  const stop = () => child.kill('SIGTERM');
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    // Wait for close, not exit: report writing and both stdio streams must flush.
    const close = await new Promise((resolveChild, rejectChild) => {
      child.once('error', rejectChild);
      child.once('close', (code, signal) => resolveChild({ code, signal }));
    });
    const profilesRemoved = await Promise.all([...profiles].map(path => access(path).then(() => false, error => {
      if (error.code === 'ENOENT') return true; throw error;
    })));
    return { code: close.code ?? 1, signal: close.signal, log,
      browserSafety: { temporaryProfile: profiles.size > 0, profileRemoved: profilesRemoved.length > 0 && profilesRemoved.every(Boolean) } };
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    if (browserTmp) await rm(browserTmp, { recursive: true, force: true });
  }
}

function describeSetMismatch(expected, actual, label) {
  const missing = [...expected].filter(id => !actual.has(id));
  const extra = [...actual].filter(id => !expected.has(id));
  return `${label}: ${missing.length} missing [${missing.join(', ')}], ${extra.length} unexpected [${extra.join(', ')}]`;
}

function assertSameSet(expected, actual, label) {
  if (expected.size !== actual.size || [...expected].some(id => !actual.has(id))) {
    throw new Error(describeSetMismatch(expected, actual, label));
  }
}

function reportTests(report) {
  return (report?.run?.results ?? []).filter(result => result.kind === 'test');
}

function testIdSet(results, predicate = () => true) {
  return new Set(results.filter(predicate).map(result => result.id));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

for (const variant of variants) {
  const variantDir = join(output, variant);
  await mkdir(variantDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const summaries = [];
  const groupEvidence = [];
  const logs = [];
  const variantErrors = [];
  const sourceHash = supplement ? sourceFingerprint() : null;
  let allDiscovered = [];
  let selectedDiscovered = [];
  let groups = [];

  try {
    allDiscovered = await discoverTests(variant, []);
    selectedDiscovered = await discoverTests(variant, [...applicable, ...userArgs]);
    const allIds = new Set(allDiscovered.map(pair => pair.id));
    const selectedIds = new Set(selectedDiscovered.map(pair => pair.id));
    if (selectedDiscovered.some(pair => !allIds.has(pair.id))) throw new Error('Filtered discovery returned a test absent from full discovery');
    groups = runtimeGroups(selectedDiscovered);
    await writeJson(join(variantDir, 'discovery.json'), {
      schemaVersion: 'e2e-discovery-1',
      variant,
      all: allDiscovered,
      selected: selectedDiscovered,
    });

    for (const [index, group] of groups.entries()) {
      const dir = join(variantDir, `${String(index + 1).padStart(2, '0')}-${group.name}`);
      await mkdir(dir, { recursive: true });
      const intended = new Set(group.pairs.map(pair => pair.id));
      let runtime = null;
      const evidence = {
        variant,
        group: group.name,
        expectedTests: intended.size,
        cleanup: 'pending',
      };
      groupEvidence.push(evidence);
      const groupErrors = [];

      try {
        runtime = await startAuth({ expectedCommit: process.env.AUTH_E2E_EXPECT_COMMIT });
        evidence.commit = runtime.commit;
        evidence.bundleFingerprint = runtime.bundleFingerprint;
        evidence.browser = browserName;
        console.log(`Auth built Worker ready; commit ${runtime.commit}; ${variant}; runtime ${index + 1}/${groups.length} (${group.name})`);
        const outcome = await runE2EGroup({ args: [...executionArgs, ...selectionArgsFor(group.pairs)], dir, variant, runtime });
        logs.push(outcome.log);
        await writeFile(join(dir, 'runner.log'), outcome.log);
        evidence.runnerExitCode = outcome.code;
        if (supplement) {
          const launch = outcome.log.split('\n').find(line => line.includes('<launching>')) ?? '';
          evidence.browserSafety = { headless: /(?:-headless|--headless)(?:\s|$)/.test(launch),
            engine: browserName === 'firefox' ? /firefox[^\s]* -no-remote/.test(launch) : launch.includes('pw_run.sh'),
            ...outcome.browserSafety };
          if (!Object.values(evidence.browserSafety).every(Boolean)) throw new Error('Supplement browser launch/profile cleanup was not safe');
        }
        if (outcome.code) {
          process.exitCode = outcome.code;
          groupErrors.push(new Error(`E2E runtime group ${group.name} exited ${outcome.code}${outcome.signal ? ` after ${outcome.signal}` : ''}`));
        }

        let report;
        try {
          report = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8'));
        } catch {
          throw new Error(`E2E runtime group ${group.name} wrote no readable report.json`);
        }
        evidence.report = relative(variantDir, join(dir, 'report.json'));
        const results = reportTests(report);
        const reportDiscovered = testIdSet(results);
        const reportSelected = testIdSet(results, result => result.selected);
        const reportExecuted = testIdSet(results, result => result.selected && result.status !== 'skipped');
        assertSameSet(new Set(allDiscovered.map(pair => pair.id)), reportDiscovered, `framework discovery mismatch in ${group.name}`);
        assertSameSet(intended, reportSelected, `selected test mismatch in ${group.name}`);
        assertSameSet(intended, reportExecuted, `executed test mismatch in ${group.name}`);

        // e2e 0.21 may report passed/exit 0 with a failed provider cleanup.
        const attempts = results.filter(result => result.selected).flatMap(result => {
          if (!result.attempts?.length) throw new Error('Selected test has no attempt evidence');
          return result.attempts;
        });
        if (!attempts.length || attempts.some(attempt => attempt.cleanup !== 'complete'
          || attempt.secondaryErrors?.some(error => error.phase === 'cleanup'))
          || report.run.errors?.some(error => error.phase === 'cleanup')) {
          throw new Error('Browser provider cleanup failed in framework attempt evidence');
        }
        evidence.attemptCleanup = 'complete';

        const summary = report.run.summary;
        if (!summary.executed || summary.skipped || summary.interrupted) {
          throw new Error(`Required E2E group was empty, skipped or interrupted (${group.name})`);
        }
        if (!outcome.code && (summary.failed || report.run.status !== 'passed')) {
          throw new Error(`Runner result mismatch in ${group.name}`);
        }
        evidence.status = report.run.status;
        evidence.selectedTests = reportSelected.size;
        evidence.executedTests = reportExecuted.size;
        summaries.push(summary);
        await runtime.checkArtifacts(dir);
      } catch (error) {
        process.exitCode ||= 1;
        groupErrors.push(error);
        evidence.status ??= 'failed';
      }

      if (runtime) {
        try {
          evidence.resources = await runtime.close();
          if (!evidence.resources.directoryRemoved) throw new Error('Runtime directory was not removed');
          evidence.cleanup = 'passed';
        } catch (error) {
          process.exitCode ||= 1;
          evidence.cleanup = 'failed';
          evidence.cleanupError = serializeError(error);
          groupErrors.push(error);
        }
      } else {
        evidence.cleanup = 'failed';
        evidence.stage = 'startup';
      }
      if (supplement && sourceFingerprint() !== sourceHash) {
        process.exitCode ||= 1; groupErrors.push(new Error('Source changed during supplement run'));
      }
      await writeJson(join(dir, 'runtime.json'), evidence);
      if (groupErrors.length) {
        const error = groupErrors.length === 1
          ? groupErrors[0]
          : new AggregateError(groupErrors, `Runtime group ${group.name} failed with ${groupErrors.length} errors`);
        variantErrors.push(error);
        throw error;
      }
    }
  } catch (error) {
    process.exitCode ||= 1;
    variantErrors.push(error);
  }

  const selectedIds = new Set(selectedDiscovered.map(pair => pair.id));
  const allIds = new Set(allDiscovered.map(pair => pair.id));
  const aggregateSelected = new Set();
  const aggregateExecuted = new Set();
  for (const [index, group] of groups.entries()) {
    const dir = join(variantDir, `${String(index + 1).padStart(2, '0')}-${group.name}`);
    try {
      const report = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8'));
      for (const result of reportTests(report)) {
        if (result.selected) aggregateSelected.add(result.id);
        if (result.selected && result.status !== 'skipped') aggregateExecuted.add(result.id);
      }
    } catch {
      // The per-runtime error and aggregate error preserve the original failure.
    }
  }
  const executedIdSet = aggregateExecuted;
  const selectedMatch = selectedIds.size === aggregateSelected.size &&
    [...selectedIds].every(id => aggregateSelected.has(id));
  const executedMatch = executedIdSet.size === selectedIds.size && [...selectedIds].every(id => executedIdSet.has(id));
  const totals = summaries.reduce((total, summary) => ({
    discovered: allIds.size,
    selected: total.selected + summary.selected,
    executed: total.executed + summary.executed,
    passed: total.passed + summary.passed,
    failed: total.failed + summary.failed,
    interrupted: total.interrupted + summary.interrupted,
    flaky: total.flaky + summary.flaky,
    skipped: total.skipped + summary.skipped,
  }), { discovered: 0, selected: 0, executed: 0, passed: 0, failed: 0, interrupted: 0, flaky: 0, skipped: 0 });
  if (!selectedMatch || !executedMatch) {
    process.exitCode ||= 1;
    variantErrors.push(new Error(
      `${describeSetMismatch(selectedIds, aggregateSelected, 'aggregate selected set')}\\n${describeSetMismatch(selectedIds, executedIdSet, 'aggregate executed set')}`,
    ));
  }

  const firstCommit = groupEvidence.find(group => typeof group.commit === 'string')?.commit ?? null;
  const status = process.exitCode ? 'failed' : 'passed';
  await writeJson(join(variantDir, 'report.json'), {
    schemaVersion: 'report-aggregate-1',
    run: {
      id: crypto.randomUUID(),
      status,
      exitCode: process.exitCode ? 1 : 0,
      startedAt,
      finishedAt: new Date().toISOString(),
      runner: { name: 'auth-e2e-isolated-runtime', version: 2 },
      summary: totals,
      discovery: {
        source: 'e2e 0.21 list --reporter json',
        discovered: allIds.size,
        selected: selectedIds.size,
        executed: executedIdSet.size,
        selectedMatch,
        executedMatch,
      },
      browser: browserName, sourceHash, sourceUnchanged: !supplement || sourceFingerprint() === sourceHash,
      runtimeIsolation: 'one Worker/D1/browser context per AUTH-02 journey; AUTH-01 registration journeys share one runtime',
      groups: groupEvidence,
      errors: variantErrors.map(serializeError),
    },
  });
  await writeFile(join(variantDir, 'runner.log'), logs.join('\n'));
  await writeJson(join(variantDir, 'runtime.json'), {
    commit: firstCommit, browser: browserName, sourceHash, sourceUnchanged: !supplement || sourceFingerprint() === sourceHash,
    variant,
    cleanup: groupEvidence.length === groups.length && groups.length > 0 && groupEvidence.every(group => group.cleanup === 'passed') ? 'passed' : 'failed',
    isolatedRuntimes: groupEvidence.filter(group => group.cleanup !== 'failed' || group.stage !== 'startup').length,
    expectedRuntimes: groups.length,
  });
  if (process.exitCode) break;
}
console.log(`Evidence: ${output}`);
