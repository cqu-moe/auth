# Central Auth cutover and joint acceptance

This is an executable release plan, not a deployment report. No production migration, client update, secret change, traffic change or consumer deployment was performed by this work. Complete the inventory and staging gates below before executing the release steps.

## Confirmed consumers and production snapshot (2026-10-09)

| Consumer | Confirmed source / deployment | Delivery and remaining production work |
| --- | --- | --- |
| Auth | Worker `cqu-moe-auth`; latest listed 100% version `38dd4e9d-f2d6-4157-8b39-8b80ff5738c4`, 2026-09-30 | Integration PR #52, not deployed. Remote D1 reports migrations 0010–0013 pending. |
| Schedule | `cqu-moe/schedule-cloudflare`; live `e2114ae`, Worker `schedule-beta-cqu-moe`, version `27045a03-6584-428e-aaec-88498b0b908c` | Independent session implementation `9d6cd7f`, PR #123. Apply Schedule 0016, configure approved client metadata/scopes and deploy before final Auth cutover. |
| UC | User-confirmed repository `/Users/uu/Developer/cqu-moe/uc`; deployed source `faa7fa3`, Worker `uc-cqu-moe`, version `cdd2a5d0-7c37-4cd6-befa-c530595ba9fb` | Local implementation `23b1c1f`; no remote. Register its currently missing OAuth client, apply UC OAuth migration and deploy. Do not publish to `uc-old`. |
| QuickLogin extension | `cqu-moe/quick-login`, source `8320069607d14fde88fd9835245bc5e30131c3da`, package 0.4.1 | Uses OAuth bearer credentials, not shared session cookies. Server accepts its existing `prompt=consent` for the approved client without a consent screen. Installed Chrome identity flow remains a manual staging gate. |
| QuickLogin download website | Same repository, `website/src/download.ts:loadDownloadState`; live Worker `quick-login-website`, version `85331cef-36bb-4212-b690-1cbf90bc54db` (2026-10-09T03:30:43Z), no commit metadata | Retain its exact-origin credentialed GET/HEAD status read from `https://quicklogin.cqu.moe` to `/api/v1/cqu/quicklogin`. Cookie is sent to Auth, not exposed to the website. This grants no account writes or general credentialed CORS. Verify download eligibility after cutover. |

At 2026-10-09 05:34 UTC, read-only deployment status confirmed 100% traffic for these exact deployments: Auth `cf847c95-5c23-4b55-a4fc-19244560d371`, Schedule `4298620d-d8ab-48bb-bb1b-f8933f1ae471`, UC `bce04c08-67a7-4bae-a6e9-adcb428da63e`, download website `91f898cd-6b0b-4ef4-a337-3e74c8672028`. These IDs identify production snapshots, not this implementation's delivery.

The live download page also documents JavaScript eligibility checks and Auth download verification; version metadata does not prove byte identity with the inspected source.

The local source search found no additional consumers beyond these known sources (and historical `uc-old`), but does not enumerate every remote deployment. The release owner must confirm the operational inventory, identify every deployed caller of shared-cookie `verifySession`, and migrate or retire it. Repository presence or two client rows alone cannot satisfy this gate.

Read-only remote SQL returned exactly two OAuth clients with `rows_written=0`, `changed_db=false`:

- Schedule `YKJBemjAnsyywZbkKlEZaqIXggTrILVp`: enabled, skipConsent/PKCE true, Basic client authentication, callback `https://schedule.cqu.moe/callback`; scopes `openid profile email cqu:ticket:jwxt`, grant `authorization_code`, metadata null. Add `offline_access`, `refresh_token`, and administrator-owned metadata `subsystem:"calendar"`, `rpcMethods:["getCaps","cquHarvest"]`. Preserve approved existing scopes.
- QuickLogin `cqu-quicklogin-chrome`: enabled, PKCE true, skipConsent false, public `none` authentication, code/refresh grants, `openid offline_access cqu:quicklogin:device`; callback `https://igfidegfgfoofnoncpmbcokbffjmmook.chromiumapp.org/`; exact official extension metadata. Migration 0013 updates only this approved contract, leaving disabled, owned or mismatched records untouched.
- UC has no client. Register a confidential web first-party client with `skip_consent:true`, S256 required, Basic authentication, code/refresh grants, `openid profile offline_access`, callback `https://uc.cqu.moe/_emdash/api/auth/uc/finish`. No calendar metadata. Save the secret through UC `UC_CLIENT_ID`/`UC_CLIENT_SECRET`, never frontend variables or SQL logs. Preserve issuer `https://auth.cqu.moe/api/auth` and set `UC_ORIGIN=https://uc.cqu.moe`.

