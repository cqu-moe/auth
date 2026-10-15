import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { freshStub, readAlarm, readState, readStorage, seedSession, spyBrowserFetch } from './helpers';

afterEach(() => vi.restoreAllMocks());

async function recovered() {
  const stub = freshStub();
  const checkedAt = Date.now();
  await seedSession(stub, {extra:{sessionRecoveryCycle:{id:'finished-cycle',userId:'u1',created:true,checkedAt,deadlineAt:checkedAt+1800_000}}});
  await runInDurableObject(stub, (_, state) => state.storage.setAlarm(checkedAt+60_000));
  return {stub, checkedAt};
}
async function finish(stub: DurableObjectStub, outcome = 'complete') {
  const response = await stub.fetch('http://do/recovery-finish', {method:'POST',body:JSON.stringify({recoveryId:'finished-cycle',outcome})});
  expect(response.status).toBe(200);
}

describe('completed recovery check alarm', () => {
  it('retires its obsolete check after recovery, preserving the ordinary keepalive deadline', async () => {
    const {stub} = await recovered();
    const session = await readStorage<{lastKeepAlive:number}>(stub,'state');
    const browser = spyBrowserFetch({});
    await finish(stub);
    expect(await readStorage(stub,'sessionRecoveryCycle')).toBeUndefined();
    expect(await readAlarm(stub)).toBe(session!.lastKeepAlive+3600_000);
    expect(await readState(stub)).toEqual(session);
    expect(browser).not.toHaveBeenCalled();
  });

  it.each(['other alarm','CAS login','device login','cleanup','binding deletion','binding outbox','binding transition','code permit','keepalive retry','expired','failed recovery'])(
    'preserves a deadline owned by %s', async kind => {
      const {stub,checkedAt} = await recovered();
      const expected = kind === 'other alarm' ? checkedAt+30_000 : checkedAt+60_000;
      await runInDurableObject(stub, async (_, state) => {
        if(kind==='other alarm') await state.storage.setAlarm(expected);
        if(kind==='CAS login') await state.storage.put('loginInFlight',{token:'running',startedAt:checkedAt,deadlineAt:checkedAt+780_000});
        if(kind==='device login') await state.storage.put('quickloginLogin:device',{token:'running',startedAt:checkedAt,deadlineAt:checkedAt+780_000});
        if(kind==='cleanup') await state.storage.put('interruptedLogins',[{token:'old',retryAt:expected,stopped:true}]);
        if(kind==='binding deletion') await state.storage.put('bindingDeletion','u1');
        if(kind==='binding outbox') await state.storage.put('bindingOutbox',{ownerUserId:'u1',revision:1});
        if(kind==='binding transition') await state.storage.put('bindingTransition',{id:'new-binding'});
        if(kind==='code permit') await state.storage.put('codePermitPending','pending');
        if(kind==='keepalive retry') {
          const session = await state.storage.get<Record<string,unknown>>('state');
          await state.storage.put('state',{...session,consecutiveFailures:1});
        }
        if(kind==='expired') await state.storage.put('status','expired');
      });
      await finish(stub,kind==='failed recovery'?'failed':'complete');
      expect(await readAlarm(stub)).toBe(expected);
    });
});
