import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { base32 } from '@better-auth/utils/base32';
import { createOTP } from '@better-auth/utils/otp';
import { authSecuritySecrets } from './e2e/secret-holder';

async function deliveredOtp(email: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const response = await fetch(`${process.env.AUTH_E2E_CONTROL}/mail?email=${encodeURIComponent(email)}`);
    const { otp } = await response.json();
    if (otp) return otp as string;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Application verification email was not delivered to ${email}`);
}

const syntheticEmails = { profileNew: 'profile-new@example.test', passkeyNew: 'passkey-new@example.test', adminStrong: 'adminstrong@example.test' } as const;
const accountEmail = (name: string) => syntheticEmails[name as keyof typeof syntheticEmails] ?? `${name}@example.test`;
const otpFor = (name: string) => async () => await deliveredOtp(accountEmail(name));
const wrongOtpFor = (name: string) => async () => {
  const delivered = await deliveredOtp(accountEmail(name));
  return delivered === '111111' ? '222222' : '111111';
};

async function currentTotp(uri = authSecuritySecrets.mfaRawSecret) {
  if (!uri) throw new Error('TOTP enrollment response has not been captured');
  const encoded = new URL(uri).searchParams.get('secret');
  if (!encoded) throw new Error('Captured TOTP URI has no secret');
  return await createOTP(new TextDecoder().decode(base32.decode(encoded))).totp();
}

async function wrongCurrentTotp() {
  const delivered = await currentTotp();
  for (let digit = 1; digit <= 9; digit++) {
    const candidate = delivered.slice(0, -1) + digit;
    if (candidate !== delivered) return candidate;
  }
  throw new Error('Could not derive a distinct synthetic TOTP');
}

const browserName = process.env.AUTH_E2E_BROWSER || 'chromium';
if (!['chromium', 'firefox', 'webkit'].includes(browserName)) throw new Error('Unsupported AUTH_E2E_BROWSER');

const webHolder = globalThis as typeof globalThis & { authE2eWebEngine?: ReturnType<typeof web> };
export const authWebEngine = webHolder.authE2eWebEngine ??= web({
  browser: browserName as 'chromium' | 'firefox' | 'webkit',
  viewport: process.env.AUTH_E2E_MOBILE ? { width: 390, height: 844 } : { width: 1440, height: 900 },
});

export default {
  tests: ['e2e/*.e2e.ts'], workers: 1, retries: 0,
  timeout: 90000, assertionTimeout: 10000,
  output: process.env.AUTH_E2E_OUTPUT || '.e2e',
  credentials: {
    ...Object.fromEntries(['manager', 'member', 'invitee', 'reviewer'].map(name => [name, { username: `${name}@example.test`, password: 'Synthetic-only-123!' }])),
    recovered: { username: 'member@example.test', password: async () => {
      if (!authSecuritySecrets.recoveryPassword) throw new Error('Recovery result not captured');
      return authSecuritySecrets.recoveryPassword;
    } },
    journey: { username: 'journey@example.test', password: 'Synthetic-only-123!' },
    profile: { username: 'profile@example.test', password: 'Synthetic-only-123!' },
    profileNew: { username: 'profile-new@example.test', password: 'Synthetic-only-123!' },
    reset: { username: 'reset@example.test', password: 'Synthetic-only-123!' },
    resetNew: { username: 'reset@example.test', password: 'Synthetic-reset-only-456!' },
    mfa: { username: 'mfa@example.test', password: 'Synthetic-only-123!' },
    passkey: { username: 'passkey@example.test', password: 'Synthetic-only-123!' },
    passkeyNew: { username: 'passkey-new@example.test', password: 'Synthetic-only-123!' },
    recent: { username: 'recent@example.test', password: 'Synthetic-only-123!' },
    adminStrong: { username: 'adminstrong@example.test', password: 'Synthetic-only-123!' },
    revoke: { username: 'revoke@example.test', password: 'Synthetic-only-123!' },
    revokeNew: { username: 'revoke@example.test', password: 'Synthetic-change-only-456!' },
  },
  secrets: {
    otp: otpFor('journey'), wrongOtp: wrongOtpFor('journey'),
    profileOtp: otpFor('profile'), wrongProfileOtp: wrongOtpFor('profile'),
    profileNewOtp: otpFor('profileNew'), wrongProfileNewOtp: wrongOtpFor('profileNew'),
    resetOtp: otpFor('reset'), mfaOtp: otpFor('mfa'), passkeyOtp: otpFor('passkey'), recentOtp: otpFor('recent'), adminStrongOtp: otpFor('adminStrong'), revokeOtp: otpFor('revoke'),
    ...Object.fromEntries(['manager', 'member', 'invitee', 'reviewer'].map(name => [`${name}Otp`, otpFor(name)])),
    adminTotp: async () => await currentTotp(authSecuritySecrets.adminRawSecret),
    managedInvitation: async () => {
      if (!authSecuritySecrets.managedInvitation) throw new Error('Managed invitation has not been created');
      return authSecuritySecrets.managedInvitation;
    },
    mfaTotp: () => currentTotp(), wrongMfaTotp: wrongCurrentTotp,
    mfaBackupCode: async () => {
      const code = authSecuritySecrets.mfaBackupCode;
      if (!code) throw new Error('Recovery codes have not been captured');
      return code;
    },
  },
  targets: [{ name: process.env.AUTH_E2E_MOBILE ? 'mobile' : 'desktop',
    engine: authWebEngine,
    app: { url: process.env.AUTH_E2E_URL || 'http://127.0.0.1:18797' } }],
} satisfies E2EConfig;