The deployed schema has no `applicationType` column yet; an initial read including it failed, then the existing-column query above succeeded without writes. Do not assume the final schema is already deployed.

## Final behavior

HTTPS Auth uses `__Host-auth-v2.*`: Secure, HttpOnly, SameSite=Lax, Path=/, no Domain. Better Auth automatic `__Secure-` wrapping is disabled so the browser actually sees the required `__Host-` prefix; Secure remains explicitly enabled. Native session, MFA, trusted-device and Passkey challenge cookies share this policy. Local HTTP uses the separate `auth-v2.*` namespace. Known legacy cookies and bounded cache chunks are expired as both host-only and `Domain=cqu.moe` copies when presented to Auth. Arbitrary names and consumer cookies are untouched.

Final migration 0013 retires all old central sessions, OAuth access/refresh rows and pending verification/trust flows, and increments the auth write revision. Accounts, passwords, Passkeys, MFA configuration, OAuth consent records, school binding, entitlements and service clients remain. Users must sign in again, reconnect browser/extension sessions, and restart pending verification. This is intentional: a namespace change alone would not invalidate a copied old token presented under the new name. Private RPC background synchronization remains subject to current user/binding/entitlement checks and does not depend on those browser tokens.

Only the configured central origin is trusted for native account mutations. Consumer OAuth redirects and confidential token/introspection calls do not add sibling origins to that trust list. The exact read-only download-site CORS exception remains; device bearer CORS retains its existing official-extension policy. The exact `/api/v1/auth/oauth2/token` response restores CORS only for the configured official extension Origin after native response handling, without allowing credentials; actual code and refresh requests are covered through the app HTTP entrypoint.

Administrator-owned `skipConsent` is the first-party approval marker. For an enabled approved client, only `consent` is removed from authorize prompts, including the old plugin's request; login/account-selection semantics and invalid `none consent` combinations remain native. GET and form POST both keep PKCE, redirect, scope and user checks. Existing first-party consent rows cannot be updated/deleted by users; third-party owned consents retain native editing. Device disconnect, local logout and product enablement remain distinct user controls. Default application authorization does not enable devices or override business entitlements.

## Release procedure — operator execution only

1. Confirm the complete deployed inventory and maintenance ownership. Rerun nonsecret preflight from the intended checkout:

   ```sh
   npx wrangler deployments list
   npx wrangler d1 migrations list auth-cqu-moe-db --remote
   npx wrangler d1 execute auth-cqu-moe-db --remote --command 'SELECT clientId,name,disabled,skipConsent,requirePKCE,redirectUris,scopes,metadata,tokenEndpointAuthMethod,grantTypes,responseTypes FROM oauthClient'
   ```

   Record backup/Time Travel recovery identifiers operationally without copying secrets or user records into this repository. Confirm accounts, bindings, entitlements and client counts through approved operational checks.

