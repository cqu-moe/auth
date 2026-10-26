import { startAuth } from './runtime.mjs';
import { prepareAccount } from './prepare-account.mjs';
import { TURNSTILE_TOKEN_HEADER, encodeTurnstileToken, turnstileHeaders } from './turnstile.mjs';
const runtime = await startAuth();
console.log('Consumer runtime ready');
try {
  const user = await prepareAccount(runtime, { email: 'consumer@example.test', password: 'Synthetic-consumer-123!' });
  const replayToken = encodeTurnstileToken('password-login', new URL(runtime.origin).hostname);
  const response = await fetch(`${runtime.origin}/api/v1/auth/sign-in/email`, {
    signal: AbortSignal.timeout(10000), method:'POST', headers:{origin:runtime.origin,'content-type':'application/json',[TURNSTILE_TOKEN_HEADER]:replayToken},
    body:JSON.stringify({email:user.email,password:user.password}),
  });
  if (!response.ok || !response.headers.get('set-cookie')) throw new Error('Consumer identity cannot sign in');
  await response.arrayBuffer();
  const replay = await fetch(`${runtime.origin}/api/v1/auth/sign-in/email`, {
    signal: AbortSignal.timeout(10000), method:'POST', headers:{origin:runtime.origin,'content-type':'application/json',[TURNSTILE_TOKEN_HEADER]:replayToken},
    body:JSON.stringify({email:user.email,password:user.password}),
  });
  const rejection = await replay.json();
  if (replay.status !== 403 || rejection.code !== 'TURNSTILE_FAILED') throw new Error('Turnstile replay was not rejected');
  const fresh = await fetch(`${runtime.origin}/api/v1/auth/sign-in/email`, {
    signal: AbortSignal.timeout(10000), method:'POST', headers:{origin:runtime.origin,'content-type':'application/json',...turnstileHeaders('/auth/sign-in/email',runtime.origin)},
    body:JSON.stringify({email:user.email,password:user.password}),
  });
  if (!fresh.ok) throw new Error('Fresh Turnstile sign-in failed');
  await fresh.arrayBuffer();
  console.log('Downstream account preparation and independent real sign-in: PASS');
} finally { await runtime.close(); }
