import { CquQuickloginDeviceDO } from "../../src/durable-objects/cqu-quicklogin-device";
import { CquSessionDO } from "../../src/durable-objects/cqu-session";
import { env, runInDurableObject } from 'cloudflare:test';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { QuickloginAccountClient } from '../../src/services/quicklogin/account-client';
import { QuickloginDeviceClient } from '../../src/services/quicklogin/device-client';
import { QuickloginLoginBrokerClient } from '../../src/services/quicklogin/login-broker-client';
import { readStorage, seedSession, seedCredentials, validStorageState, spyBrowserFetch } from './helpers';
import { snapshotV3 } from '../../src/services/quicklogin/snapshot-v3';
import { tupleForSnapshot } from '../../src/services/quicklogin/protocol-v3';
beforeEach(() => { vi.spyOn(CquQuickloginDeviceDO.prototype, "alarm").mockResolvedValue(); vi.spyOn(CquSessionDO.prototype, "alarm").mockResolvedValue(); });
afterEach(() => vi.restoreAllMocks());
async function setup() {
 const userId = `v3-${crypto.randomUUID()}`, accounts = new QuickloginAccountClient(env);
 await accounts.initializeQuickloginPolicy(userId, { migrationId: userId, deviceLimit: 2, masterEnabled: true });
 const grant = await accounts.createPendingGrant(userId, 'test-client', Date.now());
 await accounts.activateGrant(userId, grant.grantId, Date.now());
 const device = await accounts.registerDevice(userId, grant.grantId, { deviceName: 'Test Chrome', browserFamily: 'chrome', browserVersion: '152' });
 const authority = await accounts.setDeviceEnabled(userId, device.deviceId, true);
 const devices = new QuickloginDeviceClient(env); await devices.notifyDevice(authority);
 const stub = env.CQU_QUICKLOGIN_DEVICE.get(env.CQU_QUICKLOGIN_DEVICE.idFromName(`${userId}:${device.deviceId}`));
 const bindingStub = env.CQU_SESSION.get(env.CQU_SESSION.idFromName(userId));
 await seedSession(bindingStub, { userId }); await seedCredentials(bindingStub);
 await runInDurableObject(bindingStub, async (_, state) => { const value: any = await state.storage.get('state'); await state.storage.put('state', { ...value, userId }); });
 await accounts.heartbeat(userId, device.deviceId, { protocolVersion: 2, appliedVersion: null, observedGeneration: authority.generation, browserVersion: '152' }, null, Date.now());
 await runInDurableObject(stub, async (_, state) => state.storage.deleteAlarm());
 const call = async (operation: string, payload: Record<string, unknown> = {}) => {
  const response = await stub.fetch('https://device/internal', { method: 'POST', body: JSON.stringify({ operation, ownerUserId: userId, deviceId: device.deviceId, payload: { authority, ...payload } }) });
  return response.json<any>();
 };
 return { userId, accounts, authority, device, devices, stub, call, bindingStub };
}
const client = { installationId: 'install-test', extensionVersion: '0.2.0', buildId: 'test', browserVersion: '152' };
const exportableV3StorageState = (marker = 'v3') => JSON.stringify({
 ...validStorageState(),
 cookies: validStorageState().cookies.map(cookie => ({
  ...cookie, value: `${cookie.value}-${marker}`, secure: true, httpOnly: true, sameSite: 'Lax', expires: -1,
 })),
});
describe('QuickLogin protocol 3 durable device state', () => {
 it('recovers legacy needs_reauth once from current binding without inventing rejected evidence', async () => {
  const t = await setup();
  await runInDurableObject(t.stub, async (_, state) => { const session: any = await state.storage.get('session'); await state.storage.put('session', { ...session, state: 'needs_reauth' }); });
  const value = await t.call('v3_read');
  expect(value.result.session.state).toBe('preparing');
  expect(value.result.session.reasonCode).toBeNull();
 });
 it('persists broker reason and respects the authoritative retry delay', async () => {
  const t = await setup();
  vi.spyOn(QuickloginLoginBrokerClient.prototype, 'quickloginLogin').mockResolvedValue({ kind: 'temporary_unavailable', retryAfterMs: 600_000, reasonCode: 'OTP_SEND_FAILED' } as any);
  await runInDurableObject(t.stub, async (instance, state) => { const session: any = await state.storage.get('session'); await (instance as any).performLogin(session, t.authority); });
  const value = await t.call('v3_read');
  expect(value.result.session.reasonCode).toBe('OTP_SEND_FAILED');
  expect(value.result.session.nextAttemptAt).toBeGreaterThan(Date.now() + 590_000);
 });
 it('deduplicates an operation and rejects reusing its key for another command', async () => {
  const t = await setup();
  const expected = { deviceId: t.device.deviceId, generation: t.authority.generation, bindingEpoch: 0, credentialRevision: 0, sessionVersion: 0 };
  const input = { protocolVersion: 3, requestId: 'r', command: 'ensure_session', idempotencyKey: 'command-a', expected };
  const a = await t.call('v3_operation', { input });
  expect(a.result.operationId).toBeTypeOf('string');
  expect((await t.call('v3_operation', { input })).result.operationId).toBe(a.result.operationId);
  expect((await t.call('v3_operation', { input: { ...input, command: 'retry_session' } })).error.code).toBe('IDEMPOTENCY_CONFLICT');
 });
 it('registers exports and only acknowledges matching issued exports once without report rollback', async () => {
  const t = await setup();
  await runInDurableObject(t.stub, async (_, state) => { const session: any = await state.storage.get('session'); await state.storage.put('session', { ...session, state: 'ready', sessionVersion: 1, loginAt: Date.now(), lastKeepAliveAt: Date.now(), storageState: JSON.stringify({ ...validStorageState(), cookies: validStorageState().cookies.map(c => ({ ...c, secure: true, httpOnly: true, sameSite: "Lax", expires: -1 })) }) }); });
  const expected = { deviceId: t.device.deviceId, generation: t.authority.generation, bindingEpoch: 0, credentialRevision: 0, sessionVersion: 1 };
  const exported = await t.call('v3_export', { expected });
  expect(exported.error).toBeUndefined();
  expect(exported.result.exportId).toBeTypeOf('string');
  const receipt = { ...expected, exportId: exported.result.exportId, result: 'applied', verifiedAt: Date.now() };
  const input = { protocolVersion: 3, requestId: 'r', reportEpoch: t.authority.grantId, clientReportSeq: 2, receipt };
  expect((await t.call('v3_receipt', { input })).result.accepted).toBe(true);
  expect((await t.call('v3_receipt', { input })).result.accepted).toBe(true);
  expect((await t.call('v3_receipt', { input: { ...input, clientReportSeq: 3, receipt: { ...receipt, exportId: 'forged' } } })).result.accepted).toBe(false);
  await t.call('v3_report', { input: { protocolVersion: 3, requestId: 'r', client, observed: null, reportEpoch: t.authority.grantId, clientReportSeq: 1, local: { enabledIntent: true, mode: 'automatic', cookieState: 'missing', receipt: null } } });
  expect((await t.call('v3_read')).result.report.cookieState).toBe('applied');
  expect((await t.call('v3_export', { expected: { ...expected, sessionVersion: 0 } })).error.code).toBe('SESSION_CHANGED');
 });

 it.each([[3, false, false], [3, true, false], [3, true, true], [7, true, false]] as const)('settles pending probes without blocking renewal at age %ih (receipt unavailable=%s, earlier alarm=%s)', async (ageHours, receiptUnavailable, earlierAlarm) => {
  const now = Date.now() + 1_000_000;
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const t = await setup();
  const loginAt = now - ageHours * 60 * 60_000;
  const storageState = exportableV3StorageState('pending-settle');
  const renewedState = exportableV3StorageState('new-login');
  await runInDurableObject(t.stub, async (_, state) => {
   const session: any = await state.storage.get('session');
   await state.storage.put('session', {
    ...session, state: 'ready', sessionVersion: 1, loginAt, lastKeepAliveAt: loginAt,
    storageState: exportableV3StorageState('before-pending'),
    pendingKeepaliveMint: { operationId: 'experiment-pending', mintedAt: now - 1_000, expiresAt: now + 60_000, hasStorageState: true },
   });
   await state.storage.put('pendingKeepaliveState', storageState);
   await state.storage.put('v3:client', client);
   await state.storage.setAlarm(now);
  });
  vi.mocked(CquQuickloginDeviceDO.prototype.alarm).mockRestore();
  const fetchMock = spyBrowserFetch({});
  const confirm = vi.spyOn(QuickloginLoginBrokerClient.prototype, 'recordQuickloginKeepaliveMint').mockResolvedValue();
  const login = vi.spyOn(QuickloginLoginBrokerClient.prototype, 'quickloginLogin').mockResolvedValue({
   kind: 'success', bindingEpoch: 0, credentialRevision: 0, loginAt: now, storageState: renewedState,
  });
  if (receiptUnavailable) confirm.mockRejectedValue(new Error('audit unavailable'));
  const alarm = runInDurableObject(t.stub, async (instance, state) => {
   await state.storage.deleteAlarm();
   if (earlierAlarm) await state.storage.setAlarm(now + 30_000);
   await (instance as unknown as { alarm(): Promise<void> }).alarm();
  });
  if (receiptUnavailable && ageHours < 7) {
   await expect(alarm).rejects.toThrow('audit unavailable');
   const pending = await readStorage<{reloginAt: number}>(t.stub, 'session');
   expect(pending).toHaveProperty('pendingKeepaliveMint');
   await expect(runInDurableObject(t.stub, (_, state) => state.storage.getAlarm()))
    .resolves.toBe(earlierAlarm ? now + 30_000 : pending!.reloginAt);
   expect(login).not.toHaveBeenCalled();
   expect(fetchMock).not.toHaveBeenCalled();
   return;
  }
  await alarm;
  expect(confirm).toHaveBeenCalledTimes(ageHours === 7 ? 0 : 1);
  expect(login).toHaveBeenCalledTimes(ageHours === 7 ? 1 : 0);
  expect(fetchMock).not.toHaveBeenCalled();
  const settled = await readStorage<Record<string, unknown>>(t.stub, 'session');
  expect(settled).toMatchObject({
   state: 'ready', loginAt: ageHours === 7 ? now : loginAt,
   lastKeepAliveAt: ageHours === 7 ? now : now - 1_000,
   storageState: ageHours === 7 ? renewedState : storageState,
  });
  expect(settled).not.toHaveProperty('pendingKeepaliveMint');
  const reloginAt = settled?.reloginAt;
  expect(reloginAt).toBeTypeOf('number');
  if (typeof reloginAt !== 'number') throw new Error('missing persisted reloginAt');
  await expect(runInDurableObject(t.stub, (_, state) => state.storage.getAlarm()))
   .resolves.toBe(reloginAt);
 });
});

