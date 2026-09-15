import {env,runInDurableObject} from 'cloudflare:test';
import {afterEach,expect,it,vi} from 'vitest';
import {DeviceV3Store} from '../../src/services/quicklogin/device-v3-store';
import {QuickloginAccountClient} from '../../src/services/quicklogin/account-client';
import {QuickloginLoginBrokerClient} from '../../src/services/quicklogin/login-broker-client';
import {validStorageState} from './helpers';
import type {DeviceAuthority,StoredDeviceSession} from '../../src/services/quicklogin/contracts';
import type {VersionTuple,Receipt} from '../../src/services/quicklogin/protocol-v3';
afterEach(()=>vi.restoreAllMocks());
async function withStore(test:(store:DeviceV3Store,authority:DeviceAuthority,tuple:VersionTuple,storage:DurableObjectStorage)=>Promise<void>){
 const now=Date.now(),id=crypto.randomUUID();
 const a:DeviceAuthority={ownerUserId:`user-${id}`,deviceId:id,grantId:'grant-test',generation:1,masterEnabled:true,enabled:true,allowed:true,reason:null,lastSeenAt:now};
 vi.spyOn(QuickloginAccountClient.prototype,'getDeviceAuthority').mockResolvedValue(a);
 vi.spyOn(QuickloginLoginBrokerClient.prototype,'getBindingSnapshot').mockResolvedValue({state:'bound',bindingEpoch:1,credentialRevision:1,bindingRevision:1,bindingTransitionId:null,credentialsState:'verified',evidenceKind:'first_factor_success',evidenceCredentialRevision:1,evidenceAt:now});
 const stub=env.CQU_QUICKLOGIN_DEVICE.get(env.CQU_QUICKLOGIN_DEVICE.idFromName(`receipt-${id}`));
 await runInDurableObject(stub,async(_,state)=>{
  const session:StoredDeviceSession={schemaVersion:1,ownerUserId:a.ownerUserId,deviceId:id,generation:1,bindingEpoch:1,credentialRevision:1,sessionVersion:1,state:'ready',loginAt:now,lastKeepAliveAt:now,storageState:JSON.stringify({...validStorageState(),cookies:validStorageState().cookies.map(c=>({...c,secure:true,httpOnly:true,sameSite:'Lax',expires:-1}))}),exportDigest:null,transientFailures:0,transientStartedAt:null,fastRetries:0,nextAttemptAt:null};
  await state.storage.put('session',session);
  await test(new DeviceV3Store(state.storage,env,async()=>{}),a,{deviceId:id,generation:1,bindingEpoch:1,credentialRevision:1,sessionVersion:1},state.storage);
 });
}
const report=(receipt:Receipt,seq:number)=>({protocolVersion:3,requestId:'request-test',client:{installationId:'install-test',extensionVersion:'0.2.0',buildId:'test',browserVersion:'152'},observed:null,reportEpoch:'report-test',clientReportSeq:seq,local:{enabledIntent:true,mode:'automatic',cookieState:'applied',receipt}});
const ack=(receipt:Receipt,seq:number)=>({protocolVersion:3,requestId:'request-test',reportEpoch:'report-test',clientReportSeq:seq,receipt});
it('never turns a rejected export into an accepted receipt through report and retry',async()=>withStore(async(store,a,tuple)=>{
 const receipt:Receipt={...tuple,exportId:'forged-export',result:'applied',verifiedAt:Date.now()};
 expect((await store.receipt(a,ack(receipt,1))).accepted).toBe(false);
 await store.report(a,report(receipt,1));
 expect((await store.receipt(a,ack(receipt,1))).accepted).toBe(false);
}));
it('validates and persists a renewed receipt even when its report arrived first',async()=>withStore(async(store,a,tuple,storage)=>{
 const exported=await store.export(a,tuple);
 const receipt:Receipt={...tuple,exportId:exported.exportId,result:'applied',verifiedAt:Date.now()};
 expect((await store.receipt(a,ack(receipt,1))).accepted).toBe(true);
 const renewed={...receipt,verifiedAt:receipt.verifiedAt!+1};
 await store.report(a,report(renewed,2));
 const accepted=await store.receipt(a,ack(renewed,2));
 expect(accepted.accepted).toBe(true);
 expect(await storage.get('v3:report')).toMatchObject({acknowledgedAt:expect.any(Number)});
 expect((await store.receipt(a,ack(renewed,2))).receivedAt).toBe(accepted.receivedAt);
}));
it('keeps explicit device interaction blocked and rejects automatic retry commands',async()=>withStore(async(store,a,tuple,storage)=>{
 const current=await storage.get<StoredDeviceSession>('session');
 await storage.put('session',{...current!,state:'needs_reauth',reasonCode:'INTERACTION_REQUIRED'});
 expect((await store.read(a)).session).toMatchObject({state:'needs_reauth',reasonCode:'INTERACTION_REQUIRED'});
 await expect(store.operation(a,{protocolVersion:3,requestId:'request-test',idempotencyKey:'no-captcha-loop',command:'retry_session',expected:tuple})).rejects.toMatchObject({code:'INTERACTION_REQUIRED'});
}));
