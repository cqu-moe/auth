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
async function control(runtime,path,body) {
  const response=await fetch(`${runtime.schoolOrigin}${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal(response.status,200);return response.json();
}
async function until(read,match) {
  const end=Date.now()+90000;
  do {const value=await read();if(match(value)) return value;await new Promise(r=>setTimeout(r,100));} while(Date.now()<end);
  throw new Error('Consumer school delivery state did not arrive');
}
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
    let consumer=await runtime.getWorker('school-consumer');
    let consumerDb=await runtime.getD1Database('SCHEDULE_DB','school-consumer');
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
    // Real Auth already owns an active session/Container DO and the consumer has
    // committed its import. Reloading only a generated binding must retain both.
    await runtime.updateConsumerBindings('school-consumer',{
      EXTERNAL_DIRECTORY_USER_ID:'wrong-synthetic-user',CONSUMER_LABEL:'updated consumer',
    });
    consumer=await runtime.getWorker('school-consumer');
    consumerDb=await runtime.getD1Database('SCHEDULE_DB','school-consumer');
    assert.deepEqual((await consumerDb.prepare('SELECT id,name,code FROM imported_course').all()).results,
      [{id:'31',name:'调用仓合成课程',code:'SYN101'}]);
    const mismatched=await consumer.fetch('http://consumer/import',{method:'POST',headers:{cookie}});
    assert.equal(mismatched.status,403);
    assert.deepEqual(await mismatched.json(),{error:'DIRECTORY_USER_MISMATCH'});
    await runtime.updateConsumerBindings('school-consumer',{EXTERNAL_DIRECTORY_USER_ID:account.userId});
    consumer=await runtime.getWorker('school-consumer');
    consumerDb=await runtime.getD1Database('SCHEDULE_DB','school-consumer');
    const reloaded=await consumer.fetch('http://consumer/import',{method:'POST',headers:{cookie}});
    assert.equal(reloaded.status,200);
    const reloadedResult=await reloaded.json();
    assert.deepEqual(reloadedResult,{items:result.items,directoryUserId:account.userId,consumerLabel:'updated consumer'});
    assert.deepEqual((await consumerDb.prepare('SELECT id,name,code FROM imported_course').all()).results,
      [{id:'31',name:'调用仓合成课程',code:'SYN101'}]);
    assert.equal(await runtime.db.prepare('SELECT email FROM user WHERE id=?').bind(account.userId).first('email'),account.email);
    assert.ok((await control(runtime,'/outcomes',{email:account.email})).length>0);
    await runtime.prepare({email:'after-reconfigure@example.test',password:'Synthetic-only-123!'});
    for (const name of ['auth-e2e','school-private-caller','unknown-consumer']) {
      await assert.rejects(runtime.updateConsumerBindings(name,{EXTERNAL_DIRECTORY_USER_ID:account.userId}),/Unknown consumer Worker/);
    }
    evidence.reconfiguration={mismatchedUserDenied:true,generatedAuthUserAccepted:true,
      consumerD1Preserved:true,authIdentityAndSchoolSessionPreserved:true,cumulativeBindingsPreserved:true,
      freshAccountPreparationPassed:true,workerWhitelistEnforced:true};
    await control(runtime,'/fixture',{email:account.email,changes:{expire:true,holdMail:true,clearEvents:true}});
    const expired=await consumer.fetch('http://consumer/import',{method:'POST',headers:{cookie}});
    assert.equal(expired.status,403);assert.deepEqual(await expired.json(),{error:'TGT_EXPIRED'});
    await until(()=>control(runtime,'/fixture',{email:account.email}),value=>['mail_held','code_requested'].every(kind=>value.events.some(event=>event.kind===kind)));
    const removed=await fetch(`${runtime.origin}/api/v1/cqu/binding`,{method:'DELETE',headers:{cookie,origin:runtime.origin}});
    assert.equal(removed.status,204);
    const after=await (await fetch(`${runtime.origin}/api/v1/cqu/binding`,{headers:{cookie}})).json();
    assert.equal(after.data.bindStatus,'unbound');
    await control(runtime,'/fixture',{email:account.email,changes:{holdMail:false}});
    const deliveries=await until(()=>control(runtime,'/deliveries',{email:account.email}),value=>value.some(item=>item.accepted===false));
    assert.deepEqual(deliveries.at(-1),{accepted:false,reason:'inactive binding'});
    const denied=await consumer.fetch('http://consumer/import',{method:'POST',headers:{cookie}});
    assert.equal(denied.status,403);assert.deepEqual(await denied.json(),{error:'NO_CQU_BINDING'});
    evidence.business='independent login, composed Worker→AuthService→container→own D1 readback, delayed school mail refusal and post-unbind refusal passed';
  } finally {
    evidence.resources=await runtime.close();evidence.cleanup='passed';
    await writeFile(`${output}/run-${run}.json`,JSON.stringify(evidence,null,2)+'\n');
    await runtime.redact(output);await runtime.checkArtifacts(output);
  }
}
} finally {await rm(fixtureDirectory,{recursive:true,force:true});}
console.log(`School consumer helper passed twice; evidence: ${output}`);
