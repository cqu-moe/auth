import { WorkerEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import production from '../../src/index';
import { CquLoginContainer as BrowserContainer } from '../../src/durable-objects/cqu-login-container';
import { CquSessionRecoveryWorkflow as RecoveryWorkflow } from '../../src/workflows/cqu-session-recovery';
import { handleEmail } from '../../src/email-handler';
import type { Env, CquSessionRecoveryParams } from '../../src/types';
export { CquSessionDO, CquQuickloginAccountDO, CquQuickloginDeviceDO, AuthService } from '../../src/index';
let transportSequence = 0;
export default {
  ...production,
  async fetch(request, env, ctx) {
    if (request.method !== 'PUT' || new URL(request.url).pathname !== '/api/v1/cqu/binding/credentials') {
      return production.fetch(request, env, ctx);
    }
    const id = ++transportSequence;
    const emit = (event: string, status?: number) => console.info('AUTH_SCHOOL_TRANSPORT ' + JSON.stringify({
      side: 'worker', event, id, at: Date.now(), aborted: request.signal.aborted, ...(status === undefined ? {} : { status }),
    }));
    const aborted = () => emit('signal-abort');
    request.signal.addEventListener('abort', aborted, { once: true });
    emit('request');
    try {
      const response = await production.fetch(request, env, ctx);
      emit('response', response.status);
      return response;
    } catch (error) {
      emit('threw');
      throw error;
    } finally { request.signal.removeEventListener('abort', aborted); }
  },
} satisfies ExportedHandler<Env>;

// Configuration/observation only. All browser protocol requests run the production Container class.
export class CquLoginContainer extends BrowserContainer {
  override enableInternet = false;
  override async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/__fixture/')) {
      url.pathname = url.pathname.slice('/__fixture'.length);
      return this.containerFetch(new Request(url, request), 9090);
    }
    const response = await super.fetch(request);
    if (url.pathname === '/run') {
      const result = await response.clone().json<{ok?: boolean;errorCode?: string;phase?: string}>().catch(()=>null);
      await (this.env as Env & { EVIDENCE: D1Database }).EVIDENCE.prepare(
        'INSERT INTO browser_outcomes(ok,code,phase) VALUES (?,?,?)'
      ).bind(result?.ok ? 1:0,result?.errorCode ?? null,result?.phase ?? null).run();
    }
    return response;
  }
}

export class CquSessionRecoveryWorkflow extends RecoveryWorkflow {
  override async run(event: Readonly<WorkflowEvent<CquSessionRecoveryParams>>, step: WorkflowStep) {
    const evidence = (this.env as Env & { EVIDENCE: D1Database }).EVIDENCE;
    await evidence.prepare('INSERT OR IGNORE INTO workflows(id) VALUES (?)').bind(event.instanceId).run();
    return super.run(event, step);
  }
}

// Local email event transport: invokes the production email handler with the school's MIME.
// Only the private fixture Worker binds this entrypoint; it is never routed through the SPA.
export class SyntheticSchoolMail extends WorkerEntrypoint<Env> {
  async deliver(input: {to: string; code: string; kind?: string}) {
    const subject = input.kind === 'bind_confirm' ? '密保邮箱绑定验证码' : '邮件验证码登录';
    const raw = new TextEncoder().encode(`From: sso@cqu.edu.cn\r\nTo: ${input.to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n验证码为：${input.code}`);
    let rejection: string | null = null;
    await handleEmail({from:'sso@cqu.edu.cn',to:input.to,raw:raw.buffer,rawSize:raw.length,
      setReject:(reason: string)=>{rejection=reason;}, forward:()=>{throw new Error('Unexpected mail forward');},reply:()=>{throw new Error('Unexpected mail reply');},
    } as unknown as ForwardableEmailMessage, this.env);
    return {accepted:rejection===null,reason:rejection};
  }
}

export class WorkflowObserver extends WorkerEntrypoint<Env> {
  async status(id: string) {
    const instance = await this.env.CQU_SESSION_RECOVERY.get(id);
    return {id,...await instance.status()};
  }
}
