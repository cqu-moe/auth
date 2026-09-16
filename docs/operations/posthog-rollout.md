# PostHog rollout evidence

Date: 2026-09-16 (Asia/Shanghai)

## Scope and task status

- [x] Task 1: fetched all three `origin/main` branches, created isolated `codex/posthog-fresh` worktrees, read all applicable `AGENTS.md` files, the full CLI agent guide, official PostHog skills and version-matched SDK documentation.
- [x] Task 2: Auth Web/Worker events, identity, privacy, error capture and source-map upload implemented and deployed. Production Worker SDK smoke and a valid Auth Web symbol set were read back.
- [x] Task 3: Schedule Web/Worker events, terminal CAS outcomes, duration and Cron heartbeat implemented and deployed. Production Worker SDK smoke and 18 valid Schedule Web symbol sets were read back; real sync traffic remains pending.
- [x] Task 4: Auth Python/aiohttp SDK integration covers unexpected and converted exception exits. The Container image is deployed and `ready` with 5 live instances; an actual Container failure path has not been induced.
- [x] Task 5: QuickLogin MV3 integration and privacy controls implemented. A tokenized 0.3.0 canary was rebuilt from the verified project configuration and passed package integrity checks. Unpacked Chrome Reload acceptance remains pending.
- [ ] Task 6: native Cloudflare logs/traces are enabled. PostHog OTLP destinations, PostHog metrics and independent uptime remain blocked as recorded below.
- [x] Task 7: applicable project settings, analyses, dashboards, cohorts, a test-only flag, a draft experiment, a draft survey and a rollout notebook were created with dry-run/apply/readback. Alerts and Product Tours remain blocked.
- [x] Task 8: all branches and main commits were pushed; Auth CI and Schedule Git Connector deployed production; health, versions, source maps, production-tagged smoke and privacy were read back. Real login/binding/sync and extension Reload remain pending.

## Isolated worktrees and production baseline

| Repository | Worktree | Branch | Baseline |
|---|---|---|---|
| Auth | `/Users/uu/Developer/cqu-moe/auth/.worktrees/posthog-fresh` | `codex/posthog-fresh` | `cb4389300e261996551ffac79450c2f66277af5d` |
| Schedule | `/Users/uu/Developer/cqu-moe/schedule-cloudflare/.worktrees/posthog-fresh` | `codex/posthog-fresh` | `537d5567237800fed25e048dab13f888cdddb9f5` |
| QuickLogin | `/Users/uu/Developer/cqu-moe/quicklogin/.worktrees/posthog-fresh` | `codex/posthog-fresh` | `ff14ba879b6a36e875d846c0715f63c2f5dea2f1` |

The three main checkouts contained pre-existing user files where reported by `git status`; none were changed or removed. Existing `codex/posthog-platform` worktrees were left untouched.

Production deployment readback before this change:

- Auth deployment `50b5e07b-1d01-446d-969a-9dbdc0e7efe3`, 100% version `22014c4d-c283-4f5f-b12d-557ec2d4ee74`, created `2026-09-15T13:48:10.254269Z`.
- Schedule deployment `374de5e8-805c-4865-9a57-064bbf04c905`, 100% version `902b4ddc-a1c7-4141-bdf7-38222744d1ab`, created `2026-09-15T07:08:49.2242Z`.

Production deployment after this change:

- Auth commit `9546241f46852603e02911deff6097a63f94f0d9`, Cloudflare 100% version `d7924cda-4891-406e-ae6f-50aa753f3c39`, deployed `2026-09-16T05:27:54.369Z`. Container state `ready`, 5 live instances.
- Schedule commit `89148fe466c259d3f3159dc9f6e4731f042672b9`, Cloudflare 100% version `bbd97dbb-d216-488e-8602-4e4867a56875`, deployed `2026-09-16T05:33:09.356Z` through Git Connector build `083c7897-a19f-4748-8bf6-9de58964c877`.

The pre-change version IDs remain the tested rollback targets.

## Tool and account evidence

