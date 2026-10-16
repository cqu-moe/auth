import { createArtifactRun } from '../artifacts.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { relative, join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertAttemptCleanup } from './report.mjs';
import { startOAuthAuth } from './runtime.mjs';
import { sourceFingerprint } from '../school/source.mjs';
import { observeBrowserProfiles, selectedBrowser, withBrowserCustody } from '../browser-custody.mjs';
import { startNetworkProxy } from './network-proxy.mjs';

const browserName = selectedBrowser();

const publicOutput = process.env.AUTH_E2E_OUTPUT || `.e2e/oauth-${Date.now()}`;
const args = process.argv.slice(2);
const config = process.env.AUTH_OAUTH_CLEANUP_CONTROL ? 'e2e.oauth-cleanup.config.ts' : 'e2e.oauth.config.ts';
// Only discovery filters are accepted. Headed/AI/retry flags cannot weaken this gate.
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--grep' && args[index + 1]) index++;
  else if (!args[index].startsWith('--grep=')) throw new Error(`Unsupported OAuth runner option: ${args[index]}`);
}
const variants = process.env.AUTH_E2E_MOBILE ? ['mobile'] : ['desktop', 'mobile'];
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const serialize = error => ({ name: error?.name ?? 'Error', message: error?.message ?? String(error),
  stack: error?.stack ?? String(error),
  ...(error instanceof AggregateError ? { causes: error.errors.map(serialize) } : {}),
  ...(error?.cause ? { cause: serialize(error.cause) } : {}),
  ...(error?.cleanupEvidence ? { cleanupEvidence: error.cleanupEvidence } : {}) });
const json = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
const env = variant => ({ PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, CI: process.env.CI,
  AUTH_E2E_BROWSER: browserName, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
  AUTH_E2E_MOBILE: variant === 'mobile' ? '1' : '', DO_NOT_TRACK: '1', E2E_TELEMETRY_DISABLED: '1', WRANGLER_SEND_METRICS: 'false' });

