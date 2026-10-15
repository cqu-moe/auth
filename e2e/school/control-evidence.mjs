import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';

async function screenshots(dir) {
  let count=0;
  for(const item of await readdir(dir,{withFileTypes:true})) {
    count+=item.isDirectory()?await screenshots(join(dir,item.name)):Number(item.name.endsWith('.png'));
  }
  return count;
}

// School self-check receipts only; these checks do not run or replace a journey.
export async function checkSchoolControl(name,{dir,meta}) {
  assert.equal(meta.result,'failed');
  assert.equal(meta.cleanupError,undefined,'Unexpected runtime cleanup error');
  assert.equal(meta.artifactError,undefined,'Unexpected artifact error');
  if(name==='pin') {
    assert.equal(meta.stage,'startup');
    assert.equal(meta.cleanup,'not-started');
    assert.deepEqual(meta.failure,{stage:'startup',name:'Error',message:'Auth commit does not match the pinned dependency'});
    assert.equal(meta.resources,undefined,'Wrong pin allocated runtime resources');
    return;
  }
  assert.equal(meta.cleanup,'passed');
  assert.equal(meta.resources.directoryRemoved,true);
  if(name==='zero') {
    assert.equal(meta.stage,'scenarios');
    assert.equal(meta.failure?.stage,'scenarios');
    assert.equal(meta.failure?.name,'Error');
    assert.match(meta.failure.message,/^ENOENT: no such file or directory, open '.*\/mobile\/report\.json'$/);
    await assert.rejects(readFile(join(dir,'report.json')),{code:'ENOENT'});
    const log=(await readFile(join(dir,'runner.log'),'utf8')).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g,'');
    const errors=[...log.matchAll(/^\s*ERROR\s+([^\n]+)$/gm)].map(match=>match[1].trim().replace(/\s+/g,' '));
    assert.deepEqual(errors,['configuration error NO_TESTS (collection)'],'Zero control failed for an unrelated reason');
    const selection=log.match(/(\d+) tests were collected but none is runnable: \1 have titles matching none of \/\^AUTH03_ZERO_SELECTION\$\//);
    assert.ok(selection && Number(selection[1])>0,'Zero control did not collect and reject the requested selection');
    assert.match(log,/^\s*Tests\s+no tests executed\s*$/m);
    assert.match(log,/^\s*Errors\s+1 error\s*$/m);
    return;
  }
  assert.equal(name,'assertion','Unknown school control');
  assert.equal(meta.failure,undefined,'Unexpected runner failure');
  assert.equal(meta.sourceUnchanged,true);
  const {run}=JSON.parse(await readFile(join(dir,'report.json'),'utf8'));
  assert.equal(run.status,'failed');
  assert.equal(run.exitCode,1);
  assert.deepEqual(run.errors,[],'Unexpected framework run error');
  for(const [key,value] of Object.entries({selected:1,executed:1,passed:0,failed:1,interrupted:0,flaky:0,skipped:0})) {
    assert.equal(run.summary[key],value,`Unexpected ${key} count`);
  }
  const selected=run.results.filter(result=>result.selected);
  assert.equal(selected.length,1);
  const [test]=selected;
  const title='school binding persists and returns an allowed business directory through the real container';
  assert.equal(test.kind,'test');
  assert.equal(test.testId,`e2e/school/journey.school.ts::${encodeURIComponent(title)}`,'Unexpected selected school test');
  assert.equal(test.file,'e2e/school/journey.school.ts');
  assert.deepEqual(test.titlePath,[title]);
  assert.equal(test.targetId,'mobile');
  assert.equal(meta.stage,'complete');
  assert.equal(test.status,'failed');
  assert.equal(test.attempts.length,1);
  const [attempt]=test.attempts;
  assert.equal(attempt.status,'failed');
  assert.equal(attempt.cleanup,'complete','Browser attempt cleanup failed');
  assert.deepEqual(attempt.secondaryErrors,[],'Unexpected secondary error');
  assert.equal(attempt.error?.category,'test');
  assert.equal(attempt.error?.code,'ASSERTION_FAILED');
  assert.equal(attempt.error?.phase,'body');
  assert.match(attempt.error.message,/故意错误的学校绑定入口/);
  assert.deepEqual(attempt.error.details,{
    locator:'getByRole("heading", name: "欢迎回来")',
    expected:'text "故意错误的学校绑定入口"',observed:'text "欢迎回来"',matches:1,
  },'School control failed for an unrelated reason');
  for(const result of run.results) {
    if(!result.selected) assert.equal(result.attempts?.length ?? 0,0,'Unselected test executed');
  }
  assert.ok(await screenshots(dir),'No pre-secret failure screenshot retained');
}
