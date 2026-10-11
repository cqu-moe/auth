import type { Env } from '../../types';
import type { DeviceAuthority, StoredDeviceSession } from './contracts';
import type { BindingSnapshot } from './binding-snapshot';
import { QuickloginAccountClient } from './account-client';
import { QuickloginLoginBrokerClient } from './login-broker-client';
import { extractSsoCookies } from './cookie-envelope';
import { BROWSER_INVOCATION_BUDGET_MS, BROWSER_CLEANUP_MARGIN_MS } from '../cqu-browser-budget';
import { parseOperationRequest, parseReceiptRequest, parseReconcileRequest, sameTuple, type Operation, type OperationRequest, type ReasonCode, type ReportedLocal, type VersionTuple, type ExportEnvelope, type ReceiptRequest, type ClientMetadata } from './protocol-v3';
export class V3Error extends Error { constructor(readonly code: ReasonCode, readonly retryAt: number | null = null) { super(code); } }
export interface DeviceV3Read { session: StoredDeviceSession; report: ReportedLocal | null; operation: Operation | null; client: ClientMetadata | null }
interface StoredOperation { operation: Operation; leaseToken: string; grantId: string; fingerprint: string; expiresAt: number }
interface IssuedExport { tuple: VersionTuple; grantId: string; createdAt: number; applyBefore: number; expiresAt: number }
interface ReportEpoch { epoch: string; grantId: string }
const SESSION = 'session', ACTIVE = 'v3:active', REPORT = 'v3:report', EPOCH = 'v3:reportEpoch';
export function sessionTuple(session: StoredDeviceSession): VersionTuple {
 return { deviceId: session.deviceId, generation: session.generation, bindingEpoch: session.bindingEpoch, credentialRevision: session.credentialRevision ?? session.bindingEpoch, sessionVersion: session.sessionVersion };
}
export async function settleV3Operation(tx: DurableObjectTransaction, session: StoredDeviceSession): Promise<void> {
 if (!session.operationId) return;
 const stored = await tx.get<StoredOperation>(ACTIVE);
 const current = await tx.get<StoredDeviceSession>(SESSION);
 if (!stored || stored.operation.operationId !== session.operationId || stored.leaseToken !== session.leaseToken || current?.operationId !== session.operationId || current.leaseToken !== session.leaseToken || !['queued', 'running'].includes(stored.operation.state)) return;
 stored.operation = { ...stored.operation, state: session.state === 'ready' ? 'succeeded' : session.state === 'needs_reauth' ? 'blocked' : 'retry_wait', stage: null, completedAt: Date.now(), retryAt: session.nextAttemptAt, resultCode: session.reasonCode ?? null };
 delete current.operationId;
 delete current.leaseToken;
 await tx.put({ [ACTIVE]: stored, [`v3:operation:${stored.operation.operationId}`]: stored, [SESSION]: current });
}
export class DeviceV3Store {
 constructor(private readonly storage: DurableObjectStorage, private readonly env: Env,
   private readonly notify: (a: DeviceAuthority) => Promise<void>) {}
 private async binding(a: DeviceAuthority) { return new QuickloginLoginBrokerClient(this.env).getBindingSnapshot(a.ownerUserId); }
 private async authority(a: DeviceAuthority) {
  const live = await new QuickloginAccountClient(this.env).getDeviceAuthority(a.ownerUserId, a.deviceId);
  if (live.grantId !== a.grantId || live.reason === 'DEVICE_REVOKED') throw new V3Error('DEVICE_REVOKED');
  return live;
 }
 private assertAllowed(a: DeviceAuthority) {
  if (!a.allowed) throw new V3Error(a.reason === 'MASTER_DISABLED' ? 'MASTER_DISABLED' : a.reason === 'DEVICE_DISABLED' ? 'DEVICE_DISABLED' : a.reason === 'DEVICE_REVOKED' ? 'DEVICE_REVOKED' : 'QUOTA_BLOCKED');
 }
 private assertBinding(b: BindingSnapshot) {
  if (b.state !== 'bound') throw new V3Error(b.state === 'updating' ? 'BINDING_UPDATING' : b.state === 'unbound' ? 'BINDING_UNBOUND' : 'INTERNAL_STATE_UNAVAILABLE');
 }
 async read(a: DeviceAuthority): Promise<DeviceV3Read> {
  const live = await this.authority(a);
  if (((await this.storage.get<number>('v3:lastPrune')) ?? 0) + 60 * 60_000 < Date.now()) {
   const now = Date.now();
   await this.storage.transaction(async tx => {
    for (const prefix of ['v3:operation:', 'v3:export:']) {
     const entries = await tx.list<{ expiresAt: number }>({ prefix });
     const expired = [...entries].filter(([, value]) => value.expiresAt <= now).map(([key]) => key);
     if (expired.length) await tx.delete(expired);
    }
    const keys = await tx.list<{ operationId: string }>({ prefix: 'v3:key:' });
    for (const [key, value] of keys) if (!(await tx.get(`v3:operation:${value.operationId}`))) await tx.delete(key);
    await tx.put('v3:lastPrune', now);
   });
  }
  let session = await this.storage.get<StoredDeviceSession>(SESSION);
  if (!session || session.generation !== live.generation || (!live.allowed && !['paused','disabled','revoked'].includes(session.state))) {
   await this.notify(live); session = await this.storage.get<StoredDeviceSession>(SESSION);
  }
  if (!session) throw new V3Error('INTERNAL_STATE_UNAVAILABLE');
  let binding: BindingSnapshot | null = null;
  try { binding = await this.binding(live); } catch { /* Readiness is withheld by the aggregator when binding authority is unavailable. */ }
  if (binding) {
   const changed = session.bindingEpoch !== binding.bindingEpoch || (session.credentialRevision ?? session.bindingEpoch) !== binding.credentialRevision;
   const recoverableLegacyReason = session.reasonCode == null || session.reasonCode === 'BLOCKED_UNKNOWN' || session.reasonCode === 'BINDING_UNBOUND';
   const legacy = live.allowed && recoverableLegacyReason && session.state === 'needs_reauth' && binding.state === 'bound' && binding.credentialsState !== 'rejected' && binding.credentialsState !== 'interaction_required' && session.legacyRecoveryEpoch !== binding.bindingEpoch;
   if (changed || legacy) {
    await this.storage.transaction(async tx => {
     const current = await tx.get<StoredDeviceSession>(SESSION);
     if (!current || current.generation !== live.generation) return;
     session = { ...current, bindingEpoch: binding!.bindingEpoch, credentialRevision: binding!.credentialRevision,
       // Keep disabled/paused devices aligned without starting a school session.
       state: !live.allowed ? current.state : binding!.state === 'bound' ? 'preparing' : 'needs_reauth',
       reasonCode: !live.allowed ? current.reasonCode : binding!.state === 'bound' ? null : binding!.state === 'updating' ? 'BINDING_UPDATING' : 'BINDING_UNBOUND',
       storageState: changed ? null : current.storageState, exportDigest: changed ? null : current.exportDigest,
       legacyRecoveryEpoch: binding!.bindingEpoch, deviceRevision: (current.deviceRevision ?? 0) + 1, nextAttemptAt: null };
     delete session.operationId; delete session.leaseToken;
     await tx.put(SESSION, session); await tx.delete(REPORT);
     if (live.allowed && binding!.state === 'bound') await tx.setAlarm(Date.now());
    });
   }
  }
  let active = await this.storage.get<StoredOperation>(ACTIVE);
  if (active && ['running','queued'].includes(active.operation.state)) {
   const invalid = !live.allowed || !sameTuple(active.operation.versions, sessionTuple(session));
   const timedOut = active.operation.deadlineAt !== null && active.operation.deadlineAt + BROWSER_CLEANUP_MARGIN_MS < Date.now();
   if (invalid || timedOut) {
    await this.storage.transaction(async tx => {
     const current = await tx.get<StoredOperation>(ACTIVE);
     if (!current || current.operation.operationId !== active!.operation.operationId) return;
     current.operation.state = invalid ? 'cancelled' : 'retry_wait';
     current.operation.cancelReason = invalid ? 'STALE_SNAPSHOT' : null;
     current.operation.resultCode = invalid ? 'STALE_SNAPSHOT' : 'OPERATION_TIMEOUT';
     current.operation.completedAt = Date.now(); current.operation.retryAt = timedOut ? Date.now() + 60_000 : null;
     await tx.put({ [ACTIVE]: current, [`v3:operation:${current.operation.operationId}`]: current });
     const value = await tx.get<StoredDeviceSession>(SESSION);
     if (value?.operationId === current.operation.operationId) {
      delete value.operationId; delete value.leaseToken;
      if (timedOut && live.allowed) { value.state = 'temporary_unavailable'; value.reasonCode = 'OPERATION_TIMEOUT'; value.nextAttemptAt = current.operation.retryAt; await tx.setAlarm(value.nextAttemptAt!); }
      await tx.put(SESSION, value); session = value;
     }
     active = current;
    });
   }
  }
  if (live.allowed && binding?.state === 'bound' && binding.credentialsState !== 'rejected' && binding.credentialsState !== 'interaction_required') {
   await this.storage.transaction(async tx => {
    const current = await tx.get<StoredDeviceSession>(SESSION);
    const operation = await tx.get<StoredOperation>(ACTIVE);
    if (!current || current.generation !== live.generation || current.bindingEpoch !== binding!.bindingEpoch ||
        (current.credentialRevision ?? current.bindingEpoch) !== binding!.credentialRevision ||
        current.state !== 'preparing' || current.storageState || current.operationId ||
        current.reasonCode === 'INTERACTION_REQUIRED' ||
        (operation && ['queued', 'running'].includes(operation.operation.state)) ||
        !(await tx.get('v3:client')) || (await tx.getAlarm()) !== null) return;
    await tx.setAlarm(Math.max(Date.now(), current.nextAttemptAt ?? 0));
   });
  }
  return { session, report: (await this.storage.get<ReportedLocal>(REPORT)) ?? null, operation: active?.operation ?? null, client: (await this.storage.get<ClientMetadata>('v3:client')) ?? null };
 }
 async operation(a: DeviceAuthority, raw: unknown): Promise<Operation> {
  const input = parseOperationRequest(raw), live = await this.authority(a);
  const fingerprint = JSON.stringify({ command: input.command, expected: input.expected, enabled: input.enabled ?? null });
  const key = `v3:key:${a.grantId}:${input.idempotencyKey}`;
  const previousKey = await this.storage.get<{ operationId: string; fingerprint: string }>(key);
  const previousId = previousKey?.operationId;
  if (previousId) {
   const previous = await this.storage.get<StoredOperation>(`v3:operation:${previousId}`);
   if (previous && previous.expiresAt > Date.now()) {
    if (previousKey!.fingerprint !== fingerprint) throw new V3Error('IDEMPOTENCY_CONFLICT');
    if (previous.operation.command === 'set_enabled' && previous.operation.state === 'queued') return this.completeEnabled(live, previous.operation, input.enabled!);
    return previous.operation;
   }
  }
  const read = await this.read(live), binding = await this.binding(live);
  if (!sameTuple(input.expected, sessionTuple(read.session)) || live.generation !== input.expected.generation || input.expected.bindingEpoch !== binding.bindingEpoch || input.expected.credentialRevision !== binding.credentialRevision) throw new V3Error('STALE_SNAPSHOT');
  if (input.command !== 'set_enabled') {
   this.assertAllowed(live); this.assertBinding(binding);
   if (binding.credentialsState === 'rejected' && binding.evidenceCredentialRevision === binding.credentialRevision) throw new V3Error('CREDENTIALS_REJECTED');
   if (binding.credentialsState === 'interaction_required' || read.session.reasonCode === 'INTERACTION_REQUIRED') throw new V3Error('INTERACTION_REQUIRED');
   if (read.session.nextAttemptAt !== null && read.session.nextAttemptAt > Date.now()) throw new V3Error('VERIFICATION_COOLDOWN', read.session.nextAttemptAt);
  }
  const now = Date.now(); let result!: Operation;
  await this.storage.transaction(async tx => {
   const session = await tx.get<StoredDeviceSession>(SESSION);
   if (!session || !sameTuple(input.expected, sessionTuple(session))) throw new V3Error('STALE_SNAPSHOT');
   if (input.command !== 'set_enabled' && session.reasonCode === 'INTERACTION_REQUIRED') throw new V3Error('INTERACTION_REQUIRED');
   const active = await tx.get<StoredOperation>(ACTIVE);
   if (input.command !== 'set_enabled' && active && ['running','queued'].includes(active.operation.state) && sameTuple(active.operation.versions, input.expected)) { result = active.operation; await tx.put(key, { operationId: result.operationId, fingerprint }); return; }
   const operation: Operation = { operationId: crypto.randomUUID(), command: input.command, versions: input.expected, state: 'queued', stage: 'waiting_capacity', attempt: 0, createdAt: now, startedAt: null, deadlineAt: now + BROWSER_INVOCATION_BUDGET_MS, completedAt: null, retryAt: null, resultCode: null, cancelReason: null };
   if (input.command === 'ensure_session' && session.state === 'ready' && session.storageState) { operation.state = 'succeeded'; operation.stage = null; operation.completedAt = now; }
   const stored: StoredOperation = { operation, fingerprint, grantId: a.grantId, leaseToken: crypto.randomUUID(), expiresAt: now + 24 * 60 * 60_000 };
   await tx.put({ [ACTIVE]: stored, [`v3:operation:${operation.operationId}`]: stored, [key]: { operationId: operation.operationId, fingerprint } });
   if (operation.state === 'queued' && input.command !== 'set_enabled') {
    delete session.pendingKeepaliveMint;
    await tx.delete('pendingKeepaliveState');
    session.operationId = operation.operationId; session.leaseToken = stored.leaseToken; session.reasonCode = null; session.state = session.storageState ? 'refreshing' : 'preparing'; session.nextAttemptAt = null; session.deviceRevision = (session.deviceRevision ?? 0) + 1;
    await tx.put(SESSION, session); await tx.setAlarm(now);
   }
   result = operation;
  });
  if (input.command === 'set_enabled') return this.completeEnabled(live, result, input.enabled!);
  return result;
 }
 private async completeEnabled(a: DeviceAuthority, operation: Operation, enabled: boolean): Promise<Operation> {
  const accounts = new QuickloginAccountClient(this.env);
  let live = await this.authority(a);
  if (live.enabled !== enabled) {
   if (live.generation !== operation.versions.generation) throw new V3Error('STALE_SNAPSHOT');
   live = await accounts.setDeviceEnabled(a.ownerUserId, a.deviceId, enabled, operation.versions.generation);
  }
  await this.notify(live);
  const result: Operation = { ...operation, state: 'succeeded', stage: null, completedAt: Date.now() };
  await this.storage.transaction(async tx => {
   const key = `v3:operation:${operation.operationId}`, stored = await tx.get<StoredOperation>(key);
   if (!stored) throw new V3Error('INTERNAL_STATE_UNAVAILABLE');
   stored.operation = result; await tx.put(key, stored);
   if ((await tx.get<StoredOperation>(ACTIVE))?.operation.operationId === operation.operationId) await tx.put(ACTIVE, stored);
  });
  return result;
 }
 async getOperation(a: DeviceAuthority, id: string): Promise<Operation> {
  await this.read(a);
  const stored = await this.storage.get<StoredOperation>(`v3:operation:${id}`);
  if (!stored || stored.expiresAt <= Date.now() || stored.grantId !== a.grantId) throw new V3Error('FORBIDDEN');
  return stored.operation;
 }
 async markRunning(session: StoredDeviceSession, authority?: DeviceAuthority): Promise<StoredDeviceSession | null> {
  return this.storage.transaction(async tx => {
   const current = await tx.get<StoredDeviceSession>(SESSION);
   if (!current || !sameTuple(sessionTuple(current), sessionTuple(session)) || current.operationId !== session.operationId || current.leaseToken !== session.leaseToken || ['disabled', 'revoked', 'paused'].includes(current.state)) return null;
   let stored = await tx.get<StoredOperation>(ACTIVE);
   const now = Date.now();
   if (current.operationId && stored?.operation.operationId === current.operationId && stored.leaseToken === current.leaseToken && ['queued', 'running'].includes(stored.operation.state)) {
    if (stored.operation.state !== 'queued' || !sameTuple(stored.operation.versions, sessionTuple(current)) || stored.operation.deadlineAt === null || stored.operation.deadlineAt <= now) return null;
    stored.operation = { ...stored.operation, state: 'running', stage: 'authenticating', attempt: stored.operation.attempt + 1, startedAt: now, completedAt: null };
   } else {
    // Terminal history remains queryable, but cannot own another browser attempt.
    if (!authority) return current.operationId ? null : current;
    if (!stored && !(await tx.get('v3:client'))) return current;
    const operation: Operation = { operationId: crypto.randomUUID(), command: current.storageState ? 'retry_session' : 'ensure_session', versions: sessionTuple(current), state: 'running', stage: 'authenticating', attempt: 1, createdAt: now, startedAt: now, deadlineAt: now + BROWSER_INVOCATION_BUDGET_MS, completedAt: null, retryAt: null, resultCode: null, cancelReason: null };
    stored = { operation, leaseToken: crypto.randomUUID(), grantId: authority.grantId, fingerprint: `automatic:${operation.operationId}`, expiresAt: now + 24 * 60 * 60_000 };
    current.operationId = operation.operationId;
    current.leaseToken = stored.leaseToken;
   }
   delete current.pendingKeepaliveMint;
   await tx.delete('pendingKeepaliveState');
   current.deviceRevision = (current.deviceRevision ?? 0) + 1;
   await tx.put({ [ACTIVE]: stored, [`v3:operation:${stored.operation.operationId}`]: stored, [SESSION]: current });
   await tx.setAlarm(stored.operation.deadlineAt! + BROWSER_CLEANUP_MARGIN_MS);
   return current;
  });
 }
 async finish(session: StoredDeviceSession): Promise<void> {
  await this.storage.transaction(tx => settleV3Operation(tx, session));
 }
 async export(a: DeviceAuthority, expected: VersionTuple): Promise<ExportEnvelope> {
  const live = await this.authority(a); this.assertAllowed(live);
  const binding = await this.binding(live); this.assertBinding(binding);
  if (binding.bindingEpoch !== expected.bindingEpoch || binding.credentialRevision !== expected.credentialRevision || live.generation !== expected.generation) throw new V3Error('STALE_SNAPSHOT');
  const after = await this.authority(live); this.assertAllowed(after);
  const latestBinding = await this.binding(live);
  if (after.generation !== live.generation || latestBinding.bindingRevision !== binding.bindingRevision || latestBinding.state !== 'bound') throw new V3Error('STALE_SNAPSHOT');
  let envelope!: ExportEnvelope;
  await this.storage.transaction(async tx => {
   const session = await tx.get<StoredDeviceSession>(SESSION);
   if (!session || !sameTuple(expected, sessionTuple(session))) throw new V3Error('SESSION_CHANGED');
   if (!session.storageState || !['ready','refreshing','temporary_unavailable','needs_reauth'].includes(session.state) || session.lastKeepAliveAt === null || session.lastKeepAliveAt + 2 * 60 * 60_000 <= Date.now()) throw new V3Error('SESSION_CHANGED');
   const now = Date.now(), exportId = crypto.randomUUID();
   envelope = { ...expected, protocolVersion: 3, exportId, createdAt: now, applyBefore: now + 30_000, cookies: extractSsoCookies(session.storageState, now) };
   await tx.put(`v3:export:${exportId}`, { tuple: expected, grantId: a.grantId, createdAt: now, applyBefore: envelope.applyBefore, expiresAt: now + 24 * 60 * 60_000 } satisfies IssuedExport);
  });
  return envelope;
 }
 async receipt(a: DeviceAuthority, raw: unknown): Promise<{ accepted: boolean; receivedAt: number; reasonCode: ReasonCode | null; acceptedTuple: VersionTuple | null; exportId: string | null; reportEpoch: string; clientReportSeq: number }> {
  const input = parseReceiptRequest(raw), live = await this.authority(a);
  const binding = await this.binding(live);
  const ack = { accepted: false, receivedAt: Date.now(), reasonCode: 'STALE_SNAPSHOT' as ReasonCode | null, acceptedTuple: null as VersionTuple | null, exportId: input.receipt.exportId, reportEpoch: input.reportEpoch, clientReportSeq: input.clientReportSeq };
  if (!live.allowed || binding.state !== 'bound' || input.receipt.bindingEpoch !== binding.bindingEpoch || input.receipt.credentialRevision !== binding.credentialRevision || input.receipt.generation !== live.generation) return ack;
  await this.storage.transaction(async tx => {
   const session = await tx.get<StoredDeviceSession>(SESSION);
   if (!session || !sameTuple(input.receipt, sessionTuple(session))) return;
   const epoch = await tx.get<ReportEpoch>(EPOCH);
   if (epoch && epoch.grantId === a.grantId && epoch.epoch !== input.reportEpoch) { ack.reasonCode = 'INVALID_REQUEST'; return; }
   const prior = await tx.get<ReportedLocal>(REPORT);
   if (prior && prior.reportEpoch === input.reportEpoch && prior.clientReportSeq >= input.clientReportSeq) {
    if (prior.clientReportSeq > input.clientReportSeq || JSON.stringify(prior.receipt) !== JSON.stringify(input.receipt)) return;
    if (prior.acknowledgedAt !== null) ack.receivedAt = prior.receivedAt;
   }
   if (input.receipt.result === 'applied') {
    const issued = await tx.get<IssuedExport>(`v3:export:${input.receipt.exportId}`);
    if (!issued || issued.grantId !== a.grantId || !sameTuple(issued.tuple, input.receipt) || issued.expiresAt <= Date.now() || input.receipt.verifiedAt === null || input.receipt.verifiedAt < issued.createdAt - 60_000 || input.receipt.verifiedAt > Date.now() + 60_000) { ack.reasonCode = 'INVALID_REQUEST'; return; }
    issued.expiresAt = Date.now() + 24 * 60 * 60_000; await tx.put(`v3:export:${input.receipt.exportId}`, issued);
   }
   const report: ReportedLocal = { reportEpoch: input.reportEpoch, clientReportSeq: input.clientReportSeq, cookieState: input.receipt.result, receipt: input.receipt, receivedAt: ack.receivedAt, acknowledgedAt: ack.receivedAt, verificationAge: input.receipt.verifiedAt === null ? null : Math.max(0, ack.receivedAt - input.receipt.verifiedAt), enabledIntent: prior?.enabledIntent ?? true, mode: input.receipt.result === 'manual' ? 'manual' : prior?.mode ?? 'automatic', schoolAccess: prior?.schoolAccess ?? 'unverified', client: (await tx.get<ClientMetadata>('v3:client')) ?? null };
   await tx.put({ [REPORT]: report, [EPOCH]: { epoch: input.reportEpoch, grantId: a.grantId } });
   session.deviceRevision = (session.deviceRevision ?? 0) + 1; await tx.put(SESSION, session);
   ack.accepted = true; ack.reasonCode = null; ack.acceptedTuple = sessionTuple(session);
  });
  return ack;
 }
 async report(a: DeviceAuthority, raw: unknown): Promise<void> {
  const input = parseReconcileRequest(raw); await this.authority(a);
  await this.storage.transaction(async tx => {
   const epoch = await tx.get<ReportEpoch>(EPOCH);
   if (epoch && epoch.grantId === a.grantId && epoch.epoch !== input.reportEpoch) throw new V3Error('INVALID_REQUEST');
   const prior = await tx.get<ReportedLocal>(REPORT);
   if (prior?.reportEpoch === input.reportEpoch && prior.clientReportSeq > input.clientReportSeq) return;
   if (prior?.reportEpoch === input.reportEpoch && prior.clientReportSeq === input.clientReportSeq) {
    if (JSON.stringify(prior.receipt) !== JSON.stringify(input.local.receipt)) return;
    await tx.put({ 'v3:client': input.client, [REPORT]: { ...prior, enabledIntent: input.local.enabledIntent, mode: input.local.mode, schoolAccess: input.local.schoolAccess ?? 'unverified', client: input.client } });
    return;
   }
   const acknowledged = prior?.receipt && JSON.stringify(prior.receipt) === JSON.stringify(input.local.receipt) ? prior.acknowledgedAt : null;
   const now = Date.now();
   await tx.put({ 'v3:client': input.client, [EPOCH]: { epoch: input.reportEpoch, grantId: a.grantId }, [REPORT]: { ...input.local, schoolAccess: input.local.schoolAccess ?? 'unverified', reportEpoch: input.reportEpoch, clientReportSeq: input.clientReportSeq, receivedAt: now, verificationAge: input.local.receipt?.verifiedAt == null ? null : Math.max(0, now - input.local.receipt.verifiedAt), acknowledgedAt: acknowledged, client: input.client } satisfies ReportedLocal });
   const session = await tx.get<StoredDeviceSession>(SESSION); if (session) { session.deviceRevision = (session.deviceRevision ?? 0) + 1; await tx.put(SESSION, session); }
  });
 }
}
