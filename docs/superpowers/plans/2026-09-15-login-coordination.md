# Login coordination implementation plan

**Goal:** Recover interrupted CAS and QuickLogin operations without stale 39-minute locks, duplicate verification sends, or late writes to a replacement binding.

**Architecture:** Keep per-account coordination in CquSessionDO. Add boot-scoped cancellation receipts to the browser service; reconcile persisted operations outside constructor concurrency barriers. Retain the existing API and OTP isolation contract. A per-account Workflow durably coordinates bounded recovery; Schedule waits for session recovery without losing cached calendar data.

**Constraints:** Preserve credentials and working sessions. Do not deploy, push, or modify main. Legacy containers without cancellation support must fail closed. Cancellation acknowledgement means the old browser task has stopped and the token cannot start later on that boot. Persist retry scheduling before external I/O. Every state/lock finalization checks operation ownership.

## Task 1: Container cancellation protocol
- [x] Add failing aiohttp tests for cancelling running work (including finally cleanup), cancelling before /run, repeated cancellation, stale boot, and duplicate /run tokens.
- [x] Add POST /login-cancel {session}; acknowledge {ok:true, stopped:true} only after cleanup. Add login-cancel-v1 capability. Retain boot-scoped terminal token tombstones through legacy token TTL (40 minutes); never log credentials or codes. Reject /run and code/permit for retired tokens. Do not cancel other jobs.
- [x] Run browser runtime and server test suite.

## Task 2: DO recovery and coordination
- [x] Add restart tests with QuickLogin locks and mixed CAS/QuickLogin queues; prove current failure.
- [x] Constructor does local recovery/capture only; external permit replay runs after initialization. Capture persisted QuickLogin tokens, reconcile cancellation via exact stored boot route, then atomically release only matching lock and lease entries. Failed cancellation keeps the fence and retries by alarm.
- [x] Add explicit operation deadline to new lock records and use one budget through preparation/permit/run. Legacy lock compatibility retained. Ensure maintenance alarms select the earliest recovery deadline.
- [x] Add regression tests for late success/failure after lock or binding replacement, and enforce token/epoch checks on terminal writes.
- [x] Preserve observed OTP isolation independently of task cleanup, avoid resetting the fence on repeated activation.

## Task 3: Verification and review
- [x] Run targeted Node, workerd and Python tests; run backend and DO typechecks and complete relevant suites.
- [x] Independently review cancellation races, startup behavior, queue handoff and alarm scheduling; fix actionable findings.
- [x] Record validation evidence and remaining deployment acceptance gates here.

## Expanded scope approved during implementation

See ../specs/2026-09-15-login-coordination.md. Workflows, account retry cooldown, stale QuickLogin result protection, and Schedule session-recovery-specific attempts are included. User authorized merge to main, push, and production deployment after verification.

## Validation before release

- Auth: 747 Node/frontend tests passed; 241 workerd tests passed; backend and DO typechecks passed.
- Container: 363 Python tests passed.
- Schedule: 397 tests passed, 21 pre-existing skips; typecheck passed.
- Auth API artifact generation check, import boundaries, OpenAPI lint, frontend build/lint passed.
- Worker/Workflow dry-run passed with containers-rollout none. Local Docker Hub metadata fetch returned EOF; actual container image build must pass in production CI.
- Independent reviews covered token fencing, QuickLogin cache races, lost Workflow create/finish acknowledgements, replay clocks, OTP late-arrival isolation, and capacity-to-session-recovery budget transitions.
- Proactive transient refresh regression was mutation-checked: removing old-session preservation produced expired instead of active; restored implementation passes.
- One existing QuickLogin device alarm test failed once during full parallel run, passed independently and in a complete rerun; no production change was made for that test timing.
