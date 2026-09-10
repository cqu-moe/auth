# Schedule onboarding execution log

## Task 01 — Auth binding status and pending first login

- Repository / starting HEAD: `auth` at `79026bad4dd29322c458b7517ec0759a91f84c2a`.
- Mechanical difference: the earlier Task 01 commit was created from the ordinary `codex/optimize-new-user-experience` checkout before the user required two project-local worktrees. Its linear commit `6fc72332aac2edf2531f1112bf9f4088c269b6ac` was recovered into `/Users/uu/Developer/cqu-moe/auth/.worktrees/schedule-onboarding` on `codex/schedule-onboarding`; subsequent work is isolated there. The frozen five-file baseline was already present in that commit and was preserved rather than reapplied.
- Red test: `npm test -- src/routes/cqu-bind.test.ts` failed as intended: during a deferred DO `/init`, GET reported `active`; expected `pending`.
- Changes: retain the five frozen Auth fixes; explicitly insert a new credential as `pending`, atomically activate credential and address only after successful init, and add real SQLite-backed D1 route tests including batch rollback behavior.
- Green verification: freshly rerun in the required worktree: `npm test -- src/routes/cqu-bind.test.ts src/rpc.test.ts` (17 passing); `npm run typecheck`; `npm --prefix frontend run build` (Vite build succeeded).
- Local commit: `6fc72332aac2edf2531f1112bf9f4088c269b6ac` (`fix(auth): confirm first login before binding activation`).
- Unfinished: Tasks 02–11; no production migration, deployment, push, or real-account flow was run.

## Task 02 — Preserve the binding continuation

- Repository / starting HEAD: `auth` at `6fc72332aac2edf2531f1112bf9f4088c269b6ac`.
- Red tests: the new continuation suite first failed because `cqu-bind-continuation` did not exist; the sanitizer regression independently failed because `https://evil@schedule.cqu.moe/` was accepted.
- Changes: add the three continuation functions, retain the nested `/cqu/bind?redirect=...` target through protected and email-verification routes, and reject userinfo, control-character, raw-backslash, encoded-leading-separator, and malformed-percent redirect inputs.
- Worktree recovery: the linear commit `e5507254ae7d0baf5ecc46293666140c5c715a49` was used as the Auth worktree tip, preserving Task 02 without changing the original checkout.
- Green verification: freshly rerun in the required worktree: `npm test -- frontend/src/lib/cqu-bind-continuation.test.ts frontend/src/lib/post-login-redirect.test.ts frontend/src/pages/Login.test.ts frontend/src/lib/two-factor.test.ts frontend/src/pages/TwoFactorChallenge.test.tsx frontend/src/pages/TwoFactorSettings.test.tsx src/auth-two-factor.test.ts` (47 passing); `npm run typecheck`.
- Local commit: `e5507254ae7d0baf5ecc46293666140c5c715a49` (`fix(auth): preserve binding continuation through authentication`).
- Unfinished: Tasks 03–11; no production migration, deployment, push, or real-account flow was run.

## Task 03 — Binding bootstrap, recovery, and confirmed success

- Repository / starting HEAD: `auth` at `e5507254ae7d0baf5ecc46293666140c5c715a49`, isolated at `/Users/uu/Developer/cqu-moe/auth/.worktrees/schedule-onboarding` on `codex/schedule-onboarding`.
- Red tests: `npm test -- frontend/src/lib/cqu-bind-progress.test.ts` failed on the missing state/parser implementation, then on nine expected state mismatches; `npm test -- src/routes/cqu-bind.test.ts` failed because GET omitted `kind` and `forwardAddress`; `npm test -- frontend/src/components/CquBindSuccess.test.tsx` failed on the absent success UI; `npm test -- frontend/src/pages/CquBindWizard.test.tsx` failed all six initial bootstrap/confirmation cases, including the old false-green success path.
- Changes: add strict binding snapshot parsing and per-user session progress; expose only validated recovery metadata; bootstrap and resume the real Wizard through GET state; poll pending DO login with backoff and a ten-minute stop; require a post-PUT active GET before success; add the fixed success component and service return behavior.
- Mechanical difference: the plan assigns DOM test setup to Task 04, but Task 03 itself requires interactive countdown/unmount tests. Added the plan-pinned development-only `jsdom@28.1.0` in Task 03; no runtime UI dependency was added.
- Green verification: `npm test -- frontend/src/lib/cqu-bind-progress.test.ts frontend/src/components/CquBindSuccess.test.tsx frontend/src/pages/CquBindWizard.test.tsx src/routes/cqu-bind.test.ts src/rpc.test.ts` (56 passing); `npm run typecheck`; `npm --prefix frontend run build`; `git diff --check`.
- Local commit: `ebed06d` (`feat(auth): continue and resume CQU binding with service return`).
- Unfinished: Tasks 04–11; no production migration, deployment, push, or real-account flow was run.

