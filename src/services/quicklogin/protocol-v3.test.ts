import { describe, expect, it } from 'vitest';
import { derivePresentation, parseApiProblem, parseApiResponse, parseBindingFacts, parseCapabilities, parseDeviceSnapshot, parseExportEnvelope, parseOperation, parseOperationRequest, parseReceipt, parseReceiptAck, parseReconcileRequest, type DeviceSnapshot, type LocalPresentation, type Receipt, type StatusCode } from './protocol-v3';
const now = 1_800_000_000_000;
const tuple = { deviceId: 'device-test', generation: 2, bindingEpoch: 3, credentialRevision: 4, sessionVersion: 5 };
const client = { extensionVersion: '0.2.0', buildId: 'build-test', browserVersion: '152.0.0.0', installationId: 'installation-test' };
const receipt: Receipt = { ...tuple, exportId: 'export-test', result: 'applied', verifiedAt: now - 100 };
function snapshot(): DeviceSnapshot {
  return {
    snapshotId: 'snapshot-test', serverTime: now, observedAt: now, freshUntil: now + 300_000,
    identity: { deviceId: tuple.deviceId, installationId: client.installationId, deviceName: 'Test browser' },
    presence: { lastSeenAt: now, lastIp: null },
    versions: { generation: 2, bindingEpoch: 3, credentialRevision: 4, sessionVersion: 5, accountRevision: 6, deviceRevision: 7, bindingRevision: 8 },
    authorization: { state: 'authorized', policy: 'enabled', disabledReason: null, masterEnabled: true, deviceEnabled: true, deviceLimit: 2, used: 1 },
    binding: { state: 'bound', credentialsState: 'verified', evidenceAt: now - 1000, evidenceKind: 'first_factor_success', evidenceCredentialRevision: 4, bindingTransitionId: null },
    cloud: { state: 'ready', operationId: null, stage: null, loginAt: now - 1000, lastValidatedAt: now - 1000, usableUntil: now + 3_600_000, retryAt: null, reasonCode: null, deadlineAt: null },
    reportedLocal: { reportEpoch: 'report-test', clientReportSeq: 1, cookieState: 'applied', receipt, receivedAt: now, verificationAge: 100, acknowledgedAt: now, enabledIntent: true, mode: 'automatic', schoolAccess: 'unverified', client },
    observation: 'fresh',
    presentation: { statusCode: 'ready', title: '已就绪', detail: null, reasonCode: null, actionCode: 'disable', actionTarget: null, nextCheckAt: now + 300_000, freshUntil: now + 300_000 },
    capabilities: { canEnsure: true, canRetry: true, canExport: true, canEnable: false, canUseExistingSession: true },
  };
}
describe('QuickLogin v3 runtime boundary', () => {
  const request = () => ({ protocolVersion: 3, requestId: 'request-test', client, observed: null, reportEpoch: 'report-test', clientReportSeq: 1, local: { enabledIntent: true, mode: 'automatic', cookieState: 'unknown', receipt: null } });
  it('accepts first reconciliation without fabricated observed versions and optional additions', () => {
    expect(parseReconcileRequest({ ...request(), futureField: 'ignored' }).observed).toBeNull();
    expect(parseReconcileRequest({ ...request(), observed: { generation: 2, bindingEpoch: null, credentialRevision: null, sessionVersion: 5, deviceRevision: 7 } }).observed?.bindingEpoch).toBeNull();
  });
  it.each([2, 4, '3', null])('rejects unsupported protocol %s', (protocolVersion) => {
    expect(() => parseReconcileRequest({ ...request(), protocolVersion })).toThrow('PROTOCOL_UNSUPPORTED');
  });
  it('rejects malformed identities, versions, state, and oversize payloads', () => {
    for (const bad of [ { requestId: '' }, { clientReportSeq: -1 }, { clientReportSeq: 1.5 }, { clientReportSeq: Number.MAX_SAFE_INTEGER + 1 }, { client: { ...client, installationId: '../device' } }, { client: { ...client, extensionVersion: 'latest' } }, { local: { ...request().local, cookieState: 'ready' } }, { extra: 'x'.repeat(65536) } ]) expect(() => parseReconcileRequest({ ...request(), ...bad })).toThrow();
  });
  it('validates receipt result and full device/version tuple', () => {
    expect(parseReceipt(receipt)).toEqual(receipt);
    for (const bad of [{ deviceId: '' }, { generation: -1 }, { bindingEpoch: null }, { credentialRevision: undefined }, { sessionVersion: Infinity }, { verifiedAt: null }, { exportId: null }]) expect(() => parseReceipt({ ...receipt, ...bad })).toThrow();
  });
  it('accepts unavailable binding versions as null without granting export', () => {
    const s = snapshot(); s.binding.state = 'unknown'; s.binding.credentialsState = 'unknown'; s.binding.evidenceKind = 'none'; s.binding.evidenceAt = null; s.binding.evidenceCredentialRevision = null; s.versions.bindingEpoch = null; s.versions.credentialRevision = null; s.versions.bindingRevision = null; s.capabilities.canExport = false; s.capabilities.canUseExistingSession = false; s.presentation.statusCode = 'unknown';
    expect(parseDeviceSnapshot(s).binding.state).toBe('unknown');
  });
  it('accepts valid snapshots and rejects false-ready combinations at the wire boundary', () => {
    expect(parseDeviceSnapshot(snapshot()).identity.deviceId).toBe('device-test');
    for (const mutate of [ (s: DeviceSnapshot) => { s.reportedLocal = null; }, (s: DeviceSnapshot) => { s.reportedLocal!.acknowledgedAt = null; }, (s: DeviceSnapshot) => { s.reportedLocal!.receipt = { ...receipt, generation: 1 }; }, (s: DeviceSnapshot) => { s.binding.state = 'unbound'; }, (s: DeviceSnapshot) => { s.observation = 'stale'; }, (s: DeviceSnapshot) => { s.authorization.state = 'revoked'; }, (s: DeviceSnapshot) => { s.cloud.usableUntil = now - 1; } ]) { const s = snapshot(); mutate(s); expect(() => parseDeviceSnapshot(s)).toThrow(); }
  });
  it('rejects credential claims without trustworthy, versioned evidence', () => {
    const facts = snapshot().binding;
    expect(() => parseBindingFacts({ ...facts, credentialsState: 'rejected', evidenceKind: 'none' })).toThrow();
    expect(() => parseBindingFacts({ ...facts, credentialsState: 'verified', evidenceKind: 'session_reuse' })).toThrow();
    expect(() => parseBindingFacts({ ...facts, evidenceAt: null })).toThrow();
  });
  it('validates common success/problem envelopes and public capabilities', () => {
    const capabilities = { protocolVersion: 3, supportedProtocolVersions: [2, 3], minExtensionVersion: '0.2.0', serverBuild: 'server-test', features: { reconcile: true, operations: true, receipts: true, overview: true } };
    expect(parseApiResponse({ data: capabilities, meta: { protocolVersion: 3, requestId: 'request-test', serverTime: now, serverBuild: 'server-test' } }, parseCapabilities).data).toEqual(capabilities);
    expect(() => parseApiResponse({ data: capabilities, meta: { protocolVersion: 2 } }, parseCapabilities)).toThrow();
    expect(parseApiProblem({ type: 'about:blank', title: 'Unavailable', status: 503, detail: 'Try later', code: 'SCHOOL_UNREACHABLE', requestId: 'request-test', retryAt: now + 30000, action: 'reconcile' }).status).toBe(503);
    expect(() => parseApiProblem({ code: 'made_up' })).toThrow();
  });
  it('requires set-enabled commands to carry a boolean and full expected tuple', () => {
    const op = { protocolVersion: 3, requestId: 'request-test', command: 'set_enabled', idempotencyKey: 'key-test', expected: tuple, enabled: true };
    expect(parseOperationRequest(op).enabled).toBe(true);
    expect(() => parseOperationRequest({ ...op, enabled: undefined })).toThrow();
    expect(() => parseOperationRequest({ ...op, expected: { ...tuple, bindingEpoch: null } })).toThrow();
  });
  it('validates operation state and chronological deadlines', () => {
    const operation = { operationId: 'operation-test', command: 'ensure_session', versions: tuple, state: 'running', stage: 'authenticating', attempt: 1, createdAt: now - 100, startedAt: now, deadlineAt: now + 30000, completedAt: null, retryAt: null, resultCode: null, cancelReason: null };
    expect(parseOperation(operation).state).toBe('running');
    expect(() => parseOperation({ ...operation, state: 'ready' })).toThrow();
    expect(() => parseOperation({ ...operation, deadlineAt: now - 1 })).toThrow();
  });
  it('rejects forged positive ACKs without an accepted tuple', () => {
    expect(() => parseReceiptAck({ accepted: true, exportId: 'export-test', acceptedTuple: null, reportEpoch: 'report-test', clientReportSeq: 1, receivedAt: now, reasonCode: null, snapshot: snapshot() })).toThrow();
  });
  it('bounds the complete export envelope and response to 256 KiB', () => {
    const limit = 256 * 1024;
    const cookie = { name: 'SOURCEID_TGC', value: 'x', domain: 'sso.cqu.edu.cn', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires: -1 };
    const envelope = { ...tuple, protocolVersion: 3, exportId: 'export-test', createdAt: now, applyBefore: now + 30000, cookies: [cookie] };
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
    cookie.value += 'x'.repeat(limit - bytes(envelope));
    expect(bytes(envelope)).toBe(limit);
    expect(bytes(envelope.cookies)).toBeLessThan(limit);
    expect(parseExportEnvelope(envelope).cookies).toHaveLength(1);
    cookie.value += 'x';
    expect(() => parseExportEnvelope(envelope)).toThrow();
    const response = { data: envelope, meta: { protocolVersion: 3, requestId: 'request-test', serverTime: now, serverBuild: 'server-test' } };
    cookie.value = cookie.value.slice(0, -(bytes(response) - limit));
    expect(bytes(response)).toBe(limit);
    expect(parseApiResponse(response, parseExportEnvelope).data.cookies).toHaveLength(1);
    expect(() => parseApiResponse({ ...response, futureOptional: 'x' }, parseExportEnvelope)).toThrow();
  });
  it('validates export lifetime, cookies, duplicate keys and protocol at the boundary', () => {
    const cookie = { name: 'SOURCEID_TGC', value: 'synthetic-test', domain: 'sso.cqu.edu.cn', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires: -1 };
    const envelope = { ...tuple, protocolVersion: 3, exportId: 'export-test', createdAt: now, applyBefore: now + 30000, cookies: [cookie] };
    expect(parseExportEnvelope(envelope).cookies).toHaveLength(1);
    for (const bad of [ { protocolVersion: 2 }, { applyBefore: now - 1 }, { applyBefore: now + 30001 }, { cookies: [cookie, cookie] }, { cookies: [{ ...cookie, domain: '.cqu.edu.cn' }] }, { cookies: [{ ...cookie, partitionKey: {} }] }, { cookies: [{ ...cookie, value: 'x'.repeat(256 * 1024) }] }, { cookies: [] } ]) expect(() => parseExportEnvelope({ ...envelope, ...bad })).toThrow();
  });
});
describe('shared presentation priority and evidence', () => {
  const cases: [StatusCode, (s: DeviceSnapshot) => void, LocalPresentation?][] = [
    ['ready', () => {}], ['disabled', () => {}, { enabledIntent: false }], ['disconnecting', () => {}, { disconnecting: true }],
    ['revoked', s => { s.authorization.state = 'revoked'; }, { observation: 'unreachable' }],
    ['disconnected', s => { s.authorization.state = 'disconnected'; }], ['reconnect_required', s => { s.authorization.state = 'reconnect_required'; }],
    ['update_required', () => {}, { protocolSupport: 'client_update_required' }], ['service_upgrading', () => {}, { protocolSupport: 'service_upgrading' }],
    ['master_off', s => { s.authorization.masterEnabled = false; s.authorization.policy = 'master_off'; }],
    ['device_off', s => { s.authorization.deviceEnabled = false; s.authorization.policy = 'device_off'; }],
    ['quota_blocked', s => { s.authorization.policy = 'quota_blocked'; }],
    ['manual', () => {}, { mode: 'manual' }], ['foreign', () => {}, { cookieState: 'foreign' }],
    ['unreachable', s => { s.binding.state = 'unbound'; }, { observation: 'unreachable' }], ['checking', s => { s.freshUntil = now - 1; }],
    ['unbound', s => { s.binding.state = 'unbound'; }], ['unknown', s => { s.binding.state = 'unknown'; }], ['binding_updating', s => { s.binding.state = 'updating'; }],
    ['credentials_rejected', s => { s.cloud.usableUntil = null; s.binding.credentialsState = 'rejected'; s.binding.evidenceKind = 'password_rejected'; }],
    ['usable_credentials_rejected', s => { s.binding.credentialsState = 'rejected'; s.binding.evidenceKind = 'password_rejected'; }],
    ['ready', s => { s.binding.credentialsState = 'rejected'; s.binding.evidenceKind = 'password_rejected'; s.binding.evidenceCredentialRevision = 3; }],
    ['interaction_required', s => { s.cloud.usableUntil = null; s.binding.credentialsState = 'interaction_required'; }],
    ['preparing', s => { s.cloud.state = 'logging_in'; s.cloud.usableUntil = null; }], ['refreshing', s => { s.cloud.state = 'refreshing'; s.cloud.usableUntil = null; }],
    ['retry_wait', s => { s.cloud.state = 'retry_wait'; s.cloud.usableUntil = null; s.cloud.retryAt = now + 60000; }],
    ['usable_retry_wait', s => { s.cloud.state = 'retry_wait'; s.cloud.retryAt = now + 60000; }],
    ['syncing', () => {}, { cookieState: 'missing' }], ['permission_denied', () => {}, { cookieState: 'permission_denied' }], ['write_failed', () => {}, { cookieState: 'write_failed' }],
    ['pending_ack', () => {}, { pendingAck: true }], ['pending_ack', s => { s.reportedLocal!.acknowledgedAt = null; }],
    ['syncing', () => {}, { receipt: { ...receipt, generation: 1 } }],
    ['unknown', () => {}, { schoolAccess: 'login_form_seen' }],
  ];
  it.each(cases)('%s', (expected, mutate, local) => {
    const s = snapshot(); mutate(s);
    const view = derivePresentation(s, local, now);
    expect(view.statusCode).toBe(expected);
    expect(view.detail).toBeTruthy();
  });
  it('shows active authorization before an old disabled or reconnect state', () => {
    const s = snapshot();s.authorization.state='reconnect_required';
    expect(derivePresentation(s,{authorization:'authorizing',enabledIntent:false},now).statusCode).toBe('authorizing');
  });
  it('does not mistake an unconfirmed enable for a confirmed remote off state', () => {
    const s = snapshot();s.authorization.policy='device_off';s.authorization.deviceEnabled=false;
    expect(derivePresentation(s,{enabledIntent:true,observation:'unreachable'},now).statusCode).toBe('unreachable');
  });
  it('shows pending ACK for a fresh local receipt when no server report exists yet', () => {
    const s = snapshot(); s.reportedLocal = null;
    expect(derivePresentation(s, { cookieState: 'applied', receipt, pendingAck: true }, now).statusCode).toBe('pending_ack');
  });
  it('does not keep displaying preparation past the advertised job deadline', () => {
    const s = snapshot(); s.cloud.state = 'logging_in'; s.cloud.usableUntil = null; s.cloud.deadlineAt = now - 1;
    expect(derivePresentation(s, {}, now).statusCode).toBe('unknown');
    expect(derivePresentation(s, {}, now).reasonCode).toBe('OPERATION_TIMEOUT');
  });
  it.each(['checking', 'stale', 'unreachable'] as const)('local fresh cannot promote server %s observation', observation => {
    const s = snapshot(); s.observation = observation; s.presentation.statusCode = observation === 'unreachable' ? 'unreachable' : 'checking';
    const parsed = parseDeviceSnapshot(s);
    expect(derivePresentation(parsed, { observation: 'fresh' }, now).statusCode).toBe(observation === 'unreachable' ? 'unreachable' : 'checking');
  });
  it.each(['disconnected', 'reconnect_required', 'authorizing', 'refreshing_token', 'revoked'] as const)('local authorized cannot promote server %s authority', authorization => {
    const s = snapshot(); s.authorization.state = authorization; s.presentation.statusCode = 'unknown'; s.capabilities.canExport = false;
    expect(derivePresentation(parseDeviceSnapshot(s), { authorization: 'authorized' }, now).statusCode).not.toBe('ready');
  });
  it('uses reported local disable for the website while respecting newer explicit local intent', () => {
    const s = snapshot(); s.reportedLocal!.enabledIntent = false;
    expect(derivePresentation(s, {}, now).statusCode).toBe('disabled');
    expect(derivePresentation(s, { enabledIntent: true }, now).statusCode).toBe('ready');
    expect(s.authorization.policy).toBe('enabled');
  });
  it('does not revive stale readback evidence by reading a fresh snapshot', () => {
    const s = snapshot(); s.reportedLocal!.verificationAge = 10 * 60_000;
    expect(derivePresentation(s, {}, now).statusCode).toBe('checking');
    s.reportedLocal!.verificationAge = 1; s.reportedLocal!.receivedAt = now - 10 * 60_000;
    expect(derivePresentation(s, {}, now).statusCode).toBe('checking');
    expect(derivePresentation(s, { receipt, cookieState: 'applied' }, now).statusCode).toBe('pending_ack');
  });
  it('rejects stale local readback even when the last server ACK remains fresh', () => {
    const s = snapshot();
    expect(derivePresentation(s, { receipt: { ...receipt, verifiedAt: now - 10 * 60_000 } }, now).statusCode).toBe('checking');
    s.reportedLocal!.verificationAge = null;
    expect(derivePresentation(s, {}, now).statusCode).toBe('checking');
  });
  it.each(['revoked', 'reconnect_required', 'disconnected'] as const)('shows auth recovery instead of residual disable for %s', state => {
    const s = snapshot(); s.authorization.state = state; s.reportedLocal!.enabledIntent = false;
    const serverView = derivePresentation(s, {}, now);
    expect(serverView.statusCode).toBe(state);
    expect(serverView.actionCode).toBe('connect_auth');
    const localView = derivePresentation(null, { authorization: state, enabledIntent: false }, now);
    expect(localView.statusCode).toBe(state);
    expect(localView.actionCode).toBe('connect_auth');
  });
  it('offers verification for a blocked device CAPTCHA without changing binding evidence', () => {
    const s = snapshot();
    s.cloud.state = 'blocked'; s.cloud.reasonCode = 'INTERACTION_REQUIRED'; s.cloud.usableUntil = null;
    s.capabilities.canEnsure = false; s.capabilities.canRetry = false; s.capabilities.canExport = false; s.capabilities.canUseExistingSession = false;
    const bindingBefore = structuredClone(s.binding);
    expect(derivePresentation(s, {}, now)).toMatchObject({ statusCode: 'interaction_required', actionCode: 'complete_verification', reasonCode: 'INTERACTION_REQUIRED' });
    expect(s.binding).toEqual(bindingBefore);
    expect(s.binding.credentialsState).toBe('verified');
  });
  it('keeps a verified current session usable while directing device CAPTCHA renewal to verification', () => {
    const s = snapshot();
    s.cloud.reasonCode = 'INTERACTION_REQUIRED'; s.capabilities.canEnsure = false; s.capabilities.canRetry = false;
    const bindingBefore = structuredClone(s.binding);
    expect(derivePresentation(s, {}, now)).toMatchObject({ statusCode: 'usable_credentials_rejected', actionCode: 'complete_verification', reasonCode: 'INTERACTION_REQUIRED' });
    expect(s.binding).toEqual(bindingBefore);
    expect(s.binding.credentialsState).toBe('verified');
  });
  it.each([
    ['OTP_TIMEOUT', '验证码未收到'],
    ['OTP_SEND_FAILED', '学校未发出验证码'],
    ['OPERATION_TIMEOUT', '学校登录超时'],
    ['CONTAINER_UNAVAILABLE', '登录服务暂不可用'],
    ['VERIFICATION_COOLDOWN', '等待验证恢复'],
    ['WAF_CHALLENGE', '学校暂时拦截登录'],
    ['SCHOOL_UNREACHABLE', '学校登录暂时不可用'],
  ] as const)('names retry reason %s while preserving the retry guard', (reasonCode, title) => {
    const s = snapshot(); s.cloud.state = 'retry_wait'; s.cloud.usableUntil = null;
    s.cloud.reasonCode = reasonCode; s.cloud.retryAt = now + 60000;
    expect(derivePresentation(s, {}, now)).toMatchObject({ statusCode: 'retry_wait', title, reasonCode, actionCode: 'none' });
    expect(derivePresentation(s, {}, now + 60000)).toMatchObject({ statusCode: 'retry_wait', title, reasonCode, actionCode: 'retry_session' });
    expect(s.binding.credentialsState).toBe('verified');
  });
  it('never converts missing data to bound or ready', () => { expect(derivePresentation(null, {}, now).statusCode).toBe('unknown'); });
  it('uses no arbitrary action URL from a server string', () => { const s = snapshot(); s.binding.state = 'unbound'; expect(derivePresentation(s, {}, now).actionTarget).toBe('/settings?cqu=bind'); });
});
