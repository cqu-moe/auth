import { abortAllDurableObjects, env, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { freshStub, readStorage, readStatus, readAlarm, readState, seedSession, seedCredentials, spyBrowserFetch, validStorageState } from './helpers';

afterEach(async () => {
  // Retire prior objects and alarms before the next test installs browser spies.
  await reset();
  vi.restoreAllMocks();
});

async function seedInterrupted(stub: DurableObjectStub, kind: 'cas' | 'quicklogin', observed = false) {
  const now = Date.now();
  const token = 'old-operation';
  const key = kind === 'cas' ? 'loginInFlight' : 'quickloginLogin:device-a';
  await seedSession(stub, { status: kind === 'cas' ? 'relogging' : 'active', extra: {
    [key]: { token, startedAt: now, deadlineAt: now + 780_000, deviceId: 'device-a', generation: 1, bindingEpoch: 0 },
    ['browserRoute:' + token]: { token, kind, route: {version: 1, backend: 'cloudflare', userId: 'u1', bootId: 'old-boot'}, createdAt: now, expiresAt: now + 2340_000 },
    codeLease: {ownerToken: token, ownerKind: kind, acquiredAt: now, ...(observed ? {ownerCodeReceivedAt: now} : {}), queue: []},
  }});
  await seedCredentials(stub);
  return key;
}
async function restart(stub: DurableObjectStub) {
  const id = stub.id;
  await abortAllDurableObjects();
  return env.CQU_SESSION.get(id);
}
async function recover(stub: DurableObjectStub) {
  return runInDurableObject(stub, async (instance) => {
    await (instance as unknown as { recoverInterruptedLogins(): Promise<void> }).recoverInterruptedLogins();
  });
}

describe('login coordination', () => {
  it.each(['cas', 'quicklogin'] as const)('cancels interrupted %s before releasing its persisted lock and channel', async (kind) => {
    const original = freshStub();
    const key = await seedInterrupted(original, kind);
    const stub = await restart(original);
    let cancellations = 0;
    spyBrowserFetch({'/login-cancel': async (request) => {
      expect(request.headers.get('X-Cqu-Expected-Boot-Id')).toBe('old-boot');
      expect(await request.json()).toEqual({session: 'old-operation'});
      cancellations++;
      return Response.json({ok:true, stopped:true, mayHaveRequestedCode:false});
    }});
    await recover(stub);
    expect(cancellations).toBe(1);
    expect(await readStorage(stub,key)).toBeUndefined();
    expect(await readStorage(stub,'codeLease')).toBeUndefined();
    expect(await readStatus(stub)).toBe(kind === 'cas' ? 'expired' : 'active');
    expect((await readState(stub))?.storageState).toEqual(validStorageState());
  });

  it('keeps the lock and schedules retry when stopping the old browser is unconfirmed', async () => {
    const original = freshStub();
    const key = await seedInterrupted(original,'quicklogin');
    const stub = await restart(original);
    spyBrowserFetch({'/login-cancel': () => Response.json({ok:false}, {status:503})});
    await recover(stub);
    expect(await readStorage(stub,key)).toMatchObject({token:'old-operation'});
    expect(await readStorage(stub,'codeLease')).toMatchObject({ownerToken:'old-operation'});
    expect(await readAlarm(stub)).toBeLessThanOrEqual(Date.now()+60_000);
  });

  it('does not perform container I/O while constructing or reading status', async () => {
    const original = freshStub();
    await seedInterrupted(original,'quicklogin');
    await runInDurableObject(original, async (_instance, state) => state.storage.put('codePermitPending','old-operation'));
    const stub = await restart(original);
    const fetch = spyBrowserFetch({'/code-permit': () => { throw new Error('should not run'); }});
    const response = await stub.fetch('http://do/status');
    expect(response.status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
    expect(await readAlarm(stub)).not.toBeNull();
  });

  it('releases an interrupted task lock but keeps its observed OTP isolated until the original expiry', async () => {
    const original = freshStub();
    const key = await seedInterrupted(original,'quicklogin',true);
    const lease = await readStorage<{ownerCodeReceivedAt:number}>(original,'codeLease');
    const stub = await restart(original);
    spyBrowserFetch({'/login-cancel': () => Response.json({ok:true,stopped:true,mayHaveRequestedCode:false})});
    await recover(stub);
    expect(await readStorage(stub,key)).toBeUndefined();
    expect(await readStorage(stub,'codeLease')).toMatchObject({ownerToken:'old-operation',ownerCodeReceivedAt:lease!.ownerCodeReceivedAt});
    const again = await restart(stub);
    await recover(again);
    expect(await readStorage(again,'codeLease')).toMatchObject({ownerCodeReceivedAt:lease!.ownerCodeReceivedAt});
  });

  it('a late CAS failure cannot delete a replacement lock or change its status', async () => {
    const stub = freshStub();
    await seedSession(stub,{status:'binding',extra:{loginInFlight:{token:'replacement',startedAt:Date.now()}}});
    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as {failLogin(event:string,token:string):Promise<void>}).failLogin('FIRST_LOGIN_FAIL','old-operation');
    });
    expect(await readStorage(stub,'loginInFlight')).toMatchObject({token:'replacement'});
    expect(await readStatus(stub)).toBe('binding');
  });
});

