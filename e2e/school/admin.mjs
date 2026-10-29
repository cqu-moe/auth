import { prepareAccount } from '../prepare-account.mjs';
import { turnstileHeaders } from '../turnstile.mjs';

// Only admin role is a fixture prerequisite. Password, TOTP enrollment and strong
// admission all cross the real production API; no proof/session is seeded.
export async function prepareSchoolAdmin(runtime) {
  const password='Synthetic-only-123!';
  const account=await prepareAccount(runtime,{email:'school-admin@example.test',password});
  await runtime.db.prepare("UPDATE user SET role='superAdmin' WHERE id=?").bind(account.userId).run();
  const jar=new Map();
  async function request(path,body,method='POST') {
    const response=await fetch(`${runtime.origin}/api/v1${path}`,{method,signal:AbortSignal.timeout(15000),
      headers:{origin:runtime.origin,'content-type':'application/json',...turnstileHeaders(path,runtime.origin),cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; ')},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    for(const raw of response.headers.getSetCookie()) {const pair=raw.split(';')[0];const index=pair.indexOf('=');jar.set(pair.slice(0,index),pair.slice(index+1));}
    if(!response.ok) throw new Error(`Synthetic admin action failed (${response.status}, ${path})`);
    return response.status === 204 ? null : response.json();
  }
  await request('/auth/sign-in/email',{email:account.email,password});
  await request('/auth/security/challenge',{password,purpose:'mfa'});
  const enrollment=await request('/auth/two-factor/enable',{password});
  const {createOTP}=await import('@better-auth/utils/otp');
  const {base32}=await import('@better-auth/utils/base32');
  const secret=new TextDecoder().decode(base32.decode(new URL(enrollment.totpURI).searchParams.get('secret')));
  await request('/auth/two-factor/verify-totp',{code:await createOTP(secret).totp()});
  const proof=await request('/auth/security/status',undefined,'GET');
  if(proof.strong!==true) throw new Error('Synthetic admin strong admission missing');
  async function ensureRecentAdmin() {
    const proof=await request('/auth/security/status?purpose=admin',undefined,'GET');
    if(proof.verified===true) return;
    const challenge=await request('/auth/security/challenge',{password,purpose:'admin'});
    const completed=await request('/auth/security/complete',{
      challenge:challenge.challenge,method:'totp',code:await createOTP(secret).totp(),
    });
    if(completed.verified!==true) throw new Error('Synthetic admin recent proof missing');
  }
  return {
    async entitlement(userId,enabled) {
      await ensureRecentAdmin();
      const path=`/admin/users/${encodeURIComponent(userId)}/entitlements`;
      if(enabled) {
        const previous=await request(path,undefined,'GET');
        const items=previous.data.filter(row=>!(row.subsystem==='calendar'&&row.capability==='external')
          &&!(row.subsystem==='cqu'&&['quicklogin','quicklogin_device_limit'].includes(row.capability)))
          .map(({subsystem,capability,value})=>({subsystem,capability,value}));
        items.push({subsystem:'calendar',capability:'external',value:'1'});
        await request(path,{items},'PUT');
      } else await request(`${path}/calendar/external`,undefined,'DELETE');
      const result=await request(path,undefined,'GET');
      const present=result.data.some(row=>row.subsystem==='calendar'&&row.capability==='external'&&row.value==='1');
      if(present!==enabled) throw new Error('Entitlement readback mismatch');
      return {enabled:present};
    },
    async ban(userId,banned) {
      await request(`/admin/users/${encodeURIComponent(userId)}`,{banned},'PATCH');
      const result=await request(`/admin/users/${encodeURIComponent(userId)}`,undefined,'GET');
      if(Boolean(result.data.banned)!==banned) throw new Error('Admin ban readback mismatch');
      return {banned:Boolean(result.data.banned)};
    },
  };
}
