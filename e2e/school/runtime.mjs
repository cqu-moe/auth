import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { startAuth } from '../runtime.mjs';
import { prepareAccount } from '../prepare-account.mjs';
import { prepareSchoolAdmin } from './admin.mjs';
import { browserBase } from './image.mjs';

const docker = args => execFileSync('docker', args, {encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const pause = ms => new Promise(r=>setTimeout(r,ms));
const describeError = error => error instanceof AggregateError
  ? `${error.message}: ${error.errors.map(describeError).join('; ')}`
  : `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`;
const containerEgressImage = process.env.MINIFLARE_CONTAINER_EGRESS_IMAGE
  ?? 'cloudflare/proxy-everything:3cb1195@sha256:0ef6716c52430096900b150d84a3302057d6cd2319dae7987128c85d0733e3c8';
const imageExists = ref => {
  try { docker(['image','inspect',ref]); return true; }
  catch { return false; }
};

export async function startSchoolAuth(options = {}) {
  const commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  if(options.expectedCommit && options.expectedCommit!==commit) throw new Error('Auth commit does not match the pinned dependency');
  if(options.expectedCommit && execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()) throw new Error('Pinned school runtime requires a clean checkout');
  const consumerNames=new Set();
  const fixtureDirectory=resolve(options.fixtureDirectory ?? 'e2e/school');
  const fixtureHash=createHash('sha256').update(readFileSync(join(fixtureDirectory,'school.py'))).digest('hex');
  const runId = randomUUID();
  const image = `auth-school-fixture:${runId}`;
  const base=browserBase();
  const rawDockerSocket=process.env.AUTH_SCHOOL_DOCKER_SOCKET || docker(['context','inspect','--format','{{.Endpoints.docker.Host}}']).replace(/^unix:\/\//,'');
  const dockerSocket=rawDockerSocket.startsWith('/') ? `unix://${rawDockerSocket}` : rawDockerSocket;
  // workerd reports a cold local Docker image cache only as "Container failed
  // to start". Materialize the pinned interceptor before building this run's
  // disposable fixture image so startup failures remain fixture failures.
  if (!imageExists(containerEgressImage)) docker(['pull',containerEgressImage]);
  const secrets = new Set(['School-synthetic-123!','Synthetic-only-123!','synthetic-rpc-secret']);
  const users = new Map();
  const used = new Set();
  const errors = [];
  const deliveries = [];
  const runtimeLog = [];
  const redactDiagnostic = text => [...secrets].reduce((value,secret) => value.split(secret).join('[synthetic-secret-redacted]'),text);
  let runtime, mf, db, caller, control, admin, evidence, runtimeOptions, refreshAuthBindings, deliver, polling = false, timer;
  docker(['image','inspect',base]);
  docker(['build','--platform','linux/amd64','--build-context',`school-fixture=${fixtureDirectory}`,
    '--build-arg',`BASE=${base}`,'--build-arg',`RUN_ID=${runId}`,'-t',image,'-f','e2e/school/Dockerfile','.']);
  const imageId=docker(['image','inspect','--format','{{.Id}}',image]);
  async function school(userId, path, body) {
    used.add(userId);
    const ns = await mf.getDurableObjectNamespace('CQU_LOGIN','auth-e2e');
    const response = await ns.get(ns.idFromName(userId)).fetch(`http://fixture/__fixture/${path}`,
      body === undefined ? {} : {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    if (!response.ok) {
      const detail = (await response.text()).slice(0,500);
      throw new Error(`School fixture transport failed (${response.status})${detail ? `: ${redactDiagnostic(detail)}` : ''}`);
    }
    return response.json();
  }
  async function privateCall(action,args) {
    const response = await caller.fetch('http://private/',{method:'POST',body:JSON.stringify({action,args})});
    if (!response.ok) throw new Error(`Private caller transport failed (${response.status})`);
    return response.json();
  }
  async function prepare({email='journey@example.test',password='Synthetic-only-123!'}={}) {
    if (users.has(email)) return {email,userId:users.get(email)};
    const account = await prepareAccount(runtime,{email,password});
    users.set(email,account.userId);
    await db.prepare("INSERT INTO user_entitlement(user_id,subsystem,capability,value) VALUES (?,'calendar','external','1')").bind(account.userId).run();
    return account;
  }
  const platform = {
    buildConfig:'e2e/school/wrangler.jsonc',
    bundleName:'worker.js',
    configure(base,dir) {
      const workers=typeof options.workers==='function'
        ? options.workers({authOrigin:base.bindings.BETTER_AUTH_URL,authWorkerName:base.name})
        : options.workers ?? [];
      if(!Array.isArray(workers)) throw new Error('Consumer workers must be an array');
      for(const worker of workers) {
        if(!worker.name || ['auth-e2e','school-private-caller'].includes(worker.name) || consumerNames.has(worker.name)) throw new Error('Each consumer Worker needs a unique non-Auth name');
        consumerNames.add(worker.name);
      }
      runtimeOptions = {
        host:base.host,port:base.port,log:base.log,d1Persist:base.d1Persist,
        handleRuntimeStdio(stdout,stderr) {
          for (const stream of [stdout,stderr]) {
            stream.on('data',chunk => {
              runtimeLog.push(redactDiagnostic(chunk.toString('utf8').trim()));
              while (runtimeLog.length > 400) runtimeLog.shift();
            });
          }
        },
        containerEngine:{localDocker:{socketPath:dockerSocket,containerEgressInterceptorImage:containerEgressImage}},
        durableObjectsPersist:join(dir,'do'), workflowsPersist:join(dir,'workflows'),
        workers:[{
          ...base,
          bindings: { ...base.bindings, ...options.authBindings },
          durableObjects:{...base.durableObjects,CQU_LOGIN:{className:'CquLoginContainer',useSQLite:true,container:{imageName:image}}},
          workflows:{CQU_SESSION_RECOVERY:{name:'cqu-session-recovery',className:'CquSessionRecoveryWorkflow'}},
          d1Databases:{...base.d1Databases,EVIDENCE:'workflow-evidence'},
        }, {
          name:'school-private-caller',modules:true,script:readFileSync('e2e/school/caller.js','utf8'),
          compatibilityDate:'2026-05-01',
          serviceBindings:{AUTH:{name:'auth-e2e',entrypoint:'AuthService'},MAIL:{name:'auth-e2e',entrypoint:'SyntheticSchoolMail'},OBSERVER:{name:'auth-e2e',entrypoint:'WorkflowObserver'}},
          outboundService:()=>{errors.push('private egress');return new Response(null,{status:502});},
        },...workers],
      };
      return runtimeOptions;
    },
    async ready(runtime) {
      ({mf,db,refreshBindings:refreshAuthBindings}=runtime);
      caller = await mf.getWorker('school-private-caller');
      evidence = await mf.getD1Database('EVIDENCE','auth-e2e');
      await evidence.prepare('CREATE TABLE workflows(id TEXT PRIMARY KEY)').run();
      await evidence.prepare('CREATE TABLE browser_outcomes(id INTEGER PRIMARY KEY,ok INTEGER,code TEXT,phase TEXT)').run();
      control = createServer(async (req,res) => {
        try {
          const url = new URL(req.url,'http://127.0.0.1');
          let body = ''; for await (const chunk of req) body += chunk;
          const input = body ? JSON.parse(body) : {};
          const email = input.email || url.searchParams.get('email') || 'journey@example.test';
          if (url.pathname === '/prepare') {
            await prepare({email});res.setHeader('content-type','application/json');res.end(JSON.stringify({email}));return;
          }
          const userId = users.get(email);
          if (!userId) throw new Error('Unknown synthetic account');
          let value;
          if (url.pathname === '/fixture') value = await school(userId,'control',input.changes);
          else if (url.pathname === '/ban') value = await admin.ban(userId,input.banned);
          else if (url.pathname === '/deliveries') value = deliveries.filter(item=>item.userId===userId).map(({accepted,reason})=>({accepted,reason}));
          else if (url.pathname === '/outcomes') value = (await evidence.prepare('SELECT ok,code,phase FROM browser_outcomes ORDER BY id').all()).results;
          else if (url.pathname === '/directory') value = await privateCall('directory',{
            clientId:input.unapproved ? 'school-unapproved' : 'school-calendar',clientSecret:'synthetic-rpc-secret',userId,
            ...(input.recipe?.kind==='instructors'?{}:{kind:'catalog',sourceType:'course_catalog'}),expectedSessionId:'202610',...input.recipe,
          });
          else if (url.pathname === '/workflows') {
            const rows = await evidence.prepare('SELECT id FROM workflows').all();
            value = await Promise.all(rows.results.map(row=>privateCall('workflow',{id:row.id})));
          } else if (url.pathname === '/entitlement') {
            value = await admin.entitlement(userId,input.enabled);
          } else throw new Error('Unknown school control');
          res.setHeader('content-type','application/json');res.end(JSON.stringify(value));
        } catch(error) {res.writeHead(500,{'content-type':'application/json'}).end(JSON.stringify({error:redactDiagnostic(describeError(error))}));}
      });
      await new Promise(r=>control.listen(0,'127.0.0.1',r));
      deliver = async () => {
        if (polling) return;
        polling = true;
        try {
          for (const userId of users.values()) {
            const address = await db.prepare("SELECT token FROM cqu_bind_addresses WHERE user_id=? AND status IN ('pending','active')").bind(userId).first();
            if (!address) continue;
            // The school can send only to the actual address produced by the wizard.
            secrets.add(address.token);
            for (const message of await school(userId,'mail')) {
              secrets.add(message.code);
              const result = await privateCall('mail',{...message,to:`${address.token}@example.test`});
              deliveries.push({userId,...result});
              if (!result.accepted) {
                // Unbind can commit while external mail is waiting. Accept only
                // the production inactive-binding refusal, confirmed by D1 now.
                const current=await db.prepare("SELECT token FROM cqu_bind_addresses WHERE user_id=? AND status IN ('pending','active')").bind(userId).first();
                if(result.reason!=='inactive binding' || current?.token===address.token) throw new Error('School message rejected');
              }
            }
          }
        } catch(error) {errors.push(error.message);}
        finally {polling=false;}
      };
      timer = setInterval(()=>void deliver(),200);
      return {origin:`http://127.0.0.1:${control.address().port}`};
    },
    async beforeClose() {
      clearInterval(timer);
      while (polling) await pause(20);
    },
    async close() {
      if (control?.listening) await new Promise((r,j)=>control.close(e=>e?j(e):r()));
      const remaining = docker(['ps','-aq','--filter',`ancestor=${image}`]);
      // The local engine stops instances but can retain exited Docker objects.
      // Reclaim only this run's unique image, then independently check absence.
      if (remaining) {
        docker(['rm','-f',...remaining.split('\n')]);
      }
      if (docker(['ps','-aq','--filter',`ancestor=${image}`])) throw new Error('School container cleanup failed');
      docker(['image','rm',image]);
      if (errors.length) throw new Error(`School cleanup/transport failed: ${[...new Set(errors)].join('; ')}`);
      return {containerObjectsRemoved:true,fixtureImageRemoved:true,imageId,base,fixtureHash,
        runtimeLog:runtimeLog.map(redactDiagnostic)};
    },
  };
  runtime = await startAuth({...options,platform});
  try {
  admin = await prepareSchoolAdmin(runtime);
  // The harness grants only legitimate caller/admin prerequisites, never binding/session outcomes.
  for (const [clientId,methods] of [['school-calendar',['cquExternalSearch']],['school-unapproved',[]]]) {
    await runtime.db.prepare('INSERT INTO oauthClient(id,clientId,clientSecret,redirectUris,metadata) VALUES (?,?,?,?,?)')
      .bind(clientId,clientId,createHash('sha256').update('synthetic-rpc-secret').digest('base64url'),'["https://schedule.example.test/callback"]',JSON.stringify({subsystem:'calendar',rpcMethods:methods})).run();
  }
  return {
    ...runtime,
    get db() { return db; },
    schoolOrigin:runtime.support.origin,
    prepare,
    async updateConsumerBindings(name,bindings) {
      if(!consumerNames.has(name)) throw new Error('Unknown consumer Worker');
      if(!bindings || typeof bindings!=='object' || Array.isArray(bindings)) throw new TypeError('Consumer bindings must be an object');
      clearInterval(timer);
      while(polling) await pause(20);
      const nextOptions={...runtimeOptions,workers:runtimeOptions.workers.map(worker=>worker.name===name
        ? {...worker,bindings:{...worker.bindings,...bindings}} : worker)};
      try {
        await mf.setOptions(nextOptions);
        await mf.ready;
        runtimeOptions=nextOptions;
        // setOptions invalidates every Miniflare handle, including the private
        // mail pump and Auth control server's D1; retain their persisted state.
        await refreshAuthBindings();
        db=runtime.db;
        caller=await mf.getWorker('school-private-caller');
        evidence=await mf.getD1Database('EVIDENCE','auth-e2e');
        timer=setInterval(()=>void deliver(),200);
      } catch(error) {
        errors.push('Consumer Worker reconfiguration failed');
        throw error;
      }
    },
    async getWorker(name) {
      if(!consumerNames.has(name)) throw new Error('Unknown consumer Worker');
      return mf.getWorker(name);
    },
    async getD1Database(binding,workerName) {
      if(!consumerNames.has(workerName)) throw new Error('Unknown consumer Worker');
      return mf.getD1Database(binding,workerName);
    },
    async redact(output) {
      let redactions = 0;
      async function visit(dir) {
        for (const item of await readdir(dir,{withFileTypes:true})) {
          const path=join(dir,item.name);
          if (item.isDirectory()) await visit(path);
          else if (/\.(json|md|log|txt)$/.test(item.name)) {
            let content=await readFile(path,'utf8');
            for (const value of secrets) {
              if (content.includes(value)) {content=content.split(value).join('[synthetic-secret-redacted]');redactions++;}
            }
            await writeFile(path,content);
          }
        }
      }
      await visit(output);
      return redactions;
    },
    async readWorkflows() {
      const evidence = await mf.getD1Database('EVIDENCE','auth-e2e');
      const rows=await evidence.prepare('SELECT id FROM workflows').all();
      return Promise.all(rows.results.map(async row=>{
        const {id,status,output}=await privateCall('workflow',{id:row.id});
        return {id,status,output};
      }));
    },
    async diagnostics() {
      const evidence = await mf.getD1Database('EVIDENCE','auth-e2e');
      const containers=[];
      for(const userId of [...used]) {
        const {profiles,chromeProcesses}=await school(userId,'control');
        containers.push({profiles,chromeProcesses});
      }
      return {
        containers,
        transportErrors:[...new Set(errors)],
        deliveries:deliveries.map(({accepted,reason})=>({accepted,reason})),
        browserOutcomes:(await evidence.prepare('SELECT ok,code,phase FROM browser_outcomes ORDER BY id').all()).results,
        credentials:await db.prepare('SELECT count(*) AS n FROM cqu_credentials').first('n'),
        bindingAddresses:await db.prepare('SELECT count(*) AS n FROM cqu_bind_addresses').first('n'),
      };
    },
  };
  } catch(error) {await runtime.close();throw error;}
}
