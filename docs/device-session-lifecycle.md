# Device lifetime and consumer authority

Interactive OAuth credentials belong to the central session identified by `sid`.
A valid JWT signature alone is insufficient: Auth requires a live, unexpired
session belonging to the subject, an existing unbanned user, and an enabled
issuing client. JWT access tokens need no persistent access-token row.
Sessionless legacy credentials require a fresh login.

## Consumer check

A confidential application calls `POST /api/v1/auth/oauth2/introspect` using its
own client authentication (`client_secret_basic` is supported), with a form body
`token=<access token>&token_type_hint=access_token`. The native endpoint validates
signature, issuer, audience and the caller's permission to introspect that token.
Auth additionally validates current session, user and client state.

Require `active: true`, the expected `client_id` and `sub`, a nonempty `sid`, and
an unexpired `exp`. Missing or invalid authority returns `{ "active": false }`.
Non-200 responses, malformed results and unavailable authority fail closed.
Positive caching must have a hard maximum of 60 seconds; security-sensitive and
school-access requests require fresh authority. Do not renew cached authority
from a stale response or use refresh success as a substitute for introspection.

Only an administrator-approved client with `skipConsent: true` and a recognized
`metadata.subsystem` receives current `caps` for that subsystem and
`cquBindStatus`. Introspection removes stale copies of these fields from the
JWT. It does not add profile or role information: fetch profile/email through
native `/oauth2/userinfo`, which honors the token's scopes.

Use the native `/oauth2/token` endpoint to rotate refresh credentials. Auth
requires the stored refresh credential's live session even with `offline_access`.
QuickLogin device requests additionally retain their existing current grant and
device checks. DPoP proof validation is handled separately at the resource request;
introspection is an authenticated server-to-server authority check.

## Revocation scope

- App-local logout destroys that app's local session. It does not invoke central
  logout and must not silently log the user back in before they choose to log in.
- Central single-device revocation ends that session and its OAuth renewal.
- Central all-device logout ends every central session and associated OAuth
  renewal. Device trust and pending second-factor login records are removed.
- Password change verifies the existing password, preserves the current session,
  ends other sessions and removes existing device trust.
- Password reset ends old sessions, OAuth renewal and device trust, while keeping
  registered MFA/Passkeys. The next login must still satisfy those factors.

These operations do not remove private Worker RPC service credentials, school
bindings, business entitlements or background synchronization configuration.
The settings security section exposes single-device and all-device revocation.