describe('QuickLogin v3 registration recovery', () => {
 it('replaces the selected grant once without creating another device or permitting ticket replay', async () => {
  const t = await setup();
  const accountStub = env.CQU_QUICKLOGIN_ACCOUNT.get(env.CQU_QUICKLOGIN_ACCOUNT.idFromName(t.userId));
  const call = async (operation: string, payload: unknown) => {
   const r = await accountStub.fetch('http://account/internal', { method: 'POST', body: JSON.stringify({ operation, ownerUserId: t.userId, payload }) }); return r.json<any>();
  };
  const ticket = await call('v3_resume_ticket', { deviceId: t.device.deviceId });
  expect(ticket.result.resumeTicket).toBeTypeOf('string');
  const grant = await t.accounts.createPendingGrant(t.userId, 'test-client', Date.now());
  await t.accounts.activateGrant(t.userId, grant.grantId, Date.now());
  const input = { protocolVersion: 3, requestId: 'r', registrationId: 'reg-new', client, deviceName: 'Chrome', resumeTicket: ticket.result.resumeTicket, deviceId: t.device.deviceId };
  const registered = await call('v3_registration', { grantId: grant.grantId, input });
  expect(registered.result.deviceId).toBe(t.device.deviceId);
  expect((await call('v3_registration', { grantId: grant.grantId, input })).result.deviceId).toBe(t.device.deviceId);
  expect((await t.accounts.listDevices(t.userId, Date.now())).devices).toHaveLength(1);
  await expect(t.accounts.assertGrant(t.userId, t.authority.grantId, 'test-client')).rejects.toThrow('DEVICE_REVOKED');
  const other = await t.accounts.createPendingGrant(t.userId, 'test-client', Date.now()); await t.accounts.activateGrant(t.userId, other.grantId, Date.now());
  expect((await call('v3_registration', { grantId: other.grantId, input: { ...input, registrationId: 'reg-replay' } })).error.code).toBe('FORBIDDEN');
 });
});

