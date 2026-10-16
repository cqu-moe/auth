import { startAuth } from './runtime.mjs';
import { prepareAccount } from './prepare-account.mjs';
const runtime = await startAuth();
console.log('Consumer runtime ready');
try {
  const user = await prepareAccount(runtime, { email: 'consumer@example.test', password: 'Synthetic-consumer-123!' });
  const response = await fetch(`${runtime.origin}/api/v1/auth/sign-in/email`, {
    signal: AbortSignal.timeout(10000), method:'POST', headers:{origin:runtime.origin,'content-type':'application/json'},
    body:JSON.stringify({email:user.email,password:user.password}),
  });
  if (!response.ok || !response.headers.get('set-cookie')) throw new Error('Consumer identity cannot sign in');
  await response.arrayBuffer();
  console.log('Downstream account preparation and independent real sign-in: PASS');
} finally { await runtime.close(); }
