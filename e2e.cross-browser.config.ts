import { defineEngine, type EngineCleanupContext } from 'e2e/engine';
import base, { authWebEngine } from './e2e.config';

const cleanupControl = process.env.AUTH_E2E_CLEANUP_CONTROL === '1';
const { capabilities: _capabilities, ...original } = authWebEngine;
const engine = cleanupControl ? defineEngine({
  ...original,
  async endAttempt(context: EngineCleanupContext) {
    await original.endAttempt?.(context);
    throw new Error('AUTH cross-browser deliberate engine cleanup failure');
  },
}) : authWebEngine;

export default {
  ...base,
  tests: cleanupControl ? ['e2e/oauth/cleanup-control.fixture.ts']
    : ['e2e/identity.e2e.ts', 'e2e/auth-security.e2e.ts'],
  targets: [{ ...base.targets[0], engine }],
};