describe('staged binding updates', () => {
 it('keeps committed credentials during validation and rolls back a failed transition', async () => {
  const t = await setup();
  await runInDurableObject(t.bindingStub, async (instance, state) => {
   const before = await state.storage.get('credentials');
   const original = (instance as any).initSession;
   (instance as any).initSession = async () => {
    expect(await state.storage.get('credentials')).toEqual(before);
    expect((await (instance as any).getBindingSnapshot()).state).toBe('updating');
    return { success: false, error: 'synthetic validation failure' };
   };
   try {
    const response = await instance.fetch!(new Request('https://session/init', { method: 'POST', body: JSON.stringify({ userId: t.userId, studentId: '2020000001', encryptedPassword: 'candidate-only', iv: 'candidate-iv' }) }));
    expect((await response.json<any>()).success).toBe(false);
    expect(await state.storage.get('credentials')).toEqual(before);
    expect(await state.storage.get('bindingTransition')).toBeUndefined();
    expect((await (instance as any).getBindingSnapshot()).state).toBe('bound');
   } finally { (instance as any).initSession = original; }
  });
 });
});

it('validates pending credentials without importing the valid old main-session seed', async () => {
 const t = await setup();
 await runInDurableObject(t.bindingStub, async (instance, state) => {
  const before = await state.storage.get('credentials');
  const internal = instance as any, original = internal.containerLogin;
  let candidateSeed: unknown = 'not-called';
  internal.containerLogin = async () => { candidateSeed = internal.state.storageState; return 'failed'; };
  try {
   const response = await instance.fetch!(new Request('https://session/init', { method:'POST',body:JSON.stringify({userId:t.userId,studentId:'2020000001',encryptedPassword:'new-incorrect-password',iv:'test-iv'}) }));
   expect(candidateSeed).toBeNull();
   expect((await response.json<any>()).success).toBe(false);
   expect(await state.storage.get('credentials')).toEqual(before);
  } finally { internal.containerLogin = original; }
 });
});

