# PostHog rollout evidence

Date: 2026-09-16 (Asia/Shanghai)

## Scope and task status

- [x] Task 1: clean worktrees, dependencies, CLI guide, official skills, SDK documentation, baseline SHAs and current Cloudflare deployment IDs recorded.
- [x] Task 2: Auth Web/Worker code and local verification complete. Real PostHog ingestion and deployed source-map verification are blocked.
- [x] Task 3: Schedule Web/Worker code, terminal CAS events, Cron heartbeat and local verification complete. Real ingestion is blocked.
- [x] Task 4: Auth Python/aiohttp SDK integration and local verification complete. A deployed Container and real ingestion are blocked.
- [x] Task 5: QuickLogin MV3 integration, version 0.3.0 build and package gate complete. Final tokenized canary ZIP and unpacked Reload acceptance are blocked.
- [ ] Task 6: Cloudflare native logs/traces are already enabled; PostHog OTLP destinations, PostHog metrics and independent uptime are blocked as detailed below.
- [ ] Task 7: platform product configuration is blocked by missing PostHog CLI authentication; applicability decisions are recorded below.
- [x] Task 8: full local gates completed. Commits are recorded after this document; no push or deployment is authorized.

## Isolated worktrees and production baseline

| Repository | Worktree | Branch | Baseline |
|---|---|---|---|
| Auth | `/Users/uu/Developer/cqu-moe/auth/.worktrees/posthog-fresh` | `codex/posthog-fresh` | `cb4389300e261996551ffac79450c2f66277af5d` |
| Schedule | `/Users/uu/Developer/cqu-moe/schedule-cloudflare/.worktrees/posthog-fresh` | `codex/posthog-fresh` | `537d5567237800fed25e048dab13f888cdddb9f5` |
| QuickLogin | `/Users/uu/Developer/cqu-moe/quicklogin/.worktrees/posthog-fresh` | `codex/posthog-fresh` | `ff14ba879b6a36e875d846c0715f63c2f5dea2f1` |

The three main checkouts contained pre-existing user files where reported by `git status`; none were changed or removed. Existing `codex/posthog-platform` worktrees were left untouched.

Current production deployment readback before this change:

- Auth deployment `50b5e07b-1d01-446d-969a-9dbdc0e7efe3`, 100% version `22014c4d-c283-4f5f-b12d-557ec2d4ee74`, created `2026-09-15T13:48:10.254269Z`.
- Schedule deployment `374de5e8-805c-4865-9a57-064bbf04c905`, 100% version `902b4ddc-a1c7-4141-bdf7-38222744d1ab`, created `2026-09-15T07:08:49.2242Z`.

These version IDs are rollback references only until a release is explicitly authorized.

## Tool and account evidence

- `posthog-cli api --agent-help` was read in full using `POSTHOG_HOME=/private/tmp/posthog-home`.
- `posthog-cli api skill list` succeeded. Installed/read official skills for best practices, React/Vite, Vue 3, Hono, Web/React/Python error tracking, Vite source maps and Python integration.
- `cloudflare-workers` and `identify-users` appeared in the skill list but had no downloadable archive; installed best-practice references and official docs supplied the equivalent guidance.
- Context7 IDs resolved and queried: `/posthog/posthog-js`, `/posthog/posthog-python`, and `/llmstxt/developers_cloudflare_workers_llms-full_txt`.
- Installed versions: `posthog-js@1.433.5`, `@posthog/react@1.11.0`, `posthog-node@5.52.4`, `@posthog/rollup-plugin@1.6.0`, Python `posthog==7.54.0`.
- Official Wizard help succeeded. The integration TUI was run in both Auth and Schedule frontends, but the controlled PTY is fixed at 80x24 and Wizard requires at least 80x28. Official docs state interactive mode is the supported published path and published `--ci` is disabled. No generated diff was available; official SDK/manual setup was used.
- PostHog CLI project calls were attempted only after `info` schema readback. Project, organization and quota calls all returned `Missing PostHog API key`.
- Official US login was attempted twice. Both polling sessions ended with `peer closed connection without sending TLS close_notify`; no credential was stored. Supplied target `cqu.moe`, project ID `608620`, and US region therefore remain **unverified account state**.
- Cloudflare secret-name readback succeeded. Neither Auth nor Schedule currently has `POSTHOG_PROJECT_TOKEN` configured.

