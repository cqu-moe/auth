import type { BindingFacts } from './protocol-v3';
export interface BindingSnapshot extends BindingFacts {
  bindingEpoch: number;
  credentialRevision: number;
  bindingRevision: number;
}
export function validBindingSnapshot(value: unknown): value is BindingSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const b = value as BindingSnapshot;
  return ['unbound', 'updating', 'bound', 'unknown'].includes(b.state) &&
    ['unknown', 'verified', 'rejected', 'interaction_required'].includes(b.credentialsState) &&
    ['none', 'first_factor_success', 'password_rejected', 'session_reuse'].includes(b.evidenceKind) &&
    [b.bindingEpoch, b.credentialRevision, b.bindingRevision].every(n => Number.isSafeInteger(n) && n >= 0) &&
    (b.bindingTransitionId === null || typeof b.bindingTransitionId === 'string') &&
    (b.evidenceAt === null || Number.isSafeInteger(b.evidenceAt)) &&
    (b.evidenceCredentialRevision === null || Number.isSafeInteger(b.evidenceCredentialRevision));
}