it('rejects an export immediately after a control generation changes without relying on notify delivery', async () => {
 const t=await setup(), expected={deviceId:t.device.deviceId,generation:t.authority.generation,bindingEpoch:0,credentialRevision:0,sessionVersion:1};
 await runInDurableObject(t.stub,async(_,state)=>{const s:any=await state.storage.get('session');await state.storage.put('session',{...s,state:'ready',sessionVersion:1,lastKeepAliveAt:Date.now(),storageState:JSON.stringify({...validStorageState(),cookies:validStorageState().cookies.map(c=>({...c,secure:true,httpOnly:true,sameSite:'Lax',expires:-1}))})});});
 await t.accounts.setMasterEnabled(t.userId,false);
 expect((await t.call('v3_export',{expected})).error.code).toBe('MASTER_DISABLED');
});
it('expires a persisted running operation after its deadline rather than resurrecting its lease',async()=>{
 const t=await setup(), expected={deviceId:t.device.deviceId,generation:t.authority.generation,bindingEpoch:0,credentialRevision:0,sessionVersion:0};
 const operation=(await t.call('v3_operation',{input:{protocolVersion:3,requestId:'r',command:'ensure_session',idempotencyKey:'deadline',expected}})).result;
 await runInDurableObject(t.stub,async(_,state)=>{const a:any=await state.storage.get('v3:active');a.operation.state='running';a.operation.deadlineAt=Date.now()-60_000;await state.storage.put('v3:active',a);});
 const result=(await t.call('v3_read')).result;
 expect(result.operation).toMatchObject({operationId:operation.operationId,state:'retry_wait',resultCode:'OPERATION_TIMEOUT'});
 expect(result.session.leaseToken).toBeUndefined();
 expect(result.session.nextAttemptAt).toBeGreaterThan(Date.now());
});

it('finishes an idempotent enable command after its account response was lost',async()=>{
 const t=await setup(), expected={deviceId:t.device.deviceId,generation:t.authority.generation,bindingEpoch:0,credentialRevision:0,sessionVersion:0};
 const input={protocolVersion:3,requestId:'r',command:'set_enabled',enabled:false,idempotencyKey:'enable-lost',expected};
 const original=QuickloginAccountClient.prototype.setDeviceEnabled;
 const spy=vi.spyOn(QuickloginAccountClient.prototype,'setDeviceEnabled').mockImplementationOnce(async function(this:QuickloginAccountClient,...args:Parameters<typeof original>){await original.apply(this,args);throw new Error('synthetic lost response');});
 expect((await t.call('v3_operation',{input})).error).toBeDefined();
 spy.mockRestore();
 const resumed=await t.call('v3_operation',{input});
 expect(resumed.result.state).toBe('succeeded');
 expect((await t.accounts.getDeviceAuthority(t.userId,t.device.deviceId)).enabled).toBe(false);
});

it('commits the operation result at the same point as its new session version',async()=>{
 const {DeviceV3Store}=await import('../../src/services/quicklogin/device-v3-store');
 const t=await setup(),expected={deviceId:t.device.deviceId,generation:t.authority.generation,bindingEpoch:0,credentialRevision:0,sessionVersion:0};
 await t.call('v3_operation',{input:{protocolVersion:3,requestId:'r',command:'ensure_session',idempotencyKey:'atomic-result',expected}});
 vi.spyOn(DeviceV3Store.prototype,'finish').mockResolvedValue();
 vi.spyOn(QuickloginLoginBrokerClient.prototype,'quickloginLogin').mockResolvedValue({kind:'success',bindingEpoch:0,credentialRevision:0,loginAt:Date.now(),storageState:JSON.stringify({...validStorageState(),cookies:validStorageState().cookies.map(c=>({...c,secure:true,httpOnly:true,sameSite:'Lax',expires:-1}))})});
 await runInDurableObject(t.stub,async(instance,state)=>{await (instance as any).performLogin(await state.storage.get('session'),t.authority);});
 const read=(await t.call('v3_read')).result;
 expect(read.session.sessionVersion).toBe(1);
 expect(read.operation.state).toBe('succeeded');
});

