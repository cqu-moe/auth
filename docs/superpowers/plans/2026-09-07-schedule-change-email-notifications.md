# Schedule Change Email Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send one compact email after a successful personal sync when future course or exam arrangements changed, gated by an Auth entitlement and a user-controlled Schedule switch.

**Architecture:** Schedule owns the preference, baseline, diff, and email rendering, then produces a recipient-free Cloudflare Queue message. Auth consumes that queue, rechecks the entitlement and verified account email, and sends through Resend with a deterministic idempotency key. There is no notification outbox.

**Tech Stack:** TypeScript, Cloudflare Workers/Queues/D1, Hono, Drizzle ORM, Vue 3/Pinia, Vitest, Resend.

**Spec:** `docs/superpowers/specs/2026-09-07-schedule-change-email-notifications-design.md`

## Global Constraints

- Only events whose end time is strictly after the sync timestamp may appear.
- Course and exam changes from one harvest are merged into one email per user.
- The first successful sync creates a baseline without sending.
- Disabled or ineligible users still advance the baseline; enqueue failure does not.
- Queue payloads never contain an email address or CQU credentials.
- Auth alone selects the current verified recipient and fixed sender.
- Keep the UI and HTML email compact, plain, and free of decorative cards or gradients.

---

### Task 1: Auth capability and queue consumer

**Files:**
- Modify: `src/capabilities.ts`
- Modify: `src/types.ts`
- Modify: `src/index.ts`
- Modify: `wrangler.jsonc`
- Create: `src/queue/schedule-notifications.ts`
- Create: `src/queue/schedule-notifications.test.ts`
- Modify: `src/capabilities.test.ts`
- Modify: `src/services/entitlements.test.ts`

**Interfaces:**
- Consumes: `resolveCaps(db, userId, "calendar")`, Better Auth `user` table, `RESEND_API_KEY`.
- Produces: `ScheduleNotificationMessageV1`; `processScheduleNotificationBatch(batch, env, send?)`.

- [ ] **Step 1: Write failing tests** for the new `change_notification` flag, runtime payload bounds, eligibility/verified-email gates, fixed sender, payload HTML/text, idempotency key, and retry-versus-ack classification.
- [ ] **Step 2: Run tests to verify failure:** `npm test -- src/capabilities.test.ts src/services/entitlements.test.ts src/queue/schedule-notifications.test.ts` must fail because the capability and consumer do not exist.
- [ ] **Step 3: Implement minimal consumer:** parse the V1 payload, look up `user.id/email/emailVerified`, resolve current calendar caps, call `resend.emails.send({from:"重庆大学课表 <noreply@cqu.moe>",to: email, subject, html, text},{idempotencyKey: notificationId})`, and ack or retry each message.
- [ ] **Step 4: Bind the queue:** add `SCHEDULE_NOTIFICATIONS` to `Env`, add the queue consumer configuration, and dispatch the queue from the default Worker export.
- [ ] **Step 5: Run tests and typecheck:** `npm test -- src/capabilities.test.ts src/services/entitlements.test.ts src/queue/schedule-notifications.test.ts && npm run typecheck` must pass.
- [ ] **Step 6: Commit:** `git add src wrangler.jsonc && git commit -m "feat: consume schedule change notifications"`.

### Task 2: Schedule persistence and settings API

**Files:**
- Modify: `schedule-cloudflare/src/db/schema.ts`
- Create: `schedule-cloudflare/drizzle/migrations/0009_schedule_notification_state.sql`
- Modify: `schedule-cloudflare/drizzle/migrations/meta/_journal.json`
- Create: `schedule-cloudflare/src/routes/v2/notification-settings.ts`
- Create: `schedule-cloudflare/src/routes/v2/notification-settings.test.ts`
- Modify: `schedule-cloudflare/src/index.ts`
- Modify: `schedule-cloudflare/src/services/auth-rpc.ts`
- Modify: `schedule-cloudflare/src/services/auth-mock.ts`

**Interfaces:**
- Consumes: session `user.id` and `caps.calendar.change_notification`.
- Produces: `notificationState` table; `GET/PUT /api/v2/notification-settings` returning `{eligible, enabled}`.

- [ ] **Step 1: Write failing API tests** proving unauthenticated rejection, false defaults, entitled enable, non-entitled enable rejection, and always-allowed disable.
- [ ] **Step 2: Run the focused test:** `npm test -- src/routes/v2/notification-settings.test.ts` must fail before the route/table exist.
- [ ] **Step 3: Add schema and migration:** create the single-row-per-user state with `enabled`, nullable snapshot/hash, and ISO timestamps.
- [ ] **Step 4: Implement and mount the route:** derive ownership only from the verified session and never clear the snapshot when the switch changes.
- [ ] **Step 5: Run tests and typecheck:** `npm test -- src/routes/v2/notification-settings.test.ts src/services/auth-rpc.test.ts && npm run typecheck` must pass.
- [ ] **Step 6: Commit:** `git add src drizzle && git commit -m "feat: add schedule notification settings"`.

### Task 3: Schedule snapshot, future diff, and email rendering

**Files:**
- Create: `schedule-cloudflare/src/services/schedule-notifications.ts`
- Create: `schedule-cloudflare/src/services/schedule-notifications.test.ts`

**Interfaces:**
- Consumes: `PersonalScheduleData`, `CourseEntry`, `ExamEntry`, `calculateCourseEventTime`, `TIME_SLOTS`.
- Produces: `normalizeSchedule(data)`, `hashSchedule(snapshot)`, `diffFutureSchedule(oldSnapshot,newSnapshot,now)`, `renderScheduleChangeEmail(diff, links)`, `notificationId(userId,oldHash,newHash)`.