async function childRun(argv, childEnv, logPath) {
  const custody = logPath && browserName !== 'chromium' ? await observeBrowserProfiles(browserName) : undefined;
  const child = spawn(process.execPath, ['node_modules/e2e/dist/cli/bin.js', ...argv], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...childEnv, ...custody?.env },
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', value => { stdout += value; custody?.observe(); });
  child.stderr.on('data', value => { stderr += value; custody?.observe(); });
  const stop = () => child.kill('SIGTERM');
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  return withBrowserCustody(custody, async () => { try {
    const code = await new Promise((resolveChild, reject) => {
      child.once('error', reject); child.once('close', code => resolveChild(code ?? 1));
    });
    if (logPath) await writeFile(logPath, stdout + stderr);
    return { code, stdout, stderr, browserSafety: custody ? await custody.readback(stdout + stderr) : undefined };
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); } });
}
function readRemovedProxies(platform) {
  const ids = platform.removedProxyIds;
  if (!Array.isArray(ids) || ids.some(id => !/^[a-f0-9]{64}$/.test(id)) || new Set(ids).size !== ids.length) {
    throw new Error('OAuth cleanup did not return precise proxy IDs');
  }
  for (const id of ids) {
    const read = spawnSync('docker', ['container', 'inspect', id], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (read.error || read.status !== 1 || !/No such (?:object|container)/i.test(read.stderr)) {
      throw new Error(`OAuth removed proxy absence readback failed for ${id}`);
    }
  }
  return { absent: true, ids };
}
async function discover(variant, filters) {
  const child = await childRun(['list', '--reporter', 'json', '--config', config, ...filters], env(variant));
  if (child.code) throw new Error(`OAuth discovery exited ${child.code}: ${child.stderr.trim()}`);
  const pairs = JSON.parse(child.stdout).pairs?.filter(pair => pair.kind === 'test' && pair.disposition === 'run') ?? [];
  if (!pairs.length) throw new Error(`OAuth discovery selected no tests for ${variant}`);
  return pairs.map(({ id, file, title, titlePath }) => ({ id, file, title, titlePath }));
}
function assertIds(report, pair) {
  const results = (report.run.results ?? []).filter(result => result.kind === 'test');
  for (const predicate of [result => result.selected, result => result.selected && result.status !== 'skipped']) {
    const ids = new Set(results.filter(predicate).map(result => result.id));
    if (ids.size !== 1 || !ids.has(pair.id)) throw new Error('OAuth discovery/execution ID mismatch');
  }
}
const artifacts = await createArtifactRun(publicOutput);
const output = artifacts.raw;
try {
for (const variant of variants) {
  const dir = join(output, variant);
  await mkdir(dir, { recursive: true });
  const start = new Date().toISOString();
  const evidence = { variant, browser: browserName, startedAt: start, sourceHash: sourceFingerprint(), result: 'failed', cleanup: 'not-started', groups: [] };
  const summaries = [];
  try {
    evidence.stage = 'discovery';
    const all = await discover(variant, []);
    const selected = await discover(variant, args);
    const allIds = new Set(all.map(pair => pair.id));
    if (selected.some(pair => !allIds.has(pair.id))) throw new Error('Filtered OAuth discovery returned an unknown test');
    await json(join(dir, 'discovery.json'), { variant, all, selected });
    evidence.discovered = all.length; evidence.selected = selected.length;
    for (const [index, pair] of selected.entries()) {
      evidence.stage = 'execution';
      const groupDir = join(dir, `${index + 1}-${pair.id.slice(0, 12)}`);
      await mkdir(groupDir, { recursive: true });
      const group = { test: pair.title, cleanup: 'not-started', stage: 'startup', result: 'failed' };
      evidence.groups.push(group);
      let runtime, proxy;
      const errors = [];
      try {
        runtime = await startOAuthAuth({ expectedCommit: process.env.AUTH_E2E_EXPECT_COMMIT, artifacts });
        artifacts.add(runtime);
        group.commit = runtime.commit; group.bundleFingerprint = runtime.bundleFingerprint; group.fixture = runtime.schoolFixture;
        await json(join(groupDir, 'fixture.json'), group.fixture);
        group.stage = 'journey';
        // macOS CFNetwork can bypass loopback proxies (Playwright #20328).
        if (browserName === 'webkit' && process.platform === 'linux') proxy = await startNetworkProxy([runtime.origin, runtime.oauthAppOrigin]);
        const child = await childRun(['run', '--config', config, pair.file,
          '--grep', `^${escapeRegExp(pair.titlePath.join(' '))}$`, '--output', groupDir], {
          ...env(variant), DEBUG: 'pw:browser', AUTH_E2E_URL: runtime.origin, AUTH_E2E_CONTROL: runtime.controlOrigin,
          AUTH_OAUTH_APP: runtime.oauthAppOrigin, AUTH_OAUTH_CONTROL: runtime.oauthControlOrigin,
          AUTH_OAUTH_PROXY: proxy?.origin || '',
          AUTH_SCHOOL_CONTROL: runtime.schoolOrigin, AUTH_E2E_OUTPUT: groupDir,
          AUTH_OAUTH_BREAK_ASSERTION: process.env.AUTH_OAUTH_BREAK_ASSERTION || '',
        }, join(groupDir, 'runner.log'));
        group.runnerExitCode = child.code;
        if (proxy) { group.network = proxy.evidence(); if (child.code === 0) proxy.assertTraffic(); }
        if (browserName === 'chromium') {
          const launch = (child.stdout + child.stderr).split('\n').find(line => line.includes('<launching>')) ?? '';
          const profile = /--user-data-dir=([^\s]+)/.exec(launch)?.[1];
          group.browser = { headless: /--headless(?:[=\s]|$)/.test(launch), passwordStore: launch.includes('--password-store=basic'),
            mockKeychain: launch.includes('--use-mock-keychain'), temporaryProfile: Boolean(profile?.startsWith(join(tmpdir(), 'playwright_chromiumdev_profile-'))) };
          if (!Object.values(group.browser).every(Boolean)) throw new Error('Unsafe OAuth browser launch');
          group.browser.profileRemoved = await access(profile).then(() => false, error => { if (error.code === 'ENOENT') return true; throw error; });
          if (!group.browser.profileRemoved) throw new Error('OAuth browser temporary profile was not removed');
          await writeFile(join(groupDir, 'runner.log'), (child.stdout + child.stderr).split(profile).join('[disposable-browser-profile]'));
        } else {
          group.browser = child.browserSafety;
          if (!group.browser || !Object.values(group.browser).every(Boolean)) throw new Error('Unsafe OAuth browser launch/profile cleanup');
        }
        console.log(`${variant}: ${pair.title} — exit ${child.code}`);
        const report = JSON.parse(await readFile(join(groupDir, 'report.json'), 'utf8'));
        group.report = relative(dir, join(groupDir, 'report.json'));
        assertIds(report, pair);
        const summary = report.run.summary;
        summaries.push(summary); group.summary = summary;
        group.attemptCleanup = assertAttemptCleanup(report);
        if (child.code || report.run.status !== 'passed' || summary.executed !== 1 || summary.passed !== 1
          || summary.failed || summary.skipped || summary.interrupted || summary.flaky) throw new Error(`OAuth journey failed (exit ${child.code})`);
        group.stage = 'business-readback';
        group.business = await runtime.diagnostics();
        if (group.business.credentials || group.business.bindingAddresses || group.business.transportErrors.length
          || group.business.containers.some(item => item.profiles || item.chromeProcesses)) throw new Error('OAuth journey left school state or transport errors');
        group.workflows = await runtime.readWorkflows();
        const deadline = Date.now() + 90000;
        while (group.workflows.some(item => item.status !== 'complete') && Date.now() < deadline) {
          await new Promise(resolveWait => setTimeout(resolveWait, 200)); group.workflows = await runtime.readWorkflows();
        }
        if (!group.workflows.length || group.workflows.some(item => item.status !== 'complete' || item.output?.cleanupComplete !== true)) throw new Error('Real recovery Workflow missing or not cleaned');
        group.result = 'passed';
      } catch (error) { errors.push(error); }
      finally {
        if (proxy) {
          try { await proxy.close(); group.networkCleanup = 'passed'; }
          catch (error) { group.networkCleanup = 'failed'; errors.push(error); }
        }
        if (runtime) {
          group.protocol = runtime.oauthDiagnostics();
          try {
            group.resources = await runtime.close(); group.cleanup = 'passed';
            if (group.resources.directoryRemoved !== true) throw new Error('OAuth runtime directory was not removed');
            if (group.resources.platform?.containerObjectsRemoved !== true || group.resources.platform?.proxyObjectsRemoved !== true
              || group.resources.platform?.fixtureImageRemoved !== true) throw new Error('OAuth school container/proxy cleanup was not verified');
            group.proxyReadback = readRemovedProxies(group.resources.platform);
            if (group.business && !group.proxyReadback.ids.length) throw new Error('OAuth business journey has no removed native proxy evidence');
          } catch (error) {
            group.cleanup = 'failed'; errors.push(error);
            const findCleanup = failure => failure?.cleanupEvidence ?? (failure instanceof AggregateError
              ? failure.errors.map(findCleanup).find(Boolean) : undefined);
            const partial = findCleanup(error);
            if (partial) {
              group.failedCleanupEvidence = partial;
              try { group.proxyReadback = readRemovedProxies(partial); }
              catch (readbackError) { errors.push(readbackError); }
            }
          }
        }
        if (group.networkCleanup === 'failed') group.cleanup = 'failed';
        group.sourceUnchanged = evidence.sourceHash === sourceFingerprint();
        if (!group.sourceUnchanged) errors.push(new Error('Source changed during OAuth run'));
        group.errors = errors.map(serialize);
        if (errors.length) group.result = 'failed';
        await json(join(groupDir, 'runtime.json'), group);
      }
      if (errors.length) throw new AggregateError(errors, `OAuth group failed: ${pair.title}`);
    }
    evidence.result = 'passed';
  } catch (error) { evidence.failure = { stage: evidence.stage, ...serialize(error) }; process.exitCode = 1; }
  finally {
    evidence.cleanup = evidence.groups.length ? (evidence.groups.every(group => group.cleanup === 'passed') ? 'passed'
      : evidence.groups.some(group => group.cleanup === 'failed') ? 'failed' : 'not-started') : 'not-started';
    evidence.sourceUnchanged = evidence.sourceHash === sourceFingerprint();
    evidence.finishedAt = new Date().toISOString();
    const totals = summaries.reduce((sum, row) => {
      for (const key of Object.keys(sum)) sum[key] += row[key] ?? 0;
      return sum;
    }, { selected: 0, executed: 0, passed: 0, failed: 0, skipped: 0, interrupted: 0, flaky: 0 });
    artifacts.outcome(evidence.result, evidence.cleanup);
    await json(join(dir, 'runtime.json'), evidence);
    await json(join(dir, 'report.json'), { schemaVersion: 'auth-oauth-e2e-1', run: {
      status: evidence.result, exitCode: process.exitCode ? 1 : 0, startedAt: start, finishedAt: evidence.finishedAt,
      summary: { ...totals, discovered: evidence.discovered ?? 0 }, groups: evidence.groups,
      ...(evidence.failure ? { failure: evidence.failure } : {}),
    } });
  }
  if (process.exitCode) break;
}
  artifacts.finished();
} catch (error) {
  artifacts.failure(error);
  process.exitCode = 1;
} finally {
  const publication = await artifacts.publish();
  if (publication.publication !== 'scanned') process.exitCode = 1;
}
console.log(`Evidence: ${publicOutput}`);