2. Before compatibility Auth starts enforcing RPC method/subsystem policy, prepare Schedule’s approved `subsystem:"calendar"`, `rpcMethods:["getCaps","cquHarvest"]` metadata through the existing authorized administration interface. Current Schedule business calls do not require `getCquTicket`; grant it only if a separately approved caller is evidenced. If the old interface cannot set metadata, use a controlled maintenance window and configure it immediately after compatibility deployment, verifying RPC before reopening traffic. Do not bypass RPC checks during transition.

   Build the compatibility release from Auth `3f132a3538a92c71ac20a0ee2cd48640cbe476c5` **plus the two-file introspection capacity patch from `f12261675f2786beba080d36e343694eaad96fb6`**. The unpatched base retains the native 100/minute introspection limit and is not the intended consumer-migration release. The patch raises only that endpoint to 6,000 requests/60 seconds and includes the regression for 101 legitimate no-IP requests plus rejection of unauthenticated introspection. The D1-backed budget remains bounded; missing-IP traffic shares a bucket.

   Prepare an isolated checkout from a repository containing both commits (choose another unused worktree/branch name if needed):

   ```sh
   git worktree add -b codex/auth-security-compat ../auth-security-compat 3f132a3538a92c71ac20a0ee2cd48640cbe476c5
   git diff f12261675f2786beba080d36e343694eaad96fb6^ f12261675f2786beba080d36e343694eaad96fb6 -- src/auth.ts test/do/device-lifecycle.do.test.ts | git -C ../auth-security-compat apply --check
   git diff f12261675f2786beba080d36e343694eaad96fb6^ f12261675f2786beba080d36e343694eaad96fb6 -- src/auth.ts test/do/device-lifecycle.do.test.ts | git -C ../auth-security-compat apply
   cd ../auth-security-compat
   npm ci
   npm exec --yes --package=pnpm@11.19.0 -- pnpm --dir frontend install --frozen-lockfile
   npm run typecheck
   npm run test:do -- test/do/device-lifecycle.do.test.ts test/do/auth-d1-baseline.test.ts
   npm --prefix frontend run build
   git diff --check
   git diff --stat
   ```

   Local reconstruction on 2026-10-09 verified that this exact two-file patch applies cleanly: typecheck, both Workers/D1 suites (11 tests), frontend build and diff checks passed. The migration directory ended at 0012 and the pre-cutover Cookie policy was unchanged. This was isolated local validation, not a production release.

   Before committing this compatibility release, verify that only `src/auth.ts` and `test/do/device-lifecycle.do.test.ts` changed, migrations still end at **0012**, and the base's shared Cookie policy remains. Check the effective Git identity, commit the two-file patch, and record the resulting compatibility commit as the release artifact; do not describe the unpatched base as the deployed revision. Do not cherry-pick the whole final branch or replace this base with final HEAD: that would introduce the credential-retiring 0013 too early.

   This compatibility release includes native 1.7 D1 storage, current-token/RPC authority, Passkey/recovery and the normal-password current-session fix. Apply its pending additive migrations with `npx wrangler d1 migrations apply auth-cqu-moe-db --remote`, then deploy that exact reviewed compatibility artifact using the existing release procedure. Only after that artifact is serving should step 3 migrate consumers.

3. Configure approved clients through the existing strong-authenticated administration API, including Schedule refresh grants/scopes and the new UC client (RPC metadata must already be prepared at stage 2). Keep secrets on the servers. Deploy Schedule and UC using their own migration/runbooks (`docs/application-session-migration.md` and `docs/operations/uc-oauth.md`). Preserve Schedule CACHE and UC SESSION KV. Verify intended production/staging hosts, login, explicit local logout, central revocation and background authorization before proceeding. No shared-cookie fallback may remain in a deployed consumer.

4. Complete the manual staging gates below, then enter a controlled Auth maintenance window: stop routing authentication/callback writes to the compatibility version and drain in-flight requests. Do not run final cleanup while old code continues issuing shared-domain sessions. Pause old client provisioners during the flag transition. From the final reviewed checkout run `npx wrangler d1 migrations list auth-cqu-moe-db --remote`, confirm only the reviewed remaining migrations (normally 0013), then `npx wrangler d1 migrations apply auth-cqu-moe-db --remote`. Inspect the known official client and verify cleanup. A mismatched official record must be repaired through administrator tooling; never broaden the SQL to all clients.

5. Deploy the final Auth build before reopening authentication traffic. No old shared-cookie version may receive traffic afterwards. Verify new Set-Cookie metadata, rejection of old cookies even when renamed, exact origin rejection, extension code/token/device flow, download eligibility, both consumers and administrative strong-authentication/recovery. Complete one genuine reconnect rather than assuming a cleared Cookie is sufficient. Review error rates and fail-closed behavior; record deployed version IDs separately from code SHAs.

## Failure and rollback

Before final credential retirement, a consumer release may be rolled back under the compatibility Auth version if its previous dependencies remain available. After 0013, treat authentication failures as fail-closed: correct missing configuration or fix forward, or use a previously validated build that preserves the isolated namespace and current-token contract. Never restore wildcard trusted origins, root-domain credentials, disabled PKCE, missing-sid acceptance, removed Auth KV or old sessions/tokens as an automatic rollback.

Additive migrations are not reversed after newer writes. A failed migration/deploy keeps the maintenance window closed until schema, client configuration and code agree. A recovery-point restore needs an explicit operational incident decision and must not resurrect compromised interactive credentials; reapply retirement before reopening. OAuth client mistakes are repaired in administration with current strong authentication. Consumers retain business data even when login fails.

## Evidence and remaining acceptance

Automated owning boundaries are real HTTP/D1 and AuthService Worker RPC, plus UI tests. `cutover.do.test.ts` checks HTTPS session/Passkey/MFA/trust Cookie attributes, old-cookie rejection, hostile sibling origin, GET/form POST old-plugin prompts, actual extension-Origin preflight, code/token/refresh and bearer device registration, consent ownership and migration retirement. Existing suites cover #36 current user/client JWT rejection; #37 D1/DO failure and deleting-state fail-closed binding; optional DPoP replay/key binding alongside Bearer; strong admin/recent proof; Passkey signatures; all-device/password/recovery revocation; RPC continuity and recovery races. These are not production deployment evidence.