describe('recovery workflow integration', () => {
  it('an old workflow cannot clear or cool down a replacement recovery cycle', async () => {
    const stub = freshStub();
    await seedSession(stub, {extra:{sessionRecoveryCycle:{id:'new-cycle',userId:'u1',created:true,deadlineAt:Date.now()+60_000}}});
    const response = await stub.fetch('http://do/recovery-finish',{method:'POST',body:JSON.stringify({recoveryId:'old-cycle',outcome:'failed'})});
    expect(response.status).toBe(200);
    expect(await readStorage(stub,'sessionRecoveryCycle')).toMatchObject({id:'new-cycle'});
    expect(await readStorage(stub,'sessionRecoveryCooldownUntil')).toBeUndefined();
  });

  it('polling an expired session preserves the persisted retry cooldown without starting a browser', async () => {
    const stub = freshStub();
    const retryAt = Date.now()+300_000;
    await seedSession(stub,{status:'expired',extra:{reloginRetryAt:retryAt,sessionRecoveryCycle:{id:'cycle',userId:'u1',created:true,deadlineAt:Date.now()+1800_000}}});
    const browser = spyBrowserFetch({});
    for (let i=0;i<3;i++) {
      const response = await stub.fetch('http://do/recovery-tick',{method:'POST',body:JSON.stringify({recoveryId:'cycle'})});
      expect(await response.json()).toMatchObject({state:'waiting',retryAt});
    }
    expect(await readStorage(stub,'reloginRetryAt')).toBe(retryAt);
    expect(browser).not.toHaveBeenCalled();
  });

  it('cancel confirmation for a replaced boot releases a legacy lock', async () => {
    const original = freshStub();
    const key = await seedInterrupted(original,'quicklogin');
    const stub = await restart(original);
    spyBrowserFetch({'/login-cancel':()=>Response.json({ok:false,error:'BROWSER_INSTANCE_REPLACED'},{status:409})});
    await recover(stub);
    expect(await readStorage(stub,key)).toBeUndefined();
  });

  it('an alarm due to a running login never starts a keepalive browser job', async () => {
    const stub = freshStub();
    await seedInterrupted(stub,'cas');
    const browser = spyBrowserFetch({});
    await runInDurableObject(stub,async(instance)=>{await (instance as unknown as {alarm():Promise<void>}).alarm();});
    expect(browser).not.toHaveBeenCalled();
    expect(await readStorage(stub,'loginInFlight')).toMatchObject({token:'old-operation'});
    expect(await readAlarm(stub)).toBeGreaterThan(Date.now());
  });
});

describe('interrupted stage isolation', () => {
  it('holds the channel after a claimed permit even if its email has not arrived', async () => {
    const original = freshStub();
    const key = await seedInterrupted(original,'quicklogin');
    const stub = await restart(original);
    spyBrowserFetch({'/login-cancel':()=>Response.json({ok:true,stopped:true,mayHaveRequestedCode:true})});
    await recover(stub);
    expect(await readStorage(stub,key)).toBeUndefined();
    expect(await readStorage(stub,'codeLease')).toMatchObject({ownerToken:'old-operation',recoveryFence:true});
    const pending = await readStorage<Array<{isolationUntil:number}>>(stub,'interruptedLogins');
    expect(pending![0].isolationUntil).toBeGreaterThan(Date.now()+599_000);
    const again = await restart(stub);
    await recover(again);
    expect((await readStorage<Array<{isolationUntil:number}>>(again,'interruptedLogins'))![0].isolationUntil).toBe(pending![0].isolationUntil);
  });

  it('missing legacy route is not proof that an old browser has stopped', async () => {
    const original = freshStub();
    const key = await seedInterrupted(original,'quicklogin');
    await runInDurableObject(original,async(_instance,state)=>state.storage.delete('browserRoute:old-operation'));
    const stub = await restart(original);
    await recover(stub);
    expect(await readStorage(stub,key)).toMatchObject({token:'old-operation'});
    expect(await readStorage(stub,'codeLease')).toMatchObject({recoveryFence:true});
    expect((await readStorage<Array<{safeAfter:number}>>(stub,'interruptedLogins'))![0].safeAfter).toBeGreaterThan(Date.now());
  });

  it('unbind preserves cancellation routing while removing credentials and rejects late task completion', async () => {
    const stub = freshStub();
    const key = await seedInterrupted(stub,'cas');
    await stub.fetch('http://do/destroy',{method:'POST'});
    expect(await readStorage(stub,'credentials')).toBeUndefined();
    expect(await readStatus(stub)).toBe('unbound');
    expect(await readStorage(stub,'browserRoute:old-operation')).toBeDefined();
    spyBrowserFetch({'/login-cancel':()=>Response.json({ok:true,stopped:true,mayHaveRequestedCode:false})});
    await recover(stub);
    expect(await readStorage(stub,key)).toBeUndefined();
    expect(await readStorage(stub,'browserRoute:old-operation')).toBeUndefined();
    expect(await readStatus(stub)).toBe('unbound');
  });
});