it('starts a fresh maintenance operation after the prior successful operation deadline', async () => {
 const { parseOperation } = await import('../../src/services/quicklogin/protocol-v3');
 const { DeviceV3Store } = await import('../../src/services/quicklogin/device-v3-store');
 const t = await setup();
 let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
 const expected = { deviceId:t.device.deviceId,generation:t.authority.generation,bindingEpoch:0,credentialRevision:0,sessionVersion:0 };
 const original = (await t.call('v3_operation',{input:{protocolVersion:3,requestId:'r',command:'ensure_session',idempotencyKey:'maintenance-lifecycle',expected}})).result;
 const storageState = JSON.stringify({...validStorageState(),cookies:validStorageState().cookies.map(c=>({...c,secure:true,httpOnly:true,sameSite:'Lax',expires:-1}))});
 let runs = 0;
 let inspectRunning: () => Promise<any> = async () => null;
 vi.spyOn(QuickloginLoginBrokerClient.prototype,'quickloginLogin').mockImplementation(async () => {
  runs += 1;
  if (runs > 1) {
   const running = await inspectRunning();
   expect(() => parseOperation(running)).not.toThrow();
   expect(running.operationId).not.toBe(original.operationId);
   expect(running.versions.sessionVersion).toBe(1);
   expect(running.completedAt).toBeNull();
   expect(running.deadlineAt).toBeGreaterThan(now);
  }
  return {kind:'success',bindingEpoch:0,credentialRevision:0,loginAt:now,storageState};
 });
 await runInDurableObject(t.stub,async(instance,state)=>{await (instance as any).performLogin(await state.storage.get('session'),t.authority);});
 const ready = (await t.call('v3_read')).result;
 expect(ready.session.operationId).toBeUndefined();
 expect(ready.session.leaseToken).toBeUndefined();
 now = original.deadlineAt + 60_000;
 await runInDurableObject(t.stub,async(instance,state)=>{
  inspectRunning = async () => (await new DeviceV3Store(state.storage, (instance as any).env, a => (instance as any).notify(a)).read(t.authority)).operation;
  await (instance as any).performLogin(await state.storage.get('session'),t.authority);
 });
 const final = (await t.call('v3_read')).result;
 expect(final.session.sessionVersion).toBe(2);
 expect(final.session.operationId).toBeUndefined();
 expect(final.operation.state).toBe('succeeded');
 expect((await t.call('v3_operation_read',{operationId:original.operationId})).result).toMatchObject({state:'succeeded',operationId:original.operationId,versions:{sessionVersion:0}});
});

it('preserves a newer same-generation retry operation while legacy pending accounting completes', async () => {
 const futureNow = Date.now() + 1_000_000;
 vi.spyOn(Date, 'now').mockReturnValue(futureNow);
 const { DeviceV3Store } = await import('../../src/services/quicklogin/device-v3-store');
 const t = await setup();
 const storageState = JSON.stringify({...validStorageState(),cookies:validStorageState().cookies.map(c=>({...c,secure:true,httpOnly:true,sameSite:'Lax',expires:-1}))});
 await runInDurableObject(t.stub,async(_,state)=>{const s:any=await state.storage.get('session');await state.storage.put('session',{...s,state:'ready',storageState,sessionVersion:1,loginAt:Date.now(),lastKeepAliveAt:Date.now(),pendingKeepaliveMint:{operationId:'legacy-during-retry',mintedAt:Date.now(),expiresAt:Date.now()+60_000,hasStorageState:false}});});
 let started!:()=>void, release!:()=>void;
 const began = new Promise<void>(resolve=>{started=resolve;}), hold = new Promise<void>(resolve=>{release=resolve;});
 vi.spyOn(QuickloginLoginBrokerClient.prototype,'recordQuickloginKeepaliveMint').mockImplementation(async()=>{started();await hold;});
 const expected={deviceId:t.device.deviceId,generation:t.authority.generation,bindingEpoch:0,credentialRevision:0,sessionVersion:1};
 let operationId!:string;
 await runInDurableObject(t.stub,async(instance,state)=>{
  const confirming=(instance as any).confirmKeepaliveMint(await state.storage.get('session'),t.authority);
  await began;
  const op=await new DeviceV3Store(state.storage, (instance as any).env, a => (instance as any).notify(a)).operation(t.authority,{protocolVersion:3,requestId:'r',command:'retry_session',idempotencyKey:'during-legacy-accounting',expected});
  operationId=op.operationId;
  release();await confirming;
  const current:any=await state.storage.get('session');
  expect(current.operationId).toBe(operationId);
  expect(current.leaseToken).toBeTypeOf('string');
  expect(current.state).toBe('refreshing');
  expect(current.pendingKeepaliveMint).toBeUndefined();
  expect(await state.storage.getAlarm()).toBeLessThanOrEqual(Date.now()+1000);
 });
});

