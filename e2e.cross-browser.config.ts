import { defineEngine, type EngineCleanupContext } from 'e2e/engine';
import base from './e2e.config';

const cleanupControl = process.env.AUTH_E2E_CLEANUP_CONTROL === '1';
const { capabilities: _capabilities, ...original } = base.targets[0].engine;
const engine = cleanupControl ? defineEngine({
  ...original,
  async endAttempt(context: EngineCleanupContext) {
    await original.endAttempt?.(context);
    throw new Error('AUTH cross-browser deliberate engine cleanup failure');
  },
}) : base.targets[0].engine;

export default {
  ...base,
  tests: cleanupControl ? ['e2e/oauth/cleanup-control.fixture.ts']
    : base.tests,
  targets: [{ ...base.targets[0], engine }],
};