## Implemented code

### Auth Web and Worker

- One history-change SPA pageview source; internal `user.id` identify; reset on logout/account switch; `auth_login_completed` only on anonymous-to-authenticated transition.
- Autocapture, heatmaps and replay are limited to `/auth/error`; replay masks every input and all text and records neither network bodies nor headers.
- Browser and Worker `before_send` recursively redact password, Cookie, Authorization, token, OTP/code, ticket, student ID, email, schedule and subscription URL fields. URL query/hash are removed and dynamic IDs templated.
- React global capture/Error Boundary and Hono top-level/nested 500 handling are wired without changing expected 400/415 responses.
- Worker events use SDK batching/retry with `flushAt: 1`, `flushInterval: 0`, bounded timeout and `waitUntil`/shutdown. Telemetry failure never changes the response.
- `cqu_binding_completed` is sent only after the existing D1 active-state batch succeeds. Retryable intermediate failures are not mislabeled terminal.
- Vite source-map upload is conditional on CI management credentials and uploads/deletes maps in the same build that deploys `dist`.

### Schedule Web and Worker

- Vue initializes once, uses `app.config.errorHandler`, and captures one pageview per router completion. `/view/:token` is templated before capture.
- Safe replay/autocapture pages are `/`, `/api-docs`, and `/changelog`; dashboard, add, and shared-calendar routes stop replay. Text/inputs remain masked; network body/header capture is off.
- Session identify/reset uses the verified internal Auth user ID only.
- `markSyncSuccess` and `markSyncError` return whether the conditional update changed exactly one row. Repeated, stale, or terminal deliveries do not emit again.
- `schedule_sync_completed` contains outcome, trigger, run ID, internal subscription ID, optional duration and safe error code. Retry branches remain queued.
- Existing hourly Cron emits `service_heartbeat` only after its scan/enqueue function completes.
- HTTP and exhausted sync exceptions use SDK-native capture; Queue ack/retry and sync semantics remain unchanged.

### Auth Python/aiohttp Container

- Instance-based Python SDK with native async queue, retry, timeout, `before_send`, privacy mode, exception autocapture and bounded queue.
- aiohttp middleware re-raises unexpected errors after capture. Converted residual failures for login, service-ticket, keepalive and harvest report only safe operation/error codes.
- `/health` and `/ping` are excluded.
- Cleanup uses `await asyncio.to_thread(client.flush, timeout_seconds=2)`. Installed 7.54.0 has no bounded `shutdown()`; tail events may be lost after the bounded flush.
- Container image includes the helper and receives runtime values from the Container class without baking a token into the image.

### QuickLogin MV3

- Version 0.3.0 in package, lockfile and manifest.
- Static `posthog-js/dist/module.no-external`; remote dependency loading disabled; memory persistence; no pageview/autocapture/replay/surveys/tours/flags; random installation ID in `chrome.storage.local`.
- Only `https://us.i.posthog.com/*` was added to host permissions, with the official PostHog `connect-src` CSP. No collector is injected into Auth/CQU pages.
- Connect, user-triggered sync/enable/disable/resume/switch, verified Cookie application and safe exceptions are recorded without Cookie/token values.
- SDK capture plus browser SDK `shutdown()` provides best-effort flush in existing async work. No telemetry alarm, persistent retry queue or business retry change was added.

## Verification ledger

| Repository | Gate | Result |
|---|---|---|
| Auth | typecheck / DO typecheck | passed |
| Auth | `npm test` | 90 files, 856 tests passed |
| Auth | `npm run test:do` | 28 files, 284 tests passed |
| Auth | API artifacts, API lint, import boundaries | passed; tsx IPC checks required normal local permissions |
| Auth | frontend lint/build | passed; bundle-size warning only |
| Auth | Python `unittest discover` | 69 tests passed after test-only `pytest` install in the isolated venv |
| Schedule | typecheck | passed |
| Schedule | Worker tests | 39 files; 400 passed, 21 skipped |
| Schedule | frontend tests | 24 files; 294 passed, 13 skipped |
| Schedule | frontend build | passed |
| QuickLogin | typecheck/test/build/package | passed; 18 files/83 tests; package gate 8 files and 3 manifest references |

Synthetic secret tests cover event properties and URL normalization. They do not prove deployed ingestion/replay privacy.

## Product/function coverage

