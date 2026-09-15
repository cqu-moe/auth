import type { DeviceSnapshot, Overview } from "./quicklogin-protocol.generated";
export function deviceSnapshot(now = Date.now()): DeviceSnapshot {
  return {
    snapshotId: "snapshot-a", serverTime: now, observedAt: now, freshUntil: now + 60_000,
    identity: { deviceId: "device-a", installationId: "installation-a", deviceName: "宿舍 Chrome" },
    presence: { lastSeenAt: now, lastIp: null },
    versions: { generation: 2, bindingEpoch: 1, credentialRevision: 1, sessionVersion: 2, accountRevision: 2, deviceRevision: 2, bindingRevision: 1 },
    authorization: { state: "authorized", policy: "enabled", disabledReason: null, masterEnabled: true, deviceEnabled: true, deviceLimit: 2, used: 1 },
    binding: { state: "bound", credentialsState: "verified", evidenceAt: now, evidenceKind: "first_factor_success", evidenceCredentialRevision: 1, bindingTransitionId: null },
    cloud: { state: "ready", operationId: null, stage: null, loginAt: now, lastValidatedAt: now, usableUntil: now + 3_600_000, retryAt: null, reasonCode: null, deadlineAt: null },
    reportedLocal: null, observation: "fresh",
    presentation: { statusCode: "syncing", title: "正在同步到浏览器", detail: null, reasonCode: null, actionCode: "none", actionTarget: null, nextCheckAt: now + 30_000, freshUntil: now + 60_000 },
    capabilities: { canEnsure: true, canRetry: false, canExport: true, canEnable: true, canUseExistingSession: true },
  };
}
export function overview(devices = [deviceSnapshot()]): Overview {
  return { binding: deviceSnapshot().binding, accountRevision: 2, masterEnabled: true, deviceLimit: 2, used: devices.length, devices };
}