- [ ] **Step 1: Write failing pure tests** for stable normalization, duplicate week removal, exact China-time expansion, strict future filtering, course/exam add/cancel/change, concrete dates, merged sections, HTML escaping, text fallback, and five-date truncation.
- [ ] **Step 2: Run tests to verify failure:** `npm test -- src/services/schedule-notifications.test.ts` must fail because the module is absent.
- [ ] **Step 3: Implement normalization and deterministic SHA-256 hashing** using Web Crypto and stable sorted arrays.
- [ ] **Step 4: Implement conservative matching and future-only diffs** with course name/experiment grouping and nearest-time exam pairing.
- [ ] **Step 5: Implement the compact 620px HTML table template and matching text body** using `https://schedule.cqu.moe/` and `https://schedule.cqu.moe/#notification-settings` links.
- [ ] **Step 6: Run tests and typecheck:** `npm test -- src/services/schedule-notifications.test.ts && npm run typecheck` must pass.
- [ ] **Step 7: Commit:** `git add src/services && git commit -m "feat: diff and render schedule changes"`.

### Task 4: Integrate notification production into personal sync

**Files:**
- Modify: `schedule-cloudflare/src/types.ts`
- Modify: `schedule-cloudflare/src/cron/schedule-sync.ts`
- Modify: `schedule-cloudflare/src/cron/schedule-sync.harvest.test.ts`
- Modify: `schedule-cloudflare/wrangler.jsonc`

**Interfaces:**
- Consumes: Task 2 state/table and Task 3 diff/render helpers.
- Produces: one `SCHEDULE_NOTIFICATION_QUEUE.send(message)` operation per changed user harvest.

- [ ] **Step 1: Extend harvest tests** for baseline-only first sync, disabled/ineligible baseline advancement, identical no-op, one merged message across the personal trio, enqueue-success baseline advance, and enqueue-failure baseline preservation with successful schedule sync.
- [ ] **Step 2: Run the focused test:** `npm test -- src/cron/schedule-sync.harvest.test.ts` must expose the missing integration.
- [ ] **Step 3: Add a user-level single-flight notification promise** adjacent to the existing per-user harvest promise so duplicate subscription messages share one decision.
- [ ] **Step 4: Add the producer binding and call it after personal subscription writes:** baseline first/disabled/ineligible/no-diff locally; changed state only after `Queue.send()` resolves.
- [ ] **Step 5: Run tests and typecheck:** `npm test -- src/cron/schedule-sync.harvest.test.ts src/cron/schedule-sync.test.ts && npm run typecheck` must pass.
- [ ] **Step 6: Commit:** `git add src wrangler.jsonc && git commit -m "feat: enqueue future schedule changes"`.

### Task 5: Schedule dashboard switch

**Files:**
- Modify: `schedule-cloudflare/frontend/src/types/api.ts`
- Modify: `schedule-cloudflare/frontend/src/api/index.ts`
- Modify: `schedule-cloudflare/frontend/src/stores/session.ts`
- Modify: `schedule-cloudflare/frontend/src/views/Dashboard.vue`
- Modify: `schedule-cloudflare/frontend/src/api/__tests__/index.test.ts`
- Modify: `schedule-cloudflare/frontend/src/stores/__tests__/session.test.ts`
- Modify: `schedule-cloudflare/frontend/src/views/__tests__/Dashboard.test.ts`

**Interfaces:**
- Consumes: Task 2 settings API and `CalendarCaps.change_notification`.
- Produces: compact accessible notification switch with optimistic loading guard and failure rollback.

- [ ] **Step 1: Write failing frontend tests** for capability typing, eligible visibility, settings load, save, disabled loading state, accessible label, and error rollback.
- [ ] **Step 2: Run tests to verify failure:** `npm run test:frontend -- --run src/views/__tests__/Dashboard.test.ts` must fail before the controls exist.
- [ ] **Step 3: Add typed API methods** `getNotificationSettings()` and `updateNotificationSettings(enabled)`.
- [ ] **Step 4: Add a compact switch beside auto-sync status** with label `课表变更通知`, short helper text, and no separate settings page.
- [ ] **Step 5: Run frontend tests/build:** `npm run test:frontend && npm run build:frontend` must pass.
- [ ] **Step 6: Commit:** `git add frontend && git commit -m "feat: add schedule notification switch"`.

### Task 6: Cross-repository verification and deployment

**Files:**
- Verify all files above and both final diffs.

**Interfaces:**
- Consumes: completed Auth consumer and Schedule producer/UI.
- Produces: deployed Auth then Schedule, with migration and queue bindings active.

- [ ] **Step 1: Run Auth verification:** `npm test && npm run typecheck && npm run typecheck:do && npm run build:frontend`.
- [ ] **Step 2: Run Schedule verification:** `npm test && npm run test:frontend && npm run typecheck && npm run build:frontend`.
- [ ] **Step 3: Inspect changes:** verify `git diff --check`, repository status, migration contents, and producer/consumer queue names match exactly.
- [ ] **Step 4: Push Auth first** so the queue has a consumer before messages can be produced.
- [ ] **Step 5: Apply the Schedule production D1 migration and push Schedule** through its existing deployment path.
- [ ] **Step 6: Verify deployment evidence:** inspect Actions/connector state and health/config responses; report that real email receipt still requires a controlled eligible account sync.
