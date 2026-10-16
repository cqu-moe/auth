import base from './e2e.config';
import { authSecuritySecrets } from './e2e/secret-holder';

export default {
  ...base,
  tests: ['e2e/oauth/journey.oauth.e2e.ts'],
  timeout: 600000,
  assertionTimeout: 15000,
  credentials: {
    ...base.credentials,
    oauthRecovered: { username: 'oauth-lifecycle@example.test', password: async () => {
      if (!authSecuritySecrets.recoveryPassword) throw new Error('OAuth recovery password missing');
      return authSecuritySecrets.recoveryPassword;
    } },
    oauthCore: { username: 'oauth-core@example.test', password: 'Synthetic-only-123!' },
    oauthLifecycle: { username: 'oauth-lifecycle@example.test', password: 'Synthetic-only-123!' },
    oauthLifecycleNew: { username: 'oauth-lifecycle@example.test', password: 'Synthetic-change-only-456!' },
  },
};