| Function | Status | Evidence or blocker |
|---|---|---|
| Error Tracking | 已配置待真实数据 | SDK-native capture exists in six services. Grouping, source maps and filters need auth, token and deployment. |
| Web/Product Analytics | 已配置待真实数据 | Pageview, identity, login, binding, sync terminal and QuickLogin operation events implemented; no real readback. |
| Session Replay | 草案待启用 | Safe routes and strict masking implemented. Project-side 10% sampling and synthetic-secret replay inspection require project access. |
| Heatmaps | 草案待启用 | Capture restricted to the same safe pages. Project enablement/readback blocked. |
| Dashboards/Insights | 被阻塞 | Three dashboards/insights were not created because `posthog-cli api` is unauthenticated. |
| Alerts | 被阻塞 | Rules exist in the plan, but no authenticated notification destination/project access exists. No message was sent. |
| Feature Flags | 草案待启用 | No core behavior is flag-controlled. Non-critical onboarding flag remains a platform draft because project access is blocked. |
| Experiments | 草案待启用 | Onboarding control/guide experiment specified; no traffic allocation authorization or platform access. |
| Surveys | 草案待启用 | First-success multiple-choice survey not created; project access blocked. |
| Product Tours | 被阻塞 | Account capability/stable-element setup cannot be checked; no custom tour framework added. |
| Cohorts | 已配置待真实数据 | Taxonomy supports active, binding-failure and first-sync-failure cohorts; saving requires access/data. |
| Data Warehouse | 不适用 | No necessary safe external source; Auth credentials/full databases are excluded. |
| Data Pipelines | 不适用 | No external destination. Sending-time redaction remains authoritative. |
| Workflows | 不适用 | Native alerts are the appropriate maintainer path; no authorized recipient exists. |
| AI insights/Notebooks | 被阻塞 | Saving analysis requires authenticated access and real samples. |
| LLM/Revenue Analytics | 不适用 | No LLM or charging flow exists in scope. |
| Logs | 被阻塞 | Cloudflare native Worker logs are enabled. PostHog OTLP needs project token/destination; unaudited full console export risks personal data. |
| Traces | 被阻塞 | Cloudflare native traces are enabled. PostHog OTLP destination and span readback need token/configuration. |
| Metrics | 被阻塞 | Cloudflare docs state Workers OTLP metrics export is not supported. Native metrics remain authoritative; PostHog entitlement unqueried. |
| Uptime | 被阻塞 | Planned: Auth/Schedule public health every 5 minutes, two semantic failures alert, recovery notification. No independent external service/account is connected; same-platform Cron was not substituted. |
| Quota alerts | 被阻塞 | Product limits/budget alerts cannot be queried without PostHog authentication. |

## Required configuration before release

- Complete `posthog-cli login`; verify US project ID `608620`, name `cqu.moe`, project token, product entitlements, limits and notification channels.
- Auth/Schedule Worker runtime: `POSTHOG_PROJECT_TOKEN`.
- Auth GitHub Actions: variable `POSTHOG_PROJECT_TOKEN`, variable `POSTHOG_CLI_PROJECT_ID`, secret `POSTHOG_CLI_API_KEY`.
- Schedule Git Connector build: `VITE_POSTHOG_PROJECT_TOKEN`, `VITE_POSTHOG_HOST`, `VITE_RELEASE`, `POSTHOG_CLI_API_KEY`, `POSTHOG_CLI_PROJECT_ID`, `POSTHOG_CLI_HOST`.
- QuickLogin build: `VITE_POSTHOG_PROJECT_TOKEN` and `VITE_POSTHOG_HOST`; without them telemetry is intentionally disabled.
- Create Cloudflare OTel destinations only after token verification and log-field audit; official endpoints are `/i/v1/logs` and `/i/v1/traces` with bearer project token.

## Release and acceptance boundary

- No branch was pushed. No Worker, Container, Git Connector build, source map, PostHog resource, extension Reload, Store action, alert notification or uptime monitor was deployed/triggered.
- Local tests/builds are not online acceptance.
- Production release needs a later explicit instruction. Then verify deployed SHAs/versions, Container health, real login/binding/sync, extension Reload, unique smoke event/error, symbol sets, replay privacy, Logs/Traces, alerts and recovery.
- Rollback begins by disabling telemetry/replay/export, then uses normal Git revert and release. The pre-change Cloudflare version IDs above are current rollback references.