- `posthog-cli api --agent-help` was read in full. `posthog-cli api skill list` was run and matching official skills were installed/refreshed and read.
- Context7 IDs resolved and queried: `/posthog/posthog-js`, `/posthog/posthog-python`, and `/llmstxt/developers_cloudflare_workers_llms-full_txt`.
- Installed versions: `posthog-js@1.433.5`, `@posthog/react@1.11.0`, `posthog-node@5.52.4`, `@posthog/rollup-plugin@1.6.0`, Python `posthog==7.54.0`.
- The official Wizard was run for both Vite frontends. Its TUI requires at least 80x28 while the controlled PTY is fixed at 80x24; published `--ci` mode is disabled. The equivalent official SDK setup was applied manually.
- Authenticated CLI readback confirms US project ID `608620`, name `cqu.moe`, and administrator access. The public project token is deliberately omitted from this document.
- Auth and Schedule Cloudflare secret-name readback confirms `POSTHOG_PROJECT_TOKEN` is configured. Auth GitHub Actions and Schedule Git Connector build variables/secrets were written and read back without recording the management key.

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

| Repository/platform | Gate | Result |
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
| PostHog ingestion | unique smoke event and `$exception` | both read back with service `auth-worker`, environment `preview`, release `ab2dd1c` |
| PostHog Error Tracking | issue grouping | one active medium issue, one occurrence, library `posthog-node` |
| PostHog privacy | forbidden property query | password, cookie, token, student ID, email, schedule and subscription URL absent from taxonomy and null on both smoke rows |
| PostHog dashboards | forced fresh read | all three dashboards returned zero/no production data; preview/smoke data is excluded by saved filters |
| PostHog project | settings readback | timezone, IP anonymization, exception capture, performance, replay, 10% sample, masking and heatmaps confirmed |
| Auth CI | [branch run 35058711400](https://github.com/cqu-moe/auth/actions/runs/35058711400) | all gates passed; 0% version uploaded; Auth Web release and one source-map chunk uploaded |
| Auth production | [main run 35059202947](https://github.com/cqu-moe/auth/actions/runs/35059202947) | all gates and D1 migration passed; version `d7924cda-4891-406e-ae6f-50aa753f3c39` serves 100% |
| Schedule production | [Git Connector build 083c7897](https://dash.cloudflare.com/a666c560407022706a52a703923548d5/workers/services/view/schedule-beta-cqu-moe/production/builds/083c7897-a19f-4748-8bf6-9de58964c877) | success; commit `89148fe`; version `bbd97dbb-d216-488e-8602-4e4867a56875` serves 100% |
| Source maps | platform + build-log readback | 19 valid symbol sets with files: 1 Auth Web and 18 Schedule Web; Schedule build skipped re-upload because all 18 already existed |
| Public health | isolated browser | Auth `/api/v1/health` returned `status=ok`; Schedule `/api/v2/health` returned `status=ok`, commit `89148fe`, date `2026-09-16` |
| Production SDK smoke | smoke ID `posthog-prod-1789537265621-860428652` | Auth Worker and Schedule Worker each ingested one event and one exception with production release tags; smoke is explicitly synthetic/local SDK verification, not user traffic |
| Production smoke privacy | HogQL readback | all four rows had null password, cookie, token, student ID, email, schedule and subscription URL; the two exceptions grouped into [issue `01a0a8bb-…`](https://us.posthog.com/project/608620/error_tracking/01a0a8bb-ec80-7913-8b7f-2e83eb98d6a8) |

Local tests/builds are not online acceptance. The production-tagged smoke proves the SDK/API path and privacy boundary for synthetic payloads only; it does not prove real login, binding, sync, replay or extension behavior.

## PostHog platform resources

### Dashboards

- [CQU 服务运行](https://us.posthog.com/project/608620/dashboard/2101601) — ID `2101601`, 3 tiles.
- [CQU 业务结果](https://us.posthog.com/project/608620/dashboard/2101602) — ID `2101602`, 4 tiles.
- [CQU 用户体验](https://us.posthog.com/project/608620/dashboard/2101603) — ID `2101603`, 5 tiles.

### Saved insights

- [系统异常（按服务）](https://us.posthog.com/project/608620/insights/TNFTthEb)
- [Schedule Cron 心跳](https://us.posthog.com/project/608620/insights/v1ZFEh7y)
- [同步耗时 p95](https://us.posthog.com/project/608620/insights/BjptXzwO)
- [Auth 登录完成](https://us.posthog.com/project/608620/insights/PxmDKwBA)
- [CQU 绑定结果](https://us.posthog.com/project/608620/insights/6PBGIvRN)
- [Schedule 同步结果](https://us.posthog.com/project/608620/insights/Tmrcy1eK)
- [QuickLogin 操作结果](https://us.posthog.com/project/608620/insights/zUrJAkII)
- [Web 活跃用户](https://us.posthog.com/project/608620/insights/oFI8VhY4)
- [QuickLogin 成功失败](https://us.posthog.com/project/608620/insights/udxF5Umu)
- [访问→登录→首次成功同步](https://us.posthog.com/project/608620/insights/OsykxRgl)
- [首次成功同步后的周留存](https://us.posthog.com/project/608620/insights/gBRH3AtC)
- [网页访问路径](https://us.posthog.com/project/608620/insights/Ay0A2xox), including `/view/:token` path normalization.

Every saved insight applies the production environment filter and excludes the synthetic preview/smoke rows.

### Controlled resources

- [Feature flag `schedule-onboarding-guide`](https://us.posthog.com/project/608620/feature_flags/889355) — active only for existing cohort `Internal / Test users` at 100%; default is false for everyone else.
- [Schedule onboarding guide experiment](https://us.posthog.com/project/608620/experiments/464601) — draft, no dates, no metrics, no traffic launched.
- [首次同步体验 survey](https://us.posthog.com/project/608620/surveys/01a0a87b-c50a-0000-12a0-9e11921b25c0) — one multiple-choice question, draft, not launched.
- [活跃用户（30天）](https://us.posthog.com/project/608620/cohorts/573463) — calculated, current count 0.
- [CQU 绑定失败（30天）](https://us.posthog.com/project/608620/cohorts/573465) — calculated, current count 0.
- [首次同步失败候选（30天）](https://us.posthog.com/project/608620/cohorts/573464) — calculated, current count 0.
- [CQU PostHog rollout analysis](https://us.posthog.com/project/608620/notebooks/vxKsuNZN) — notebook version 1 with dashboards, key analyses, controlled resources and activation boundaries.

## Product/function coverage

| Function | Status | Evidence or blocker |
|---|---|---|
| Error Tracking | 已验证 | Auth/Schedule production-tagged Worker exceptions ingested with release/service properties; Auth/Schedule Web source maps are present. Python, real browser and QuickLogin exception symbolization still await natural/authorized paths. |
| Web/Product Analytics | 已配置待真实数据 | Production code and tokens are deployed. Synthetic Worker release events are verified, but real login/binding/sync/QuickLogin events and stable browser pageviews are not; existing WAF blocked the automated browser after health checks. |
| Session Replay | 已配置待真实数据 | Project enabled at 10%; inputs and all text masked; application safe-route controls deployed. No recording was produced/inspected because the safe Auth page was WAF-blocked and 10% sampling does not guarantee a Schedule recording. |
| Heatmaps | 已配置待真实数据 | Project enabled and application capture restricted to safe pages. No deployed heatmap data exists. |
| Dashboards/Insights | 已验证 | Three dashboards and twelve saved insights created and read back. Synthetic smoke is excluded; normal production results remain unknown until real traffic arrives. |
| Alerts | 草案待启用 | Slack and email integration lists are empty. Alert creation requires a subscribed recipient; none was selected and no notification was sent. Planned rules remain: exception spike, two missed heartbeats, failure-rate threshold, latency threshold and recovery. |
| Feature Flags | 已验证 | Non-critical onboarding flag was read back active only for the existing internal/test cohort; all other users receive false. |
| Experiments | 草案待启用 | Draft 50/50 onboarding experiment exists with no metrics/dates and has never enrolled traffic. |
| Surveys | 草案待启用 | Draft first-sync survey exists and has not been launched; success-only targeting must be rechecked before activation. |
| Product Tours | 被阻塞 | The current PostHog CLI exposes no Product Tours management tool. No custom tour framework was added. |
| Cohorts | 已配置待真实数据 | Three dynamic cohorts were created, calculated and read back; membership needs real production traffic. |
| AI insights/Notebooks | 已验证 | Rollout notebook created and read back; it explicitly records no-production-data and activation boundaries. |
| Data Warehouse | 不适用 | No necessary safe external source; credentials and full databases are excluded. |
| Data Pipelines | 不适用 | No external destination. Sending-time redaction remains authoritative. |
| Workflows | 不适用 | Native alerts are the appropriate maintainer path; no authorized recipient exists. |
| LLM Analytics | 不适用 | No LLM flow exists in scope. |
| Revenue Analytics | 不适用 | No charging flow exists in scope. |
| Logs | 被阻塞 | Cloudflare native Worker logs are enabled. PostHog OTLP export would alter production and unaudited console payloads may contain personal data; destination creation is deferred until release approval and field audit. |
| Traces | 被阻塞 | Cloudflare native traces are enabled. PostHog OTLP destination and deployed span readback require production configuration. |
| Metrics | 被阻塞 | Cloudflare native metrics remain authoritative; Workers OTLP metrics export is not supported by the documented destination path. |
| Uptime | 被阻塞 | Planned independent checks: Auth/Schedule public health every 5 minutes, alert after two semantic failures, recovery notification. No independent uptime account is connected; same-platform Cron was not substituted. |
| Quota alerts | 被阻塞 | No approved notification destination or budget recipient exists. |

## Project settings readback

- `anonymize_ips=true`, timezone `Asia/Shanghai`, week starts Monday.
- exception autocapture enabled; console log capture disabled; performance capture enabled.
- replay enabled at `0.10`; `maskAllInputs=true`; `maskTextSelector="*"`; no network payload capture configuration.
- heatmaps enabled.

## Remaining external configuration

- Auth/Schedule Worker runtime, Auth GitHub Actions and Schedule Git Connector PostHog values are configured and were exercised by production builds.
- Create Cloudflare OTLP destinations only after release authorization and log-field audit; documented endpoints are `/i/v1/logs` and `/i/v1/traces` with the project token.
- Add an explicit alert/uptime recipient or integration before enabling alerts and recovery notifications.

## Release and acceptance boundary

- Auth commits: `ab2dd1c` (`feat(observability): instrument auth with PostHog`), `a5ae686` (`docs(observability): finalize rollout evidence`); this updated evidence is committed separately after final verification.
- Schedule commits: `955e48e` (`feat(observability): instrument schedule with PostHog`), `89148fe` (`chore(observability): stamp schedule release`).
- QuickLogin commits: `bc54201` (`feat(observability): instrument quicklogin with PostHog`), `8bb2cb6` and `fd8649c` (canary evidence).
- QuickLogin tokenized local artifact: `releases/cqu-quicklogin-0.3.0-canary.zip`, SHA-256 `c55434507cab339d18c0e6e23346810d3a920fd1694f34cf2bef8c0962e9910e`, 8 files and 3 manifest references. `unzip -t` found no errors. It has not been loaded into Chrome or uploaded to the Store.
- All three `codex/posthog-fresh` branches and all three `main` branches were pushed. Auth/Schedule production and source maps were deployed. Extension Reload, Chrome Web Store action, alert notification, OTLP destination and uptime monitor were not performed.
- Auth and Schedule health/version acceptance passed. Normal login, CQU binding, one real Schedule sync, QuickLogin Reload/operation, replay inspection and failure/recovery alerts remain manual/traffic-dependent acceptance gates. No OTP or CAPTCHA flow was retried.
- Rollback begins by disabling telemetry/replay/export, then uses normal Git revert and release. The pre-change Cloudflare version IDs above are the current rollback references.
