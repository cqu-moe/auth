import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,mkdtemp,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {startSchoolAuth} from './runtime.mjs';
import {prepareSchoolBinding} from './prepare-binding.mjs';

const output=`.e2e/school-consumer-${Date.now()}`;
const consumerScript=await readFile('e2e/school/consumer-worker.js','utf8');
await mkdir(output,{recursive:true});
const fixtureDirectory=await mkdtemp(resolve('.auth-e2e-consumer-fixture-'));
try {
await writeFile(join(fixtureDirectory,'school.py'),(await readFile('e2e/school/school.py','utf8')).replaceAll('合成电路','调用仓合成课程'));
for(let run=1;run<=2;run++) {
  const runtime=await startSchoolAuth({expectedCommit:process.env.AUTH_E2E_EXPECT_COMMIT,
    fixtureDirectory,
    workers:(({authOrigin,authWorkerName})=>[{name:'school-consumer',modules:true,script:consumerScript,
      compatibilityDate:'2026-05-01',d1Databases:{SCHEDULE_DB:'school-consumer-db'},
      bindings:{AUTH_ORIGIN:authOrigin,AUTH_CLIENT_ID:'school-calendar',AUTH_CLIENT_SECRET:'synthetic-rpc-secret'},
      serviceBindings:{AUTH:{name:authWorkerName,entrypoint:'AuthService'},AUTH_HTTP:{name:authWorkerName}},
      outboundService:()=>{throw new Error('Unexpected consumer egress');},
    }]),
  });
  const evidence={run,commit:runtime.commit,cleanup:'pending'};
  try {
    const consumer=await runtime.getWorker('school-consumer');
    const consumerDb=await runtime.getD1Database('SCHEDULE_DB','school-consumer');
    const account=await prepareSchoolBinding(runtime,{email:'consumer@example.test',password:'Synthetic-only-123!'});
    const login=await fetch(`${runtime.origin}/api/v1/auth/sign-in/email`,{method:'POST',signal:AbortSignal.timeout(15000),
      headers:{origin:runtime.origin,'content-type':'application/json'},body:JSON.stringify({email:account.email,password:account.password})});
    assert.equal(login.status,200);
    const cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
    await login.arrayBuffer();
    const binding=await (await fetch(`${runtime.origin}/api/v1/cqu/binding`,{headers:{cookie}})).json();
    assert.equal(binding.data.bindStatus,'active');assert.equal(binding.data.sessionStatus.status,'active');
    const business=await consumer.fetch('http://consumer/import',{method:'POST',headers:{cookie}});
    assert.equal(business.status,200);
    const result=await business.json();
    assert.deepEqual(result.items,[{id:'31',name:'调用仓合成课程',extra:'SYN101',courseCode:'SYN101'}]);
    assert.deepEqual((await consumerDb.prepare('SELECT id,name,code FROM imported_course').all()).results,
      [{id:'31',name:'调用仓合成课程',code:'SYN101'}]);
    const removed=await fetch(`${runtime.origin}/api/v1/cqu/binding`,{method:'DELETE',headers:{cookie,origin:runtime.origin}});
    assert.equal(removed.status,204);
    const after=await (await fetch(`${runtime.origin}/api/v1/cqu/binding`,{headers:{cookie}})).json();
    assert.equal(after.data.bindStatus,'unbound');
    const denied=await consumer.fetch('http://consumer/import',{method:'POST',headers:{cookie}});
    assert.equal(denied.status,403);assert.deepEqual(await denied.json(),{error:'NO_CQU_BINDING'});
    evidence.business='independent login, composed Worker→AuthService→container→own D1 readback and post-unbind refusal passed';
  } finally {
    evidence.resources=await runtime.close();evidence.cleanup='passed';
    await writeFile(`${output}/run-${run}.json`,JSON.stringify(evidence,null,2)+'\n');
    await runtime.redact(output);await runtime.checkArtifacts(output);
  }
}
} finally {await rm(fixtureDirectory,{recursive:true,force:true});}
console.log(`School consumer helper passed twice; evidence: ${output}`);
