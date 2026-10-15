import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';

const root=`.e2e/school-negative-${Date.now()}`;
await mkdir(root,{recursive:true});
async function run(name,args,extra={}) {
  const dir=join(root,name);
  const child=spawn(process.execPath,['e2e/school/run.mjs',...args],{stdio:'inherit',env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,
    AUTH_E2E_MOBILE:'1',AUTH_E2E_OUTPUT:dir,E2E_TELEMETRY_DISABLED:'1',DO_NOT_TRACK:'1',WRANGLER_SEND_METRICS:'false',
    ...(process.env.AUTH_SCHOOL_DOCKER_SOCKET?{AUTH_SCHOOL_DOCKER_SOCKET:process.env.AUTH_SCHOOL_DOCKER_SOCKET}:{}),...extra}});
  const code=await new Promise((r,j)=>{child.on('error',j);child.on('exit',r);});
  assert.equal(code,1,`${name} unexpectedly succeeded`);
  const meta=JSON.parse(await readFile(join(dir,'mobile/runtime.json'),'utf8'));
  assert.equal(meta.result,'failed');
  return {dir,meta};
}
const negative=await run('assertion',['--grep','^school binding'],{AUTH_SCHOOL_BREAK_ASSERTION:'1'});
assert.equal(negative.meta.cleanup,'passed');
assert.equal(negative.meta.resources.directoryRemoved,true);
const report=JSON.parse(await readFile(join(negative.dir,'mobile/report.json'),'utf8'));
assert.equal(report.run.summary.failed,1);
assert.equal(report.run.summary.executed,1);
async function countScreenshots(dir) {
  let total=0;
  for(const item of await readdir(dir,{withFileTypes:true})) total+=item.isDirectory()?await countScreenshots(join(dir,item.name)):Number(item.name.endsWith('.png'));
  return total;
}
assert.ok(await countScreenshots(negative.dir),'No pre-secret failure screenshot retained');
const empty=await run('zero',['--grep','^AUTH03_ZERO_SELECTION$']);
assert.equal(empty.meta.cleanup,'passed');
const startup=await run('pin',[],{AUTH_E2E_EXPECT_COMMIT:'AUTH03_WRONG_COMMIT'});
assert.equal(startup.meta.failure.stage,'startup');
assert.equal(startup.meta.cleanup,'not-started');
console.log(`School negative controls passed; evidence: ${root}`);
