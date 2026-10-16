import { defineEngine, type EngineCleanupContext } from 'e2e/engine';
import base from './e2e.config';

const { capabilities: _capabilities, ...original } = base.targets[0].engine;
const engine = defineEngine({
  ...original,
  async endAttempt(context: EngineCleanupContext) {
    await original.endAttempt?.(context);
    throw new Error('AUTH04 deliberate engine cleanup failure');
  },
});
export default {
  ...base,
  tests: ['e2e/oauth/cleanup-control.fixture.ts'],
  targets: [{ ...base.targets[0], engine }],
};