Actual local browser evidence recorded by the parent task:

- Auth localhost, Schedule 127.0.0.1 and UC [::1] used distinct hosts. Both consumers completed real Auth code/PKCE login, kept their own cookies, and local logout left Auth/other site usable; explicit re-login reused central authentication.
- Central all-device logout sent Auth to login; Schedule `/api/v2/me` returned 401 and UC protected membership administration redirected to login on the next request.
- Password-only administrator was blocked from management, could configure TOTP, and gained access after verification. The normal password-change form plus TOTP retained the current session after the independently fixed native body-override bug; formal `/api/v1/auth/get-session` confirmed it.
- Actual recovery UI returned one random password; old-password login was 401, new-password login 200, and closing the result removed its input. Synthetic credentials were not saved in the report.

Final cutover browser rerun passed at Auth `d0e6b1d9d600a5fdeb44b1d6aacaacee44a163e2`, Schedule `9d6cd7f3ba4f47af2a523e2f315eb767692f1476`, UC `23b1c1f93421c5cd215adef0df29a151a7186664`, after applying 0013 to local fixture D1 only:

- Actual Auth password + TOTP login succeeded; `/api/v1/auth/get-session` returned the live session. Both consumers then completed OAuth without repeated credential entry.
- Browser metadata showed central `auth-v2.session_token` on localhost, HttpOnly/Lax/Path=/, with no remaining legacy `better-auth` cookies. Schedule retained `__Host-schedule_session` on 127.0.0.1 (Secure/HttpOnly/Lax/Path=/); UC retained host-only `astro-session` on [::1] (HttpOnly/Lax/Path=/).
- UC's actual form logout reached `/login` while Schedule remained 200 and Auth stayed authenticated; explicit UC login reconnected. Schedule logout stopped at `/signed-out?returnTo=%2Fdashboard`, preserved Auth, and explicit re-login reconnected.
- Central all-device logout reached Auth login; Schedule's next `/api/v2/me` returned 401 and UC's protected members page redirected to login.

Auth and UC local HTTP cookies were not Secure; this fixture does not demonstrate production HTTPS browser enforcement of `__Host-auth-v2`. Production attributes and old-credential rejection have real HTTP/D1 protocol coverage; verify HTTPS behavior during the production/staging release. No production migration or browser account was used.

Four independent read-only static reports (Auth Standards/Spec and combined consumer Standards/Spec) found **0 actionable findings**. Fixed reviewed differences were Auth `4ea1cf055fd25ee877160f7683d3b24eb69e718a...d0e6b1d9d600a5fdeb44b1d6aacaacee44a163e2` (149 files), Schedule `e2114ae2abcd461ebab20fb72694d3f2ed8a46b2...9d6cd7f3ba4f47af2a523e2f315eb767692f1476` (33 files), and UC `faa7fa373b3c0bd1caedf6efc5b0a77723515e6c...23b1c1f93421c5cd215adef0df29a151a7186664` (29 files). Standards reviews used repository/global rules and the Fowler baseline; Spec reviews checked the approved spec and relevant tickets. Coverage included OAuth/session boundaries, strong authentication/Passkey, recovery and revocation, RPC, migrations, UI and operating documents. These reports are static review evidence, not additional test runs or deployment acceptance.

Passkey browser enrollment remains unaccepted: the permitted virtual WebAuthn environment returned NotAllowedError despite valid local setup. Cryptographic protocol tests passed, but they do not substitute for a browser/device ceremony. No real user vault or browser extension configuration was modified.

QuickLogin 0.4.1 unchanged-source isolated checks passed: 20 files/96 tests, types, build, package/contract checks and 8 release-script tests. Local canary ZIP SHA-256 `18c7c536de108b9f4723285406e53c45a6590aed1c5ca126791eed4a91927cc5`, source `8320069`, protocol 3. This was not published or installed. Before production, manually verify in an isolated authorized staging browser: actual `chrome.identity.launchWebAuthFlow`, registered extension callback, reconnect after cutover, device enable/disable and permitted school-cookie behavior; also actual Passkey enrollment/login/re-authentication, browser Secure/host-prefix enforcement, download eligibility and intended consumer hosts. Do not use production school credentials to fill a local test gap.

API/MCP platform implementation is still deferred. Existing issuer, audience/resource, user delegation, service identity and business entitlement concepts are preserved without a new gateway or authorization framework.
