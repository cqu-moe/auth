import { test, beforeEach, afterEach } from '@e2e-dev/web';
import { expect, credentials } from 'e2e';
import type { TestFixtures } from 'e2e';
import type { Browser } from '@e2e-dev/web';

type Journey = TestFixtures & {browser:Browser};

let unexpected: string[];
beforeEach(async ({browser}) => {
  unexpected = [];
  await browser.route('**/*', async route => {
    if (new URL(route.request.url).origin !== process.env.AUTH_E2E_URL) {
      unexpected.push(new URL(route.request.url).origin);
      await route.abort();
    } else await route.continue();
  });
});
afterEach(async () => { expect(unexpected).toEqual([]); });

async function control(path: string, body: Record<string, unknown> = {}) {
  const response = await fetch(`${process.env.AUTH_SCHOOL_CONTROL}${path}`, {
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(150000),
  });
  if (!response.ok) throw new Error(`School test control failed (${response.status})`);
  return response.json();
}
async function eventually<T>(read:()=>Promise<T>, matches:(value:T)=>boolean, timeout=90000):Promise<T> {
  const end=Date.now()+timeout;
  let last:T;
  do {last=await read();if(matches(last)) return last;await new Promise(r=>setTimeout(r,200));} while(Date.now()<end);
  throw new Error('Required business state did not arrive before deadline');
}
async function login({app,screen,browser}:Journey,email:string) {
  await control('/prepare',{email});
  await app.open('/login');
  await screen.getByLabel('邮箱', {exact:true}).fill(email);
  await browser.locator('#password').fill(credentials.user('journey').password);
  await screen.getByRole('button', '登录', {exact:true}).click();
  await expect(browser).toHaveURL(/settings/);
}
async function beginBinding({app,screen,browser}:Journey) {
  await app.open('/cqu/bind');
  await screen.getByRole('button','开始绑定').click();
  await screen.getByRole('button','已在 CQU 完成验证，继续').click();
  await screen.getByLabel('统一身份认证账号',{exact:true}).fill(credentials.user('school').username);
  await screen.getByLabel('CQU 统一认证密码',{exact:true}).fill(credentials.user('school').password);
}
async function binding(browser:Browser) {
  return browser.evaluate(async()=>{
    const r=await fetch('/api/v1/cqu/binding');
    const body=await r.json();
    return {http:r.status,bindStatus:body.data?.bindStatus,sessionStatus:body.data?.sessionStatus?.status};
  });
}
async function unbind(browser:Browser) {
  expect(await browser.evaluate(async()=>(await fetch('/api/v1/cqu/binding',{method:'DELETE'})).status)).toBe(204);
  expect(await binding(browser)).toEqual({http:200,bindStatus:'unbound',sessionStatus:'unbound'});
}