## Task 04 — Authentication recovery and cross-tab verification

- Repository / starting HEAD: `auth` at `ebed06d` in the required project-local worktree.
- Red tests: `npm test -- frontend/src/lib/refetch-on-return.test.ts` failed because the return listener did not exist; `npm test -- frontend/src/lib/cqu-bind-continuation.test.ts` failed because Schedule source classification did not exist; `npm test -- frontend/src/pages/auth-continuation.test.tsx` produced five expected failures for the missing source hint, lost password-reset callbacks, missing focus refetch, and lost sign-out continuation.
- Changes: refetch the Better Auth session on visible focus/visibility return with cleanup and request coalescing; retain the nested binding target through forgot-password, reset callback, successful reset, verification sign-out, login, and registration; show the fixed Schedule source hint only for a validated binding continuation. Added route integration coverage for signed-out, unverified, 2FA, binding, ordinary login, and OAuth destinations.
- Mechanical difference: the optional frontend lint check exposed the pre-existing Task 02 `no-control-regex` violation. Replaced the two equivalent control-character regex checks with one shared character scanner; the redirect behavior tests stayed green.
- Green verification: `npm test` (51 files, 502 passing); `npm run typecheck`; `npm --prefix frontend run build`; `npm --prefix frontend run lint`; `git diff --check`.
- Local commit: `756628a` (`test(auth): cover onboarding continuation and recovery`).
- Unfinished: Tasks 05–11; no production migration, deployment, push, or real-account flow was run.

## Task 05 — Transactional default subscriptions

- Repository / starting HEAD: `schedule-cloudflare` at `ac88ffbc15b142dcf0ea3b9da58baae41c070b0d`, isolated at `/Users/uu/Developer/cqu-moe/schedule-cloudflare/.worktrees/schedule-onboarding` on `codex/schedule-onboarding`.
- Baseline: existing `src/routes/v2/subscriptions.test.ts` passed 61 tests with 3 pre-existing skips; `npm run typecheck` passed.
- Red test: `npm test -- src/services/personal-subscription-setup.test.ts` first failed on the missing service, then ran 15 real-D1 cases with 14 expected failures against the behavior stub (no rows were created and quota/errors were not enforced).
- Changes: add hand-written migration `0010_personal_subscription_setup.sql`, matching Drizzle schema, persistent setup helpers, and an atomic seven-statement D1 batch for three session-owned personal subscriptions and their default links. Existing users are marked without backfill; setup records prevent deleted defaults from being restored.
- Green verification: `npm test -- src/services/personal-subscription-setup.test.ts src/routes/v2/subscriptions.test.ts` (76 passing, 3 pre-existing skips); `npm run typecheck`; `git diff --check`.
- Local commit: `69a7cfb` (`feat(schedule): initialize default subscriptions atomically`).
- Unfinished: Tasks 06–11; migration file was not applied locally or remotely, and no Queue message, deployment, push, or real-account flow was run.

## Task 06 — Recoverable single-message initial sync

- Repository / starting HEAD: `schedule-cloudflare` at `69a7cfb` in the required project-local worktree.
- Red tests: `npm test -- src/services/personal-setup-dispatch.test.ts` ran nine behavior cases with eight expected failures against the no-op service; producer/consumer tests then failed exactly because cron did not recover pending setup and terminal duplicate messages were retried instead of acknowledged.
- Changes: add a 60-second owner-token dispatch lease, one `personal_all`-preferred Queue message per shared run, failure persistence for only the owned setup/current run, retry restoration without token rotation, 25-user cron recovery with per-user isolation, and consumer terminal-duplicate acknowledgment before `markSyncRunning`.
- Green verification: `npm test -- src/services/personal-setup-dispatch.test.ts src/cron/schedule-sync.harvest.test.ts src/cron/schedule-sync.test.ts src/services/sync-status.test.ts` (65 passing); `npm run typecheck`; `git diff --check`.
- Local commit: `ca9e53b` (`feat(schedule): dispatch and recover one initial personal sync`).
- Boundary: Queue at-least-once behavior remains; a crash after send and before the owner-checked sent update can duplicate the same run. No production Queue, migration, deployment, push, or real-account flow was run.

