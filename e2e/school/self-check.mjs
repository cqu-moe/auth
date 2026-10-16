import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {checkSchoolControl} from './control-evidence.mjs';

const root=`.e2e/school-negative-${Date.now()}`;
await mkdir(root,{recursive:true});
const controls=[];
async function run(name,args,extra={}) {
  const dir=join(root,name);
  const child=spawn(process.execPath,['e2e/school/run.mjs',...args],{stdio:'inherit',env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,
    AUTH_E2E_MOBILE:'1',AUTH_E2E_OUTPUT:dir,E2E_TELEMETRY_DISABLED:'1',DO_NOT_TRACK:'1',WRANGLER_SEND_METRICS:'false',
    ...(process.env.AUTH_SCHOOL_DOCKER_SOCKET?{AUTH_SCHOOL_DOCKER_SOCKET:process.env.AUTH_SCHOOL_DOCKER_SOCKET}:{}),...extra}});
  const code=await new Promise((r,j)=>{child.on('error',j);child.on('exit',r);});
  assert.equal(code,1,`${name} unexpectedly succeeded`);
  const meta=JSON.parse(await readFile(join(dir,'mobile/runtime.json'),'utf8'));
  await checkSchoolControl(name,{dir:join(dir,'mobile'),meta});
  controls.push({name,innerExit:code,result:'passed',runtime:join(dir,'mobile/runtime.json'),cleanup:meta.cleanup});
}
await run('assertion',['--grep','^school binding'],{AUTH_SCHOOL_BREAK_ASSERTION:'1'});
await run('zero',['--grep','^AUTH03_ZERO_SELECTION$']);
await run('pin',[],{AUTH_E2E_EXPECT_COMMIT:'AUTH03_WRONG_COMMIT'});
await writeFile(join(root,'controls.json'),JSON.stringify({result:'passed',controls},null,2)+'\n');
console.log(`School negative controls passed; evidence: ${root}`);
