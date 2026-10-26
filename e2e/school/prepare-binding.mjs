/** Consumer prerequisite: real central login and public binding APIs, with the
 * actual school Chromium/mail path. Never returns a central session or school token. */
import { turnstileHeaders } from '../turnstile.mjs';

export async function prepareSchoolBinding(runtime,{email='consumer@example.test',password='Synthetic-only-123!'}={}) {
  const identity=await runtime.prepare({email,password});
  const jar=new Map();
  async function request(path,body) {
    const response=await fetch(`${runtime.origin}/api/v1${path}`,{method:body===undefined?'GET':'POST',
      signal:AbortSignal.timeout(120000),headers:{origin:runtime.origin,'content-type':'application/json',
        ...turnstileHeaders(path,runtime.origin),
        cookie:[...jar].map(([key,value])=>`${key}=${value}`).join('; ')},...(body===undefined?{}:{body:JSON.stringify(body)})});
    for(const raw of response.headers.getSetCookie()) {const pair=raw.split(';')[0],index=pair.indexOf('=');jar.set(pair.slice(0,index),pair.slice(index+1));}
    if(!response.ok) throw new Error(`Consumer preparation failed (${response.status}, ${path})`);
    return response.json();
  }
  await request('/auth/sign-in/email',{email,password});
  try {
    await request('/cqu/binding',{kind:'direct'});
    const response=await fetch(`${runtime.origin}/api/v1/cqu/binding/credentials`,{method:'PUT',signal:AbortSignal.timeout(120000),
      headers:{origin:runtime.origin,'content-type':'application/json',cookie:[...jar].map(([key,value])=>`${key}=${value}`).join('; ')},
      body:JSON.stringify({studentId:'20990001',password:'School-synthetic-123!'})});
    if(!response.ok) throw new Error(`Consumer school binding failed (${response.status})`);
    await response.arrayBuffer();
    const snapshot=await request('/cqu/binding');
    if(snapshot.data.bindStatus!=='active' || snapshot.data.sessionStatus.status!=='active') throw new Error('Consumer school binding readback failed');
    return {...identity,password,studentId:'20990001'};
  } finally {
    await request('/auth/sign-out',{});
  }
}
