# Passkey authentication

Passkey ceremonies run at the origin configured by `BETTER_AUTH_URL`, with its
hostname as RP ID. Registration and authentication request user verification
(UV), and server hooks reject an assertion or registration without UV. The
central site's RP ID is never shared with a consumer's local session or DPoP key.

The official Better Auth plugin owns credentials, login and key management.
Registration requires a five-minute `mfa` proof and binds its native one-use
challenge to the current user and session. Anonymous registration and creating a
new session while binding a key are disabled. Delete and rename require the same
recent proof.

For an existing session, `/security/passkey/options` and
`/security/passkey/complete` perform a separate assertion. The verification record
contains the current user, session, purpose and challenge. Completion atomically
consumes the record, validates credential ownership, RP/origin and UV, and updates
the credential counter conditionally. It grants a five-minute purpose proof and
session-long strong admission without replacing the session.

## Sensitive operations without a password

Better Auth 1.7.7's `allowPasswordless` applies only when no credential password
exists. The following narrow application endpoints instead require a current,
purpose-bound proof whose recorded method is `passkey`:

| Endpoint suffix under `/security/passkey` | Purpose |
| --- | --- |
| `/change-password` | `password` |
| `/two-factor/enable` | `mfa` |
| `/two-factor/disable` | `mfa` |
| `/two-factor/generate-backup-codes` | `mfa` |

They use the native account/factor tables, password hashing and encrypted factor
storage. TOTP enrollment remains pending until the native `/two-factor/verify-totp`
verifies the newly configured authenticator. Recovery codes retain the configured
native format and are consumed by the native atomic verification mechanism. To
replace an authenticator, disable it and enroll the replacement using Passkey.
Disabling refreshes the current session's user data and clears device trust.
Password changes share the native path's other-session revocation hook.

Native password endpoints keep their original password verification and MFA
proof requirements. No password checker is replaced, no fabricated credential
account is supplied to the native plugin, and no new authentication table or
cache is needed. Older plain-user-ID proof records remain usable until expiry,
but never authorize these password-free operations.