test('school binding persists and returns an allowed business directory through the real container', async context => {
  const {app,screen,browser}=context;
  await app.open('/login');
  if(process.env.AUTH_SCHOOL_BREAK_ASSERTION==='1') {
    await expect(screen.getByRole('heading','欢迎回来',{exact:true})).toHaveText('故意错误的学校绑定入口',{timeout:1000});
  }
  await screen.getByLabel('邮箱', {exact:true}).fill(credentials.user('journey').username);
  await browser.locator('#password').fill(credentials.user('journey').password);
  await screen.getByRole('button', '登录', {exact:true}).click();
  await expect(browser).toHaveURL(/settings/);
  await app.open('/cqu/bind');
  await screen.getByRole('button', '开始绑定').click();
  await screen.getByRole('button', '已在 CQU 完成验证，继续').click();
  await screen.getByLabel('统一身份认证账号', {exact:true}).fill(credentials.user('school').username);
  await screen.getByLabel('CQU 统一认证密码', {exact:true}).fill(credentials.user('school').password);
  await screen.getByRole('button', '确认绑定', {exact:true}).click();
  await expect(screen.getByText('绑定成功', {exact:true})).toBeVisible();
  await browser.reload();
  await expect(screen.getByText('绑定成功', {exact:true})).toBeVisible();
  const snapshot = await browser.evaluate(async () => (await (await fetch('/api/v1/cqu/binding')).json()).data);
  expect(snapshot.bindStatus).toBe('active');
  expect(snapshot.sessionStatus.status).toBe('active');
  expect(await control('/directory')).toEqual({contractVersion:1,kind:'catalog',sourceType:'course_catalog',
    session:{id:'202610',name:'2099-2100秋'},items:[{id:'31',name:'合成电路',extra:'SYN101',courseCode:'SYN101'}]});
  expect(await control('/directory',{recipe:{sourceType:'admin_class'}})).toEqual({contractVersion:1,kind:'catalog',sourceType:'admin_class',
    session:{id:'202610',name:'2099-2100秋'},items:[{id:'21',name:'合成班级',extra:'合成学院',departmentId:'12',grade:'2099'}]});
  expect(await control('/directory',{recipe:{kind:'instructors',classIds:['61','62']}})).toEqual({contractVersion:1,kind:'instructors',
    session:{id:'202610',name:'2099-2100秋'},classes:[
      {classId:'61',items:[{id:'51',name:'合成教师',extra:'T01 / 合成学院',departmentId:'12'}]},
      {classId:'62',items:[]},
    ]});
  expect(await control('/directory',{unapproved:true})).toEqual({error:'FORBIDDEN'});
  expect(await control('/directory',{recipe:{url:'https://evil.example/'}})).toEqual({error:'INVALID_REQUEST'});
  await control('/fixture',{changes:{mode:'schema_error'}});
  expect(await control('/directory')).toEqual({error:'SCHEMA_INVALID'});
  await control('/fixture',{changes:{mode:'success',session:'202611'}});
  expect(await control('/directory')).toEqual({error:'CURRENT_SESSION_CHANGED'});
  await control('/fixture',{changes:{mode:'drift_after',session:'202610'}});
  expect(await control('/directory')).toEqual({error:'CURRENT_SESSION_CHANGED'});
  await control('/fixture',{changes:{session:'202610',expire:true}});
  expect(await control('/directory')).toEqual({error:'TGT_EXPIRED'});
  await eventually(()=>browser.evaluate(async ()=>(await (await fetch('/api/v1/cqu/binding')).json()).data.sessionStatus.status),value=>value==='active');
  const workflows=await eventually(()=>control('/workflows'),value=>value.some((item:{status:string;output?:{state:string;cleanupComplete:boolean}})=>item.status==='complete'&&item.output?.state==='complete'&&item.output?.cleanupComplete));
  expect(workflows.some((item:{status:string})=>item.status==='complete')).toBe(true);
  expect((await control('/directory')).items).toEqual([{id:'31',name:'合成电路',extra:'SYN101',courseCode:'SYN101'}]);
  const central=await browser.evaluate(async ()=>(await (await fetch('/api/v1/auth/get-session')).json()).user.twoFactorEnabled);
  expect(Boolean(central)).toBe(false);
  await control('/fixture',{changes:{hold:true,clearEvents:true}});
  const afterRevoke=control('/directory');
  await eventually(()=>control('/fixture'),value=>value.events.some((e:{kind:string})=>e.kind==='directory_requested'));
  expect(await control('/entitlement',{enabled:false})).toEqual({enabled:false});
  await control('/fixture',{changes:{hold:false}});
  expect(await afterRevoke).toEqual({error:'FORBIDDEN'});
  expect(await control('/directory')).toEqual({error:'FORBIDDEN'});
  expect(await control('/entitlement',{enabled:true})).toEqual({enabled:true});
  await control('/fixture',{changes:{hold:true,clearEvents:true}});
  const afterBan=control('/directory');
  await eventually(()=>control('/fixture'),value=>value.events.some((e:{kind:string})=>e.kind==='directory_requested'));
  expect(await control('/ban',{banned:true})).toEqual({banned:true});
  expect(await browser.evaluate(async()=>(await fetch('/api/v1/cqu/binding')).status)).toBe(401);
  await control('/fixture',{changes:{hold:false}});
  expect(await afterBan).toEqual({error:'SESSION_INACTIVE'});
  expect(await control('/directory')).toEqual({error:'FORBIDDEN'});
  expect(await control('/ban',{banned:false})).toEqual({banned:false});
  await login(context,'journey@example.test');
  expect(await binding(browser)).toEqual({http:200,bindStatus:'active',sessionStatus:'active'});
  expect((await control('/directory')).items).toEqual([{id:'31',name:'合成电路',extra:'SYN101',courseCode:'SYN101'}]);
  await control('/fixture',{changes:{hold:true,clearEvents:true}});
  const afterUnbind=control('/directory');
  await eventually(()=>control('/fixture'),value=>value.events.some((e:{kind:string})=>e.kind==='directory_requested'));
  await unbind(browser);
  await control('/fixture',{changes:{hold:false}});
  expect(await afterUnbind).toEqual({error:'SESSION_INACTIVE'});
  expect(await control('/directory')).toEqual({error:'NO_CQU_BINDING'});
  await browser.reload();
  expect(await binding(browser)).toEqual({http:200,bindStatus:'unbound',sessionStatus:'unbound'});
});

for (const [mode,code] of [['reject','PASSWORD_REJECTED'],['send_reject','OTP_SEND_FAILED'],['send_timeout','OTP_SEND_TIMEOUT'],['wrong_code','TICKET_MISSING']] as const) {
  test(`school ${mode} has a terminal failure and cannot create a binding`,async context=>{
    const email=`${mode}@example.test`;
    await login(context,email);
    await beginBinding(context);
    await control('/fixture',{email,changes:{mode}});
    const response=context.browser.waitForResponse('**/api/v1/cqu/binding/credentials',{timeout:120000});
    await context.screen.getByRole('button','确认绑定',{exact:true}).click();
    const failure=await response;
    expect(failure.status).toBe(400);
    expect((await failure.json<{code:string}>()).code).toBe('CQU_LOGIN_FAILED');
    await expect(context.screen.getByRole('alert')).toBeVisible();
    expect(await binding(context.browser)).toEqual({http:200,bindStatus:'pending',sessionStatus:'unbound'});
    const outcomes=await control('/outcomes',{email});
    expect(outcomes.at(-1)).toEqual({ok:0,code,phase:mode==='reject'?'first_factor':mode==='wrong_code'?'validating_session':'sending_code'});
    expect(await control('/directory',{email})).toEqual({error:'NO_CQU_BINDING'});
    await unbind(context.browser);
  });
}