## Task 07 — Defaults API, list metadata, and deletion protection

- Repository / starting HEAD: `schedule-cloudflare` at `ca9e53b` in the required project-local worktree.
- Red test: `npm test -- src/routes/v2/subscriptions.test.ts` produced 14 expected failures: `/defaults` was 404 and GET omitted `personal_setup`; all 61 pre-existing passing cases remained green with 3 skips.
- Changes: add the authenticated body-independent `/defaults` endpoint with sync/binding/quota gates, Queue dispatch readback, and stable 201/200 responses; add pure-read setup metadata to the existing list shape; atomically write an existing marker before subscription deletion so deleted or historically empty accounts are not repopulated.
- Mechanical difference: root `npm test` is documented to mis-route `frontend/**` through the Workers pool. It reproduced 17 frontend alias loader errors; the same run also identified one backend external-guard fixture missing the new table. The fixture was updated, then backend and frontend suites were run in their correct configs.
- Green verification: route suite 75 passing with 3 pre-existing skips; `npx vitest run --exclude 'frontend/**'` 343 passing with 21 pre-existing skips; `npm run test:frontend` 243 passing with 13 pre-existing skips; `npm run typecheck`; `git diff --check`.
- Local commit: `5ae2406` (`feat(schedule): expose idempotent default subscription setup`).
- Boundary: no migration application, production Queue call, deployment, push, or real-account flow was run.

## Task 08 — Service entry and automatic setup continuation

- Repository / starting HEAD: `schedule-cloudflare` at `5ae2406` in the required project-local worktree.
- Red tests: the new Auth URL suite failed all four missing helpers; API/store/Home/Navbar tests produced nine expected failures for the old login URL, missing defaults call/metadata, and old entry links; the composable behavior stub failed eight of nine control-flow cases; Dashboard link tests failed on the old settings/new-tab destinations.
- Changes: add first-party setup/binding URL builders; route Home, Navbar, protected 401s, Add, and Dashboard binding guidance through Auth while preserving public-read and TOKEN_EXPIRED suppression; add exact frontend setup response types, API method, store metadata/reset, and an in-flight-coalesced setup composable. Add invokes the composable before initial render, refreshes session state, preserves query/hash, retries locally on unknown/error, and only sends newly created/resumed Add visits to Dashboard.
- Mechanical difference: per the plan preface, Dashboard only received the binding/repair URL change in Task 08. Its actual setup invocation, existing pending-dispatch recovery, focus/pageshow reload, and sync-poll integration remain Task 10.
- Green verification: `npm test` in `frontend/` (21 files, 262 passing, 13 pre-existing skips); `npm run build` in `frontend/`; root `npm run typecheck`; `git diff --check`.
- Local commit: `1051977` (`feat(schedule): continue service entry into automatic personal setup`).
- Boundary: no migration, production request, deployment, push, or real-account flow was run.

## Task 09 — Approved first-sync notice and state derivation

- Repository / starting HEAD: `schedule-cloudflare` at `1051977` in the required project-local worktree.
- Red tests: the component test failed because `FirstSyncNotice.vue` did not exist; after adding the state module shape, 11 of 12 table-driven cases failed against the null stub with the expected phase mismatches.
- Changes: copy the frozen `FirstSyncNotice.vue` byte-for-byte; add the pure first-sync phase function over real subscription, target, pending, and local-error state. Mixed active states remain syncing, local terminal errors override stale success, and success requires every surviving target to have both success status and `last_synced_at`.
- Motion/accessibility check: the frozen component uses only the approved 180ms opacity transitions plus the existing Loader2 spinner; its reduced-motion media query disables the spinner, notice entrance, and icon transition. `cmp` confirmed the production component exactly matches the frozen reference.
- Green verification: component/state suites 16 passing; `npm run build` in `frontend/`; root `npm run typecheck`; `git diff --check`.
- Local commit: `0823283` (`feat(schedule): add the approved first-sync status notice`).
- Boundary: the component is not yet wired into Dashboard until Task 10; no deployment, push, or real account was used.

