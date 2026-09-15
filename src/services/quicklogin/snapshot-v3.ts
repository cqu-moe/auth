import type { Env } from '../../types';
import { QuickloginAccountClient } from './account-client';
import { QuickloginDeviceClient } from './device-client';
import { QuickloginLoginBrokerClient } from './login-broker-client';
import type { BindingSnapshot } from './binding-snapshot';
import { derivePresentation, type DeviceSnapshot, type BindingFacts, type ReasonCode } from './protocol-v3';
import { quickloginDeviceModeEnabled } from './mode';
export const unknownBinding: BindingFacts = { state: 'unknown', credentialsState: 'unknown', evidenceAt: null, evidenceKind: 'none', evidenceCredentialRevision: null, bindingTransitionId: null };
export async function snapshotV3(env: Env, userId: string, deviceId: string): Promise<DeviceSnapshot> {
 const accounts = new QuickloginAccountClient(env), devices = new QuickloginDeviceClient(env), broker = new QuickloginLoginBrokerClient(env);
 let snapshot!: DeviceSnapshot;
 for (let attempt = 0; attempt < 2; attempt++) {
  const authority = await accounts.getDeviceAuthority(userId, deviceId);
  const list = await accounts.listDevices(userId, Date.now());
  let binding: BindingSnapshot | null = null;
  try { binding = await broker.getBindingSnapshot(userId); } catch { /* Unknown authority is an explicit snapshot fact. */ }
  const data = await devices.readV3(authority);
  const live = await accounts.getDeviceAuthority(userId, deviceId);
  const afterList = await accounts.listDevices(userId, Date.now());
  let afterBinding: BindingSnapshot | null = null;
  try { afterBinding = await broker.getBindingSnapshot(userId); } catch { /* Do not reinterpret unavailable as unbound. */ }
  const stable = list.revision === afterList.revision && live.generation === authority.generation && live.allowed === authority.allowed && live.grantId === authority.grantId && binding !== null && afterBinding !== null && binding.bindingRevision === afterBinding.bindingRevision && binding.bindingEpoch === afterBinding.bindingEpoch && binding.bindingTransitionId === afterBinding.bindingTransitionId && binding.credentialRevision === afterBinding.credentialRevision;
  if (!stable && attempt === 0) continue;
  const now = Date.now(), session = data.session, device = afterList.devices.find(d => d.deviceId === deviceId);
  const aligned = stable && session.generation === live.generation && session.bindingEpoch === binding!.bindingEpoch && (session.credentialRevision ?? session.bindingEpoch) === binding!.credentialRevision;
  const usableUntil = session.storageState && session.lastKeepAliveAt !== null ? session.lastKeepAliveAt + 2 * 60 * 60_000 : null;
  const usable = aligned && usableUntil !== null && usableUntil > now;
  const policy = !quickloginDeviceModeEnabled(env) ? 'service_paused' : !live.masterEnabled ? 'master_off' : device?.disabledReason === 'quota_reduced' || live.reason === 'NO_DEVICE_CAPACITY' ? 'quota_blocked' : !live.enabled ? 'device_off' : 'enabled';
  const state = session.state === 'ready' ? 'ready' : session.state === 'preparing' ? data.operation?.state === 'running' ? 'logging_in' : 'queued' : session.state === 'needs_reauth' ? usable ? 'ready' : 'blocked' : session.state === 'temporary_unavailable' ? 'retry_wait' : session.state === 'disabled' ? 'paused' : session.state;
  const reason = !aligned ? binding === null || afterBinding === null ? 'INTERNAL_STATE_UNAVAILABLE' : 'RECONCILING' : session.reasonCode ?? (session.state === 'needs_reauth' ? 'BLOCKED_UNKNOWN' : null);
  const canAttempt = aligned && live.allowed && binding?.state === 'bound' && binding.credentialsState !== 'rejected' && binding.credentialsState !== 'interaction_required' && session.reasonCode !== 'INTERACTION_REQUIRED';
  snapshot = {
   snapshotId: crypto.randomUUID(), serverTime: now, observedAt: now, freshUntil: now + 5 * 60_000,
   identity: { deviceId, installationId: data.client?.installationId ?? null, deviceName: device?.deviceName ?? null },
   presence: { lastSeenAt: live.lastSeenAt, lastIp: device?.lastIp ?? null },
   versions: { generation: live.generation, bindingEpoch: binding?.bindingEpoch ?? null, credentialRevision: binding?.credentialRevision ?? null, sessionVersion: session.sessionVersion, accountRevision: afterList.revision, deviceRevision: session.deviceRevision ?? 0, bindingRevision: binding?.bindingRevision ?? null },
   authorization: { state: live.reason === 'DEVICE_REVOKED' ? 'revoked' : live.reason === 'FORBIDDEN' ? 'reconnect_required' : 'authorized', policy, masterEnabled: live.masterEnabled, deviceEnabled: live.enabled, disabledReason: device?.disabledReason ?? null, deviceLimit: afterList.deviceLimit, used: afterList.used },
   binding: binding ?? unknownBinding,
   cloud: { state: aligned ? state : 'queued', operationId: data.operation?.operationId ?? null, stage: data.operation?.stage ?? null, loginAt: session.loginAt, lastValidatedAt: session.lastKeepAliveAt, usableUntil: usable ? usableUntil : null, retryAt: session.nextAttemptAt, reasonCode: reason as ReasonCode | null, deadlineAt: data.operation?.deadlineAt ?? null },
   reportedLocal: data.report, observation: stable ? 'fresh' : 'checking',
   presentation: { statusCode: 'unknown', title: '状态暂时无法确认', detail: null, reasonCode: null, actionCode: 'reconcile', actionTarget: null, nextCheckAt: now + 5000, freshUntil: now + 5 * 60_000 },
   capabilities: { canEnsure: canAttempt, canRetry: canAttempt && (session.nextAttemptAt === null || session.nextAttemptAt <= now), canExport: usable && live.allowed && binding?.state === 'bound', canEnable: !live.enabled && live.masterEnabled && afterList.used < afterList.deviceLimit && live.reason !== 'DEVICE_REVOKED', canUseExistingSession: usable && live.allowed },
  };
  snapshot.presentation = derivePresentation(snapshot, {}, now);
  return snapshot;
 }
 return snapshot;
}
