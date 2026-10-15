import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

async function deliveredOtp() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const response = await fetch(`${process.env.AUTH_E2E_CONTROL}/mail?email=journey@example.test`);
    const { otp } = await response.json();
    if (otp) return otp as string;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Application verification email was not delivered');
}
export default {
  tests: ['e2e/**/*.e2e.ts'], workers: 1, retries: 0,
  timeout: 90000, assertionTimeout: 10000,
  output: process.env.AUTH_E2E_OUTPUT || '.e2e',
  credentials: { journey: { username: 'journey@example.test', password: 'Synthetic-only-123!' } },
  secrets: { otp: deliveredOtp, wrongOtp: async () => (await deliveredOtp()) === '111111' ? '222222' : '111111' },
  targets: [{ name: process.env.AUTH_E2E_MOBILE ? 'mobile' : 'desktop',
    engine: web({ viewport: process.env.AUTH_E2E_MOBILE ? { width: 390, height: 844 } : { width: 1440, height: 900 } }),
    app: { url: process.env.AUTH_E2E_URL || 'http://127.0.0.1:18797' } }],
} satisfies E2EConfig;