## Task 10 — Dashboard integration without feature regressions

- Repository / starting HEAD: `schedule-cloudflare` at `0823283` in the required project-local worktree.
- Red test: nine focused Dashboard cases produced seven expected failures before wiring: no notice/defaults call, first-sync links remained enabled, success/error/preparation states were absent, and pending dispatch was not recovered by the poll loop.
- Changes: wire the shared setup controller and frozen notice into the existing Dashboard; derive target ids only from persisted created setup metadata; reuse pendingRefresh/localSyncErrors and the existing personal-group refresh; disable only copy/QR/web for first-sync targets without data; keep old valid links usable; preserve Card, notification, download, share, delete, cooldown, and polling behavior. Focus/pageshow reloads session/list through a shared in-flight read and never create defaults without setup=1.
- Mobile-only adjustment: Navbar inner/navigation rows can wrap at narrow widths; Dashboard uses `pt-28 sm:pt-24`, preserving the frozen desktop `pt-24` and existing card button wrapping.
- Green verification: Dashboard 76 passing; Navbar 9 passing; full frontend suite 290 passing with 13 pre-existing skips; frontend production build succeeded; root `npm run typecheck`; `git diff --check`.
- Local commit: `50431f4` (`feat(schedule): integrate approved first-sync feedback into subscriptions`).
- Boundary: no visual claim beyond automated DOM/build checks yet; screenshot comparison is Task 11. No deployment, push, production migration, or real account was used.

## Task 11 — Validation, frozen comparison, and handoff

- Repositories / starting tips: `auth` at `756628a`; `schedule-cloudflare` at `50431f4`.
- Fresh automation: Auth 502/502 tests, typecheck, and frontend build passed. Schedule backend 344 tests passed with 21 pre-existing skips under the required Workers config; frontend 290 tests passed with 13 pre-existing skips; typecheck and production build passed.
- Mechanical difference: root Schedule `npm test` still picks up `frontend/**` in the Workers pool and fails on its `@/` aliases, as documented in `CLAUDE.md`. The backend and frontend suites were run separately in their correct Vitest 3/4 configurations; no tests were removed or skipped to hide this.
- Visual red/fix: real 390px capture found the fixed Navbar overlapping the title by about 2px and later found the nav flex item could overflow a strict CSS viewport. Added mobile-only `pt-36 sm:pt-24` clearance and `w-full sm:w-auto` nav wrapping. Frozen error comparison also found the old red `失败` feedback; first-sync cards now show the approved outline `重试同步` while retaining the same refresh handler. Red tests were observed before both fixes.
- Browser evidence: six final light screenshots cover syncing/success/error at 1280×960 and 390×844. Metrics confirm no horizontal overflow and 30px mobile header/title clearance. Ego verified copy, QR, More-menu downloads/share/delete, notification toggle, keyboard retry/dismiss, reduced motion, and dark tokens.
- Frozen artifact check: the approved package still verifies all 16 hashes. Full staged `git diff --cached --check` reports only nine original trailing-whitespace lines inside immutable `baseline/auth-preplan.patch`; excluding that one frozen patch, the staged diff check passes. The baseline was not edited to silence Git.
- Persistence addition: a new real-D1 route test recreates the Hono client and confirms setup idempotency, token stability, and zero re-enqueue across the new client.
- Local Schedule validation commits: `1e91562` and `543d0f1` on top of Task 10.
- Full results and unverified real-service boundaries: `acceptance-results.md`.
- Release boundary: no push, deploy, production migration, production Queue action, or real-account path was performed.

## Release — Auth Durable Object migration history repair

- Red deployment evidence: GitHub Actions run `34496282836` passed backend/frontend checks, build, and production D1 migrations, then Cloudflare rejected Worker deployment with code `10074`: the published script had migration tag `v3`, which was absent from `wrangler.jsonc`, so Wrangler attempted to replay `v1` against the existing `CquSessionDO` class.
- Mechanical difference: production previously received the Quicklogin `v3` Durable Object namespace, while the later local rollback removed its migration-history entry along with the feature. Restored only the historical `v3` declaration so the legacy migration chain matches production. No Quicklogin binding, export, or behavior was restored.
- Safety boundary: did not add a `deleted_classes` migration because that would permanently delete the existing `CquQuickloginAccountDO` namespace and is outside this onboarding release.
