import { createArtifactRun } from '../artifacts.mjs';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {startSchoolAuth} from './runtime.mjs';
import {sourceFingerprint} from './source.mjs';
import {observeBrowserProfiles,selectedBrowser} from '../browser-custody.mjs';

const browserName=selectedBrowser();

const publicOutput=process.env.AUTH_E2E_OUTPUT || `.e2e/school-${Date.now()}`;
const describeError=error=>error instanceof AggregateError
  ? `${error.message}: ${error.errors.map(describeError).join('; ')}`
  : error.message ?? String(error);
const artifacts=await createArtifactRun(publicOutput);
const output=artifacts.raw;
try {
for(const variant of process.env.AUTH_E2E_MOBILE?['mobile']:['desktop','mobile']) {
  const dir=join(output,variant);
  await mkdir(dir,{recursive:true});
  const evidence={variant,browser:browserName,sourceHash:sourceFingerprint(),result:'failed',cleanup:'not-started',stage:'startup'};
  let runtime;
  let custody;
  try {
    runtime=await startSchoolAuth({expectedCommit:process.env.AUTH_E2E_EXPECT_COMMIT,artifacts});
    artifacts.add(runtime);
    evidence.commit=runtime.commit;
    evidence.cleanup='pending';
    evidence.stage='prepare';
    await runtime.prepare();
    evidence.stage='scenarios';
    custody=browserName!=='chromium'?await observeBrowserProfiles(browserName):undefined;
    const child=spawn(process.execPath,['node_modules/e2e/dist/cli/bin.js','run','--config','e2e.school.config.ts',...process.argv.slice(2)],{
      stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,CI:process.env.CI,
        AUTH_E2E_BROWSER:browserName,PLAYWRIGHT_BROWSERS_PATH:process.env.PLAYWRIGHT_BROWSERS_PATH,...custody?.env,
        AUTH_E2E_URL:runtime.origin,AUTH_E2E_CONTROL:runtime.controlOrigin,AUTH_SCHOOL_CONTROL:runtime.schoolOrigin,
        AUTH_E2E_OUTPUT:dir,AUTH_E2E_MOBILE:variant==='mobile'?'1':'',
        AUTH_SCHOOL_BREAK_ASSERTION:process.env.AUTH_SCHOOL_BREAK_ASSERTION || '',
        DO_NOT_TRACK:'1',E2E_TELEMETRY_DISABLED:'1',WRANGLER_SEND_METRICS:'false'},
    });
    let log='';
    for(const stream of [child.stdout,child.stderr]) stream.on('data',chunk=>{log+=chunk;custody?.observe();});
    const stop=()=>child.kill('SIGTERM');
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
    try {process.exitCode=await new Promise((r,j)=>{child.on('error',j);child.on('close',code=>r(code ?? 1));});}
    finally {process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
    await writeFile(join(dir,'runner.log'),log);
    if(custody) {
      evidence.browserSafety=await custody.readback(log);
      assert.ok(Object.values(evidence.browserSafety).every(Boolean),'School browser launch/profile cleanup was not safe');
    }
    evidence.stage='framework-report';
    const report=JSON.parse(await readFile(join(dir,'report.json'),'utf8'));
    evidence.runnerExitCode=process.exitCode;
    evidence.summary=report.run.summary;
    // e2e 0.21 may report passed/exit 0 with a failed provider cleanup.
    if (report.run.results.some(result => result.selected && result.attempts?.some(attempt =>
      attempt.cleanup === 'failed' || attempt.secondaryErrors?.some(error => error.phase === 'cleanup')))) {
      throw new Error('Browser provider cleanup failed in framework attempt evidence');
    }

    if(!report.run.summary.executed || report.run.summary.skipped || report.run.summary.interrupted) throw new Error('Empty/skipped/interrupted school suite');
    if(process.exitCode===0 && (report.run.summary.failed || report.run.status!=='passed')) throw new Error('Runner mismatch');
    evidence.stage='business-readback';
    evidence.workflows=await runtime.readWorkflows();
    if(!process.exitCode) {
      const end=Date.now()+90000;
      while(evidence.workflows.some(item=>item.status!=='complete') && Date.now()<end) {
        await new Promise(r=>setTimeout(r,200));evidence.workflows=await runtime.readWorkflows();
      }
      assert.ok(evidence.workflows.length,'No real recovery Workflow was observed');
      for(const item of evidence.workflows) {assert.equal(item.status,'complete');assert.equal(item.output?.cleanupComplete,true);}
      evidence.business=await runtime.diagnostics();
      assert.equal(evidence.business.credentials,0,'A test left school credentials after its unbind');
      assert.equal(evidence.business.bindingAddresses,0,'A test left a binding address after its unbind');
      for(const container of evidence.business.containers) {assert.equal(container.profiles,0);assert.equal(container.chromeProcesses,0);}
    }
    evidence.sourceUnchanged=evidence.sourceHash===sourceFingerprint();
    assert.equal(evidence.sourceUnchanged,true,'Source changed during the run');
    evidence.stage='complete';
  } catch(error) {
    evidence.failure={stage:evidence.stage,name:error.name,message:error.message};
    process.exitCode=1;
    console.error(`School suite failed during ${evidence.stage}; details retained in private artifacts`);
  } finally {
    if(custody) {
      try {await custody.close();}
      catch(error) {evidence.browserCleanupError=describeError(error);process.exitCode=1;}
    }
    if(runtime) {
      try {evidence.resources=await runtime.close();evidence.cleanup='passed';assert.equal(evidence.resources.directoryRemoved,true);}
      catch(error) {evidence.cleanup='failed';evidence.cleanupError=describeError(error);process.exitCode=1;}
    }
    if(runtime && !process.exitCode) evidence.result='passed';
    await writeFile(join(dir,'runtime.json'),JSON.stringify(evidence,null,2)+'\n');
    artifacts.outcome(evidence.result,evidence.cleanup);
  }
  if(process.exitCode) break;
}
  artifacts.finished();
} catch(error) {artifacts.failure(error);process.exitCode=1;} finally {
  const publication = await artifacts.publish();
  if (publication.publication !== 'scanned') process.exitCode = 1;
}
console.log(`Evidence: ${publicOutput}`);