it('expired keepalive cleanup preserves a newer operation and its latest session fields', async () => {
 const { DeviceV3Store } = await import('../../src/services/quicklogin/device-v3-store');
 const t = await setup();
 await runInDurableObject(t.stub, async (instance, state) => {
  const stale: any = await state.storage.get('session');
  stale.pendingKeepaliveMint = { operationId:'expired-mint',mintedAt:Date.now()-100_000,expiresAt:Date.now()-1,hasStorageState:true };
  await state.storage.put('session',stale);
  await state.storage.put('pendingKeepaliveState','old-state');
  const expected = {deviceId:t.device.deviceId,generation:t.authority.generation,bindingEpoch:0,credentialRevision:0,sessionVersion:0};
  const op = await new DeviceV3Store(state.storage,(instance as any).env,a=>(instance as any).notify(a)).operation(t.authority,{protocolVersion:3,requestId:'r',command:'retry_session',idempotencyKey:'cleanup-stale',expected});
  const before: any = await state.storage.get('session');
  await (instance as any).recoverPendingKeepalive(stale,Date.now());
  const after: any = await state.storage.get('session');
  expect(after.operationId).toBe(op.operationId);
  expect(after.leaseToken).toBe(before.leaseToken);
  expect(after.deviceRevision).toBe(before.deviceRevision);
  expect(after.pendingKeepaliveMint).toBeUndefined();
 });
});

it('starts a new automatic attempt after retry_wait without reopening the previous operation', async () => {
 const t = await setup();
 let now=Date.now();vi.spyOn(Date,'now').mockImplementation(()=>now);
 const expected={deviceId:t.device.deviceId,generation:t.authority.generation,bindingEpoch:0,credentialRevision:0,sessionVersion:0};
 const old=(await t.call('v3_operation',{input:{protocolVersion:3,requestId:'r',command:'ensure_session',idempotencyKey:'automatic-retry',expected}})).result;
 const broker=vi.spyOn(QuickloginLoginBrokerClient.prototype,'quickloginLogin').mockResolvedValueOnce({kind:'temporary_unavailable',retryAfterMs:60_000,reasonCode:'SCHOOL_UNREACHABLE'});
 await runInDurableObject(t.stub,async(instance,state)=>{await (instance as any).performLogin(await state.storage.get('session'),t.authority);});
 const failed=(await t.call('v3_read')).result;
 expect(failed.operation.state).toBe('retry_wait');expect(failed.session.operationId).toBeUndefined();expect(failed.session.leaseToken).toBeUndefined();
 now=old.deadlineAt+60_000;
 broker.mockResolvedValueOnce({kind:'success',bindingEpoch:0,credentialRevision:0,loginAt:now,storageState:JSON.stringify({...validStorageState(),cookies:validStorageState().cookies.map(c=>({...c,secure:true,httpOnly:true,sameSite:'Lax',expires:-1}))})});
 await runInDurableObject(t.stub,async(instance,state)=>{await (instance as any).performLogin(await state.storage.get('session'),t.authority);});
 const recovered=(await t.call('v3_read')).result;
 expect(recovered.operation).toMatchObject({state:'succeeded',startedAt:now});
 expect(recovered.operation.operationId).not.toBe(old.operationId);expect(recovered.operation.deadlineAt).toBeGreaterThan(now);
 expect(recovered.session.sessionVersion).toBe(1);expect(recovered.session.leaseToken).toBeUndefined();
 expect((await t.call('v3_operation_read',{operationId:old.operationId})).result.state).toBe('retry_wait');
});

describe('legacy pending accounting survives observational updates', () => {
 it.each([
  'report', 'receipt',
 ] as const)('commits after accounting wait overlaps a valid %s', async observation => {
  const now = Date.now() + 1_000_000;
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const { DeviceV3Store } = await import('../../src/services/quicklogin/device-v3-store');
  const t = await setup();
  const browserState = (marker: string) => ({
   ...validStorageState(),
   cookies: validStorageState().cookies.map(c => ({ ...c, value: `${c.value}-${marker}`, secure: true, httpOnly: true, sameSite: 'Lax', expires: -1 })),
  });
  const oldState = browserState('before'), renewedState = browserState('renewed');
  await runInDurableObject(t.stub, async (_, state) => {
   const session: any = await state.storage.get('session');
   await state.storage.put('session', { ...session, state:'ready', storageState:JSON.stringify(oldState), sessionVersion:1, loginAt:now, lastKeepAliveAt:now-60_000, pendingKeepaliveMint:{operationId:'legacy-observation',mintedAt:now,expiresAt:now+60_000,hasStorageState:true} });
   await state.storage.put('pendingKeepaliveState', JSON.stringify(renewedState));
  });
  const expected = { deviceId:t.device.deviceId, generation:t.authority.generation, bindingEpoch:0, credentialRevision:0, sessionVersion:1 };
  const exported = (await t.call('v3_export', { expected })).result;
  let started!: () => void, release!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(QuickloginLoginBrokerClient.prototype, 'recordQuickloginKeepaliveMint').mockImplementation(async () => { started(); await hold; });
  await runInDurableObject(t.stub, async (instance, state) => {
   const store = new DeviceV3Store(state.storage, (instance as any).env, a => (instance as any).notify(a));
   const original: any = await state.storage.get('session');
   const confirming = (instance as any).confirmKeepaliveMint(original, t.authority);
   await began;
   if (observation === 'report') {
    await store.report(t.authority, { protocolVersion:3, requestId:'observation', client, observed:null, reportEpoch:'observation-epoch', clientReportSeq:1, local:{enabledIntent:true, mode:'automatic', cookieState:'missing', receipt:null} });
   } else {
    const ack = await store.receipt(t.authority, { protocolVersion:3, requestId:'observation', reportEpoch:'observation-epoch', clientReportSeq:1, receipt:{...expected, exportId:exported.exportId, result:'applied', verifiedAt:now} });
    expect(ack.accepted).toBe(true);
   }
   const observed: any = await state.storage.get('session');
   expect(observed.deviceRevision).toBeGreaterThan(original.deviceRevision ?? 0);
   release(); await confirming;
   const completed: any = await state.storage.get('session');
   expect(completed.sessionVersion).toBe(2);
   expect(JSON.parse(completed.storageState)).toEqual(renewedState);
   expect(completed.state).toBe('ready');
   expect(completed.lastKeepAliveAt).toBe(now);
   expect(completed.pendingKeepaliveMint).toBeUndefined();
   expect(completed.deviceRevision).toBeGreaterThan(observed.deviceRevision);
   expect(await state.storage.get('v3:report')).toMatchObject({clientReportSeq:1, cookieState:observation === 'receipt' ? 'applied' : 'missing'});
   expect(await state.storage.getAlarm()).toBe(completed.reloginAt);
  });
 });
});

