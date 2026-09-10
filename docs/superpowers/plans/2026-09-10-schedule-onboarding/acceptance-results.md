# Schedule onboarding acceptance results

Date: 2026-09-10 (Asia/Shanghai)

Scope: local worktrees, automated tests, local production builds, deterministic browser fixtures, and frozen-reference comparison. No push, deployment, production migration, production Queue message, real email, or real school-account mutation was performed.

## Worktrees and commits

### Auth

- Worktree: `/Users/uu/Developer/cqu-moe/auth/.worktrees/schedule-onboarding`
- Branch: `codex/schedule-onboarding`
- Implementation commits:
  - `6fc7233` `fix(auth): confirm first login before binding activation`
  - `e550725` `fix(auth): preserve binding continuation through authentication`
  - `ebed06d` `feat(auth): continue and resume CQU binding with service return`
  - `756628a` `test(auth): cover onboarding continuation and recovery`

### Schedule

- Worktree: `/Users/uu/Developer/cqu-moe/schedule-cloudflare/.worktrees/schedule-onboarding`
- Branch: `codex/schedule-onboarding`
- Implementation and validation commits:
  - `69a7cfb` `feat(schedule): initialize default subscriptions atomically`
  - `ca9e53b` `feat(schedule): dispatch and recover one initial personal sync`
  - `5ae2406` `feat(schedule): expose idempotent default subscription setup`
  - `1051977` `feat(schedule): continue service entry into automatic personal setup`
  - `0823283` `feat(schedule): add the approved first-sync status notice`
  - `50431f4` `feat(schedule): integrate approved first-sync feedback into subscriptions`
  - `1e91562` `fix(schedule): align first-sync mobile layout with reference`
  - `543d0f1` `test(schedule): verify setup persistence across route instances`

## Automated verification

### Auth

- `npm test -- --reporter=dot --silent`: 51 files, 502 tests passed.
- `npm run typecheck`: passed.
- `npm --prefix frontend run build`: passed (206 modules transformed).
- `git diff --check`: passed.
- Durable Object methods/config were not changed, so the plan's conditional DO suite was not required.

### Schedule

- The literal root `npm test` was run and reproduced the repository-documented configuration defect: the Workers Vitest pool picked up `frontend/**`, causing 17 `@/` alias loader errors. That run also found one missing new-table fixture, which was fixed. This command is not reported as passing.
- `npx vitest run --exclude 'frontend/**' --reporter=dot --silent`: 32 backend files, 344 tests passed, 21 pre-existing skips.
- `npm --prefix frontend test -- --reporter=dot --silent`: 23 frontend files, 290 tests passed, 13 pre-existing skips.
- `npm run typecheck`: passed.
- `npm --prefix frontend run build`: passed (2490 modules transformed).
- `git diff --check`: passed.
- A separate real-D1 route test rebuilds the Hono client after the first request and verifies the persisted setup returns `resumed`, keeps exactly three rows, sends no second Queue message, and preserves link tokens.

## Contract coverage

- Auth tests cover nested login/register/email/2FA/password-reset continuation, cross-tab session refresh, current-user sessionStorage isolation, active legacy credentials without an email row, refresh recovery, invalid/looping return targets, and success countdown cancellation.
- Schedule real-D1 tests cover three subscriptions/three default links/one setup in one batch, same-user and cross-user concurrency, `sync=false`, quota 0/1/2 versus 3/unlimited, existing subscriptions, deletion non-restoration, batch token collision rollback, database failure propagation, corrupt setup JSON, and client recreation persistence.
- Queue tests cover one initial message per shared run, 60-second owner leases, takeover, failed dispatch persistence, token stability, stale-owner protection, manual-run supersession, 25-user recovery limit, per-user recovery isolation, one harvest for all surviving views, terminal duplicate acknowledgement, stale run protection, and revoked entitlement.
- Frontend tests cover explicit `setup=1`, concurrent begin coalescing, local retry for unknown/error status, created Add-to-Dashboard routing, existing Add retention, optional list metadata, initialization versus sync retry separation, first-data link disabling, old-data link availability, dismissal, pending dispatch recovery, focus reload coalescing, notification/share/download/delete/QR/web/cooldown preservation, and mobile classes.

## Browser and visual evidence

The browser fixture served the production `frontend/dist` bundle and deterministic non-real API data. It did not replace Dashboard code and did not contain a real subscription token.

- Frozen package verification: `Approved reference verified: 16 files`.
- The full staged diff check reports nine trailing-whitespace lines inside the immutable frozen `baseline/auth-preplan.patch`. The artifact was not edited to silence Git because that would invalidate the approved hashes; `git diff --cached --check` excluding only that frozen patch passed.
- Production `FirstSyncNotice.vue` matched the frozen implementation reference byte-for-byte with `cmp`.
- 1280×960 metrics: viewport width and document `scrollWidth` both 1280; main content width 672px; header bottom 78px; title top 96px; one notice and three cards in each state.
- 390×844 metrics: viewport width and document `scrollWidth` both 390; header bottom 114px; title top 144px; one notice and three cards in each state. No horizontal overflow or title overlap remained after the validation fix.
- DOM inspection found no percentage and no weekly-grid text. The visible `(3/10)` in fixture screenshots came from API `count=3` and `sub_limit=10`; production source contains no `3/10` constant.
- Ego interaction checks: copy changed to `已复制`; QR content opened; the real More menu exposed ICS/JSON/CSV downloads, share management, and delete; the notification switch changed `aria-checked`; keyboard Enter activated retry and dismissed the success notice.
- Reduced-motion emulation: spinner animation `none`, notice animation `none`, icon transition duration `0s`, with status text still present.
- Dark-mode emulation retained the existing token theme (`html.dark` true); the production component introduced no hard-coded light palette.
- The success fixture exposes the real returned semester badge (`2026秋`), which is intentionally dynamic and allowed by the frozen comparison rules.

Final screenshots:

- `evidence/production-desktop-syncing.png`
- `evidence/production-desktop-success.png`
- `evidence/production-desktop-error.png`
- `evidence/production-mobile-syncing.png`
- `evidence/production-mobile-success.png`
- `evidence/production-mobile-error.png`
- Supplemental: `evidence/production-mobile-syncing-reduced-motion.png`
- Supplemental: `evidence/production-desktop-success-dark.png`

## Not verified with real services

- A real new account was not registered and no real verification email was sent.
- The school self-service email-change deep link and school login state were not exercised.
- No real CQU password, verification code, Cookie, OAuth token, or subscription token was read or used.
- The real Auth-to-Schedule cross-origin cookie redirect was not exercised against deployed hosts.
- No production D1 migration was applied, no production Queue message was sent or consumed, and no deployed static asset was checked.
- Therefore this is not a claim that the real new-user path or production deployment passed end to end.

## Release status

Not released. Both branches and all commits are local only. Nothing was pushed or deployed, and migration `0010_personal_subscription_setup.sql` was not applied to any production database.
