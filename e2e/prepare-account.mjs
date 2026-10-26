import { randomBytes } from 'node:crypto';
import { turnstileHeaders } from './turnstile.mjs';

/** Prepare a verified synthetic identity through real signup/verification, not INSERT user/session. */
export async function prepareAccount(runtime, { email, password, name = 'Synthetic Consumer' }) {
  if (!/^[a-z0-9._+-]+@example\.test$/i.test(email)) throw new Error('Only synthetic example.test identities are allowed');
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const code = [...randomBytes(8)].map(byte => alphabet[byte % alphabet.length]).join('');
  await runtime.db.prepare('INSERT INTO registration_invitation(code,created_by,expires_at) VALUES (?,?,?)')
    .bind(code, 'synthetic-consumer', '2099-01-01T00:00:00.000Z').run();
  const signup = await fetch(`${runtime.origin}/api/v1/auth/sign-up/email`, {
    signal: AbortSignal.timeout(10000), method: 'POST', headers: { origin: runtime.origin, 'content-type': 'application/json', ...turnstileHeaders('/auth/sign-up/email', runtime.origin) },
    body: JSON.stringify({ email, password, name, code }),
  });
  if (!signup.ok) throw new Error(`Synthetic signup failed (${signup.status})`);
  const cookie = signup.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  await signup.arrayBuffer();
  const delivered = await fetch(`${runtime.controlOrigin}/mail?email=${encodeURIComponent(email)}`, { signal: AbortSignal.timeout(10000) });
  const { otp } = await delivered.json();
  if (!otp) throw new Error('Synthetic verification message missing');
  const verification = await fetch(`${runtime.origin}/api/v1/auth/email-otp/verify-email`, {
    signal: AbortSignal.timeout(10000), method: 'POST', headers: { origin: runtime.origin, cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ email, otp }),
  });
  if (!verification.ok) throw new Error(`Synthetic verification failed (${verification.status})`);
  await verification.arrayBuffer();
  const response = await fetch(`${runtime.origin}/api/v1/auth/get-session`, { signal: AbortSignal.timeout(10000), headers: { cookie } });
  const session = await response.json();
  if (session?.user?.email !== email || session?.user?.emailVerified !== true) throw new Error('Verified identity readback failed');
  // Deliberately do not hand out the preparation session: callers must exercise their real login flow.
  return { email, password, userId: session.user.id };
}