it('clears the previous terminal reason when a new login actually starts', async () => {
 const t=await setup();
 let readStarted:()=>Promise<any> = async()=>null;
 vi.spyOn(QuickloginLoginBrokerClient.prototype,'quickloginLogin').mockImplementation(async()=>{
  expect((await readStarted()).reasonCode).toBeNull();
  return {kind:'temporary_unavailable',retryAfterMs:60_000,reasonCode:'OTP_TIMEOUT'};
 });
 await runInDurableObject(t.stub,async(instance,state)=>{
  const s:any=await state.storage.get('session');
  await state.storage.put('session',{...s,state:'temporary_unavailable',reasonCode:'SCHOOL_UNREACHABLE'});
  readStarted=()=>state.storage.get('session');
  await (instance as any).performLogin(await state.storage.get('session'),t.authority);
 });
});

it('keeps a device CAPTCHA blocked without disabling other devices or claiming rejected credentials', async () => {
 const { snapshotV3 } = await import('../../src/services/quicklogin/snapshot-v3');
 const t=await setup();
 vi.spyOn(QuickloginLoginBrokerClient.prototype,'quickloginLogin').mockResolvedValue({kind:'needs_reauth',reason:'interactive_required'});
 await runInDurableObject(t.stub,async(instance,state)=>{await (instance as any).performLogin(await state.storage.get('session'),t.authority);});
 const blocked=await snapshotV3(env,t.userId,t.device.deviceId);
 expect(blocked.cloud).toMatchObject({state:'blocked',reasonCode:'INTERACTION_REQUIRED'});
 expect(blocked.binding.credentialsState).toBe('unknown');
 expect(blocked.capabilities.canEnsure).toBe(false);
 expect(blocked.capabilities.canRetry).toBe(false);
 const grant=await t.accounts.createPendingGrant(t.userId,'test-client',Date.now());
 await t.accounts.activateGrant(t.userId,grant.grantId,Date.now());
 const other=await t.accounts.registerDevice(t.userId,grant.grantId,{deviceName:'Other device',browserFamily:'chrome',browserVersion:'152'});
 const authority=await t.accounts.setDeviceEnabled(t.userId,other.deviceId,true);
 await t.devices.notifyDevice(authority);
 const available=await snapshotV3(env,t.userId,other.deviceId);
 expect(available.binding.credentialsState).toBe('unknown');
 expect(available.capabilities.canEnsure).toBe(true);
 expect(available.cloud.reasonCode).not.toBe('INTERACTION_REQUIRED');
});


it('settles malformed successful login results instead of leaving a running operation', async () => {
 const t = await setup();
 const expected = { deviceId: t.device.deviceId, generation: t.authority.generation, bindingEpoch: 0, credentialRevision: 0, sessionVersion: 0 };
 await t.call('v3_operation', { input: { protocolVersion: 3, requestId: 'r', command: 'ensure_session', idempotencyKey: 'bad-cookie', expected } });
 vi.spyOn(QuickloginLoginBrokerClient.prototype, 'quickloginLogin').mockResolvedValue({
  kind: 'success', bindingEpoch: 0, credentialRevision: 0, loginAt: Date.now(),
  storageState: JSON.stringify({ cookies: [{ name: 'SOURCEID_TGC', value: 'synthetic', domain: 'sso.cqu.edu.cn', path: '/', secure: true, httpOnly: true }], origins: [] }),
 });
 await runInDurableObject(t.stub, async (instance, state) => {
  await expect((instance as any).performLogin(await state.storage.get('session'), t.authority)).resolves.toBeUndefined();
 });
 const result = (await t.call('v3_read')).result;
 expect(result.session.state).toBe('temporary_unavailable');
 expect(result.session.reasonCode).toBe('CONTRACT_INVALID');
 expect(result.session.operationId).toBeUndefined();
 expect(result.operation.state).toBe('retry_wait');
 expect(result.operation.completedAt).toBeTypeOf('number');
});