test('unbinding cancels a running school login and its late response cannot activate a new binding',async context=>{
  const email='cancel@example.test';
  await login(context,email);
  await beginBinding(context);
  await control('/fixture',{email,changes:{holdLogin:true,clearEvents:true}});
  const response=context.browser.waitForResponse('**/api/v1/cqu/binding/credentials',{timeout:120000});
  await context.screen.getByRole('button','确认绑定',{exact:true}).click();
  await eventually(()=>control('/fixture',{email}),value=>value.events.some((e:{kind:string})=>e.kind==='code_accepted'));
  await unbind(context.browser);
  await control('/fixture',{email,changes:{holdLogin:false}});
  expect((await response).status).toBe(400);
  await eventually(()=>control('/fixture',{email}),value=>value.events.some((e:{kind:string})=>e.kind==='login_replied'));
  await context.browser.reload();
  expect(await binding(context.browser)).toEqual({http:200,bindStatus:'unbound',sessionStatus:'unbound'});
  expect(await control('/directory',{email})).toEqual({error:'NO_CQU_BINDING'});
});

test('banning during school login rejects the old result and keeps business denied after unban',async context=>{
  const email='ban@example.test';
  await login(context,email);
  await beginBinding(context);
  await control('/fixture',{email,changes:{holdLogin:true,clearEvents:true}});
  const response=context.browser.waitForResponse('**/api/v1/cqu/binding/credentials',{timeout:120000});
  await context.screen.getByRole('button','确认绑定',{exact:true}).click();
  await eventually(()=>control('/fixture',{email}),value=>value.events.some((e:{kind:string})=>e.kind==='code_accepted'));
  expect(await control('/ban',{email,banned:true})).toEqual({banned:true});
  expect(await context.browser.evaluate(async()=>(await fetch('/api/v1/cqu/binding')).status)).toBe(401);
  expect(await control('/directory',{email})).toEqual({error:'FORBIDDEN'});
  await control('/fixture',{email,changes:{holdLogin:false}});
  expect((await response).status).toBe(400);
  expect(await control('/ban',{email,banned:false})).toEqual({banned:false});
  await login(context,email);
  expect(await binding(context.browser)).toEqual({http:200,bindStatus:'pending',sessionStatus:'unbound'});
  expect(await control('/directory',{email})).toEqual({error:'NO_CQU_BINDING'});
  await unbind(context.browser);
});

for(const action of ['unbind','ban'] as const) {
  test(`a real recovery Workflow discards its late school result after ${action}`,async context=>{
    const email=`recovery-${action}@example.test`;
    await login(context,email);
    await beginBinding(context);
    await context.screen.getByRole('button','确认绑定',{exact:true}).click();
    await expect(context.screen.getByText('绑定成功',{exact:true})).toBeVisible();
    expect(await binding(context.browser)).toEqual({http:200,bindStatus:'active',sessionStatus:'active'});
    await control('/fixture',{email,changes:{expire:true,holdLogin:true,clearEvents:true}});
    expect(await control('/directory',{email})).toEqual({error:'TGT_EXPIRED'});
    await eventually(()=>control('/fixture',{email}),value=>value.events.some((e:{kind:string})=>e.kind==='code_accepted'));
    const running=await eventually(()=>control('/workflows',{email}),value=>value.some((item:{status:string})=>item.status==='running'));
    const recoveryIds=running.filter((item:{status:string})=>item.status==='running').map((item:{id:string})=>item.id);
    if(action==='unbind') await unbind(context.browser);
    else {
      expect(await control('/ban',{email,banned:true})).toEqual({banned:true});
      expect(await context.browser.evaluate(async()=>(await fetch('/api/v1/cqu/binding')).status)).toBe(401);
      expect(await control('/directory',{email})).toEqual({error:'FORBIDDEN'});
    }
    await control('/fixture',{email,changes:{holdLogin:false}});
    const terminal=await eventually(()=>control('/workflows',{email}),value=>recoveryIds.every((id:string)=>value.some(
      (item:{id:string;status:string;output?:{cleanupComplete:boolean}})=>item.id===id&&item.status==='complete'&&item.output?.cleanupComplete)));
    for(const id of recoveryIds) expect(terminal.find((item:{id:string})=>item.id===id).output.state).toBe(action==='ban'?'failed':'complete');
    if(action==='ban') {
      expect(await control('/directory',{email})).toEqual({error:'FORBIDDEN'});
      expect(await control('/ban',{email,banned:false})).toEqual({banned:false});
      await login(context,email);
      await unbind(context.browser);
    }
    await context.browser.reload();
    expect(await binding(context.browser)).toEqual({http:200,bindStatus:'unbound',sessionStatus:'unbound'});
    expect(await control('/directory',{email})).toEqual({error:'NO_CQU_BINDING'});
  });
}
