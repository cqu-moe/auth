import { describe, expect, it } from 'vitest';
import { QuickloginLoginBrokerClient } from './login-broker-client';
import type { Env } from '../../types';
function broker(response: () => Response) {
  return new QuickloginLoginBrokerClient({ CQU_SESSION: { idFromName: () => 'id', get: () => ({ fetch: async () => response() }) } } as unknown as Pick<Env, 'CQU_SESSION'>);
}
describe('binding authority failures', () => {
  it('does not turn an internal 503 into an unbound account', async () => {
    await expect(broker(() => new Response('', { status: 503 })).getQuickloginBindingEpoch('user')).rejects.toThrow('INTERNAL_STATE_UNAVAILABLE');
  });
  it('rejects malformed binding facts', async () => {
    await expect(broker(() => Response.json({ bound: false })).getQuickloginBindingEpoch('user')).rejects.toThrow('INTERNAL_STATE_UNAVAILABLE');
  });
});