it('repairs a missing alarm for an aligned preparing device without a running task', async () => {
 const t = await setup();
 const retryAt = Date.now() + 60_000;
 await t.call('v3_read');
 await runInDurableObject(t.stub, async (_, state) => {
  await state.storage.put('v3:client', client);
  const session: any = await state.storage.get('session');
  await state.storage.put('session', { ...session, nextAttemptAt: retryAt });
  await state.storage.deleteAlarm();
 });
 await t.call('v3_read');
 const alarm = await runInDurableObject(t.stub, (_, state) => state.storage.getAlarm());
 expect(alarm).not.toBeNull();
 expect(alarm).toBe(retryAt);
});


it('does not let an old rejected broker call settle a successor operation', async () => {
 const t = await setup();
 await runInDurableObject(t.stub, (_, state) => state.storage.put('v3:client', client));
 let reject!: (error: Error) => void;
 let started!: () => void;
 const began = new Promise<void>(resolve => { started = resolve; });
 vi.spyOn(QuickloginLoginBrokerClient.prototype, 'quickloginLogin').mockImplementation(() => {
  started(); return new Promise((_, rejectCall) => { reject = rejectCall; });
 });
 await runInDurableObject(t.stub, async (instance, state) => {
  const flight = (instance as any).performLogin(await state.storage.get('session'), t.authority);
  await began;
  const current: any = await state.storage.get('session');
  const next = { ...current, operationId: 'successor', leaseToken: 'successor-lease', state: 'preparing' };
  const alarm = Date.now() + 600_000;
  await state.storage.put('session', next); await state.storage.setAlarm(alarm);
  reject(new Error('synthetic broker transport failure'));
  await expect(flight).resolves.toBeUndefined();
  expect(await state.storage.get('session')).toEqual(next);
  expect(await state.storage.getAlarm()).toBe(alarm);
 });
});


describe('first enable after school binding', () => {
 it('accepts the fresh server snapshot for a newly registered disabled device', async () => {
  const userId = `first-enable-${crypto.randomUUID()}`;
  const accounts = new QuickloginAccountClient(env), devices = new QuickloginDeviceClient(env);
  await accounts.initializeQuickloginPolicy(userId, { migrationId:userId, deviceLimit:5, masterEnabled:true });
  const bindingStub = env.CQU_SESSION.get(env.CQU_SESSION.idFromName(userId));
  await seedSession(bindingStub, { userId, extra: { quickloginBindingEpoch:3, credentialRevision:4, bindingRevision:5 } });
  await seedCredentials(bindingStub);
  const grant = await accounts.createPendingGrant(userId, 'test-client', Date.now());
  await accounts.activateGrant(userId, grant.grantId, Date.now());
  const device = await accounts.registerV3(userId, grant.grantId, {
   protocolVersion:3, requestId:'register', registrationId:crypto.randomUUID(), client, deviceName:'New Chrome',
  });
  const before = await snapshotV3(env, userId, device.deviceId);
  expect(before.authorization).toMatchObject({ policy:'device_off', masterEnabled:true, deviceEnabled:false });
  expect(before.capabilities.canEnable).toBe(true);
  const authority = await accounts.getDeviceAuthority(userId, device.deviceId);
  const stub = env.CQU_QUICKLOGIN_DEVICE.get(env.CQU_QUICKLOGIN_DEVICE.idFromName(`${userId}:${device.deviceId}`));
  await runInDurableObject(stub, async (_, state) => {
   expect(await state.storage.getAlarm()).toBeNull();
  });
  await expect(devices.operateV3(authority, {
   protocolVersion:3, requestId:'stale-enable', command:'set_enabled', enabled:true,
   idempotencyKey:'stale-enable', expected:{...tupleForSnapshot(before)!, bindingEpoch:0, credentialRevision:0},
  })).rejects.toMatchObject({ code:'STALE_SNAPSHOT' });
  const outcome = await devices.operateV3(authority, {
   protocolVersion:3, requestId:'enable', command:'set_enabled', enabled:true,
   idempotencyKey:'first-enable', expected:tupleForSnapshot(before)!,
  }).then(operation => ({ state:operation.state }), error => ({ code:error.code }));
  expect(outcome).toEqual({ state:'succeeded' });
  const after = await snapshotV3(env, userId, device.deviceId);
  expect(after.authorization).toMatchObject({ policy:'enabled', deviceEnabled:true });
 });
});
