import { Hono, type Context } from 'hono';
import type { HonoEnv } from '../types';
import { createAuth } from '../auth';
import { verifyQuickloginBearer, QuickloginDeviceAuthError } from '../middleware/quicklogin-device-auth';
import { QuickloginAccountClient } from '../services/quicklogin/account-client';
import { QuickloginDeviceClient } from '../services/quicklogin/device-client';
import { QuickloginLoginBrokerClient } from '../services/quicklogin/login-broker-client';
import { getTrustedClientIp, readJson } from '../services/quicklogin/http';
import { hasQuickloginPolicy } from '../services/quicklogin/eligibility';
import { quickloginDeviceModeEnabled } from '../services/quicklogin/mode';
import { snapshotV3, unknownBinding } from '../services/quicklogin/snapshot-v3';
import { V3Error } from '../services/quicklogin/device-v3-store';
import { parseRegistrationRequest, parseReconcileRequest, parseOperationRequest, parseExportRequest, parseReceiptRequest, sameTuple, tupleForSnapshot, derivePresentation, type ReceiptAck, type DeviceSnapshot, type ReasonCode, type ActionCode } from '../services/quicklogin/protocol-v3';
const router = new Hono<HonoEnv>();
const BUILD = 'development';
const paths = ['/capabilities', '/registrations', '/overview', '/devices/:id/reconcile', '/devices/:id/operations', '/devices/:id/operations/:operationId', '/devices/:id/exports', '/devices/:id/receipts', '/devices/:id/resume-ticket'];
const meta = (c: Context<HonoEnv>, requestId = crypto.randomUUID()) => ({ protocolVersion: 3 as const, requestId, serverTime: Date.now(), serverBuild: c.env.QUICKLOGIN_SERVER_BUILD || BUILD });
const actionFor = (code: ReasonCode): ActionCode => code === 'BINDING_UNBOUND' ? 'bind_school' : code === 'CREDENTIALS_REJECTED' ? 'update_password' : code === 'INTERACTION_REQUIRED' ? 'complete_verification' : code === 'AUTH_RECONNECT_REQUIRED' || code === 'DEVICE_REVOKED' ? 'connect_auth' : code === 'PROTOCOL_UNSUPPORTED' ? 'update_extension' : 'reconcile';
function fail(c: Context<HonoEnv>, error: unknown, requestId?: string) {
 let code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : 'INTERNAL_STATE_UNAVAILABLE';
 const map: Record<string, ReasonCode> = { UNAUTHORIZED: 'AUTH_RECONNECT_REQUIRED', TEMPORARY_UNAVAILABLE: 'INTERNAL_STATE_UNAVAILABLE', STALE_GENERATION: 'STALE_SNAPSHOT', PREPARING: 'RECONCILING', NO_DEVICE_CAPACITY: 'QUOTA_BLOCKED', DEVICE_LIMIT_REACHED: 'QUOTA_BLOCKED' };
 code = map[code] ?? code;
 const status = code === 'AUTH_RECONNECT_REQUIRED' ? 401 : ['FORBIDDEN','DEVICE_REVOKED','MASTER_DISABLED','DEVICE_DISABLED','QUOTA_BLOCKED'].includes(code) ? 403 : ['STALE_SNAPSHOT','SESSION_CHANGED','IDEMPOTENCY_CONFLICT','RECONCILING'].includes(code) ? 409 : ['BINDING_UNBOUND','CREDENTIALS_REJECTED','INTERACTION_REQUIRED','INVALID_REQUEST','CONTRACT_INVALID'].includes(code) ? 422 : ['RATE_LIMITED','VERIFICATION_COOLDOWN'].includes(code) ? 429 : code === 'PROTOCOL_UNSUPPORTED' ? 426 : 503;
 const retryAt = error instanceof V3Error && error.retryAt !== null ? error.retryAt : status === 429 || status === 503 ? Date.now() + 60_000 : null;
 if (retryAt) c.header('Retry-After', String(Math.max(1, Math.ceil((retryAt - Date.now()) / 1000))));
 c.header('Content-Type', 'application/problem+json');
 return c.json({ type: `https://auth.cqu.moe/problems/${code.toLowerCase()}`, title: code, status, detail: code, code, requestId: requestId ?? crypto.randomUUID(), retryAt, action: actionFor(code as ReasonCode) }, status as never);
}
function currentAck(ack: Omit<ReceiptAck, 'snapshot'>, snapshot: DeviceSnapshot): ReceiptAck {
 if (ack.accepted && !sameTuple(ack.acceptedTuple, tupleForSnapshot(snapshot))) return { ...ack, accepted: false, acceptedTuple: null, reasonCode: 'STALE_SNAPSHOT', snapshot };
 return { ...ack, snapshot };
}
async function principal(c: Context<HonoEnv>, deviceId?: string) {
 if (c.req.header('Origin') !== c.env.QUICKLOGIN_EXTENSION_ORIGIN) throw new QuickloginDeviceAuthError('FORBIDDEN');
 if (!quickloginDeviceModeEnabled(c.env)) throw new V3Error('SERVICE_PAUSED');
 const p = await verifyQuickloginBearer(c.req.raw, c.env);
 if (deviceId && p.deviceId !== deviceId) throw new QuickloginDeviceAuthError('FORBIDDEN');
 return p;
}
async function website(c: Context<HonoEnv>, write = false) {
 if (c.req.header('Authorization')) throw new QuickloginDeviceAuthError('UNAUTHORIZED');
 if (write && c.req.header('Origin') !== new URL(c.env.BETTER_AUTH_URL).origin) throw new QuickloginDeviceAuthError('FORBIDDEN');
 const session = await createAuth(c.env, c.req.raw).api.getSession({ headers: c.req.raw.headers });
 if (!session?.user) throw new QuickloginDeviceAuthError('UNAUTHORIZED');
 if (!(await hasQuickloginPolicy(c.env.DATABASE, session.user.id))) throw new QuickloginDeviceAuthError('FORBIDDEN');
 return session.user;
}
for (const path of paths) {
 router.use(path, async (c, next) => {
  c.header('Cache-Control', 'no-store');
  if (c.req.header('Origin') === c.env.QUICKLOGIN_EXTENSION_ORIGIN && !c.req.path.endsWith('/resume-ticket') && !c.req.path.endsWith('/overview')) { c.header('Access-Control-Allow-Origin', c.env.QUICKLOGIN_EXTENSION_ORIGIN); c.header('Vary', 'Origin'); }
  await next();
 });
 router.options(path, c => {
  if (c.req.header('Origin') !== c.env.QUICKLOGIN_EXTENSION_ORIGIN || path.endsWith('/resume-ticket') || path === '/overview') return fail(c, new V3Error('FORBIDDEN'));
  const methods = path === '/capabilities' || path.includes(':operationId') ? 'GET' : 'POST';
  if (c.req.header('Access-Control-Request-Method') && c.req.header('Access-Control-Request-Method') !== methods) return fail(c, new V3Error('FORBIDDEN'));
  c.header('Access-Control-Allow-Methods', methods); c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type'); return c.body(null, 204);
 });
}
router.get('/capabilities', c => c.json({ data: { protocolVersion: 3, supportedProtocolVersions: [2,3], minExtensionVersion: '0.2.0', serverBuild: c.env.QUICKLOGIN_SERVER_BUILD || BUILD, features: { reconcile: true, operations: true, receipts: true, overview: true } }, meta: meta(c) }));
router.post('/registrations', async c => {
 let requestId: string | undefined;
 try { const p = await principal(c), input = parseRegistrationRequest(await readJson(c.req.raw)); requestId = input.requestId;
  const accounts = new QuickloginAccountClient(c.env), device = await accounts.registerV3(p.userId, p.grantId, input);
  // Keep existing user intent across upgrades; a new disabled device is enabled by its explicit operation.
  const snapshot = await snapshotV3(c.env, p.userId, device.deviceId);
  return c.json({ data: { deviceId: device.deviceId, snapshot }, meta: meta(c, requestId) });
 } catch (e) { return fail(c,e,requestId); }
});
router.post('/devices/:id/resume-ticket', async c => {
 try { const user = await website(c, true); return c.json({ data: await new QuickloginAccountClient(c.env).resumeTicket(user.id, c.req.param('id')), meta: meta(c) }); } catch(e) { return fail(c,e); }
});
router.get('/overview', async c => {
 try {
  const user = await website(c), accounts = new QuickloginAccountClient(c.env), broker = new QuickloginLoginBrokerClient(c.env);
  for (let attempt = 0; attempt < 2; attempt++) {
   const list = await accounts.listDevices(user.id, Date.now());
   const binding = await broker.getBindingSnapshot(user.id).catch(() => null);
   const devices = await Promise.all(list.devices.filter(d => d.revokedAt === null).map(d => snapshotV3(c.env, user.id, d.deviceId)));
   const after = await accounts.listDevices(user.id, Date.now());
   const afterBinding = await broker.getBindingSnapshot(user.id).catch(() => null);
   const stable = list.revision === after.revision && binding !== null && afterBinding !== null && binding.bindingRevision === afterBinding.bindingRevision && devices.every(d => d.versions.accountRevision === after.revision && d.versions.bindingRevision === afterBinding.bindingRevision);
   if (!stable && attempt === 0) continue;
   if (!stable) for (const snapshot of devices) {
    snapshot.observation = 'checking'; snapshot.cloud.usableUntil = null; snapshot.cloud.reasonCode = 'RECONCILING';
    snapshot.capabilities.canExport = false; snapshot.capabilities.canUseExistingSession = false;
    snapshot.presentation = derivePresentation(snapshot, {}, Date.now());
   }
   return c.json({ data: { binding: afterBinding ?? unknownBinding, accountRevision: after.revision, masterEnabled: after.masterEnabled, deviceLimit: after.deviceLimit, used: after.used, devices }, meta: meta(c) });
  }
  throw new V3Error('RECONCILING');
 } catch (e) { return fail(c,e); }
});
router.post('/devices/:id/reconcile', async c => {
 let requestId: string | undefined;
 try { const p = await principal(c,c.req.param('id')), input = parseReconcileRequest(await readJson(c.req.raw)); requestId = input.requestId;
  const accounts = new QuickloginAccountClient(c.env), devices = new QuickloginDeviceClient(c.env), a = await accounts.getDeviceAuthority(p.userId,p.deviceId!);
  await devices.consumeRateLimit(p.userId,p.deviceId!,'status',30,Date.now());
  await accounts.heartbeat(p.userId,p.deviceId!, { protocolVersion: 2, appliedVersion: null, observedGeneration: input.observed?.generation ?? a.generation, browserVersion: input.client.browserVersion },getTrustedClientIp(c.req.raw),Date.now());
  await devices.readV3(a);
  let ack = input.local.receipt ? await devices.receiptV3(a, { protocolVersion: 3, requestId: input.requestId, reportEpoch: input.reportEpoch, clientReportSeq: input.clientReportSeq, receipt: input.local.receipt }) : null;
  await devices.reportV3(a,input);
  const read = await devices.readV3(a); await accounts.projectV3(p.userId,p.deviceId!,p.grantId,read.report,read.client);
  const snapshot = await snapshotV3(c.env,p.userId,p.deviceId!);
  return c.json({ data: { snapshot, receiptAck: ack ? currentAck(ack, snapshot) : null }, meta: meta(c, requestId) });
 } catch(e) { return fail(c,e,requestId); }
});
router.post('/devices/:id/operations', async c => {
 let requestId: string | undefined;
 try { const p = await principal(c,c.req.param('id')), input = parseOperationRequest(await readJson(c.req.raw)); requestId=input.requestId;
  const devices = new QuickloginDeviceClient(c.env), a = await new QuickloginAccountClient(c.env).getDeviceAuthority(p.userId,p.deviceId!);
  await devices.consumeRateLimit(p.userId,p.deviceId!,'refresh',6,Date.now());
  const operation = await devices.operateV3(a,input), snapshot = await snapshotV3(c.env,p.userId,p.deviceId!);
  return c.json({ data: { operation,snapshot }, meta: meta(c, requestId) },202);
 } catch(e) { return fail(c,e,requestId); }
});
router.get('/devices/:id/operations/:operationId', async c => {
 try { const p=await principal(c,c.req.param('id')), a=await new QuickloginAccountClient(c.env).getDeviceAuthority(p.userId,p.deviceId!);
  const operation=await new QuickloginDeviceClient(c.env).operationV3(a,c.req.param('operationId')), snapshot=await snapshotV3(c.env,p.userId,p.deviceId!);
  return c.json({ data:{operation,snapshot},meta:meta(c) });
 } catch(e){return fail(c,e);}
});
router.post('/devices/:id/exports', async c => {
 let requestId:string|undefined;
 try{const p=await principal(c,c.req.param('id')),input=parseExportRequest(await readJson(c.req.raw));requestId=input.requestId;
  const accounts=new QuickloginAccountClient(c.env), devices=new QuickloginDeviceClient(c.env), a=await accounts.getDeviceAuthority(p.userId,p.deviceId!);
  await devices.consumeRateLimit(p.userId,p.deviceId!,'export',12,Date.now());
  const envelope=await devices.exportV3(a,input.expected);
  const live=await accounts.getDeviceAuthority(p.userId,p.deviceId!), binding=await new QuickloginLoginBrokerClient(c.env).getBindingSnapshot(p.userId);
  if(!live.allowed||live.grantId!==p.grantId||live.generation!==envelope.generation||binding.state!=='bound'||binding.bindingEpoch!==envelope.bindingEpoch||binding.credentialRevision!==envelope.credentialRevision)throw new V3Error('STALE_SNAPSHOT');
  return c.json({data:envelope,meta:meta(c, requestId)});
 }catch(e){return fail(c,e,requestId);}
});
router.post('/devices/:id/receipts', async c=>{
 let requestId:string|undefined;
 try{const p=await principal(c,c.req.param('id')),input=parseReceiptRequest(await readJson(c.req.raw));requestId=input.requestId;
  const accounts=new QuickloginAccountClient(c.env),devices=new QuickloginDeviceClient(c.env),a=await accounts.getDeviceAuthority(p.userId,p.deviceId!);
  await devices.consumeRateLimit(p.userId,p.deviceId!,'status',30,Date.now());
  const ack=await devices.receiptV3(a,input),read=await devices.readV3(a);
  await accounts.projectV3(p.userId,p.deviceId!,p.grantId,read.report,read.client);
  const snapshot=await snapshotV3(c.env,p.userId,p.deviceId!);
  return c.json({data:currentAck(ack,snapshot),meta:meta(c, requestId)});
 }catch(e){return fail(c,e,requestId);}
});
export { router as cquQuickloginV3 };
