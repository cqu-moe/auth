type AuthSecuritySecrets = {
  mfaRawSecret?: string;
  mfaBackupCode?: string;
};

const holder = globalThis as typeof globalThis & { authE2eSecuritySecrets?: AuthSecuritySecrets };

/** Values cross from a captured real response to a secret provider without entering reports. */
export const authSecuritySecrets: AuthSecuritySecrets = holder.authE2eSecuritySecrets ??= {};
