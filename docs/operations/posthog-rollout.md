# PostHog rollout evidence

Date: 2026-09-16 (Asia/Shanghai)

## Scope and task status

- [x] Task 1: fetched all three `origin/main` branches, created isolated `codex/posthog-fresh` worktrees, read all applicable `AGENTS.md` files, the full CLI agent guide, official PostHog skills and version-matched SDK documentation.
- [x] Task 2: Auth Web/Worker events, identity, privacy, error capture and source-map upload implemented and deployed. Production Worker SDK smoke and a valid Auth Web symbol set were read back.
- [x] Task 3: Schedule Web/Worker events, terminal CAS outcomes, duration and Cron heartbeat implemented and deployed. Production Worker SDK smoke and 18 valid Schedule Web symbol sets were read back; real sync traffic remains pending.
- [x] Task 4: Auth Python/aiohttp SDK integration covers unexpected and converted exception exits. The Container image is deployed and `ready` with 5 live instances; an actual Container failure path has not been induced.
- [x] Task 5: QuickLogin MV3 integration and privacy controls implemented. A tokenized 0.3.3 canary was rebuilt from the verified project configuration and passed package integrity checks. Unpacked Chrome/Ego Reload acceptance remains pending.
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

- Auth cookie-recovery commit `8c04601`, Cloudflare 100% version `4a3cb23e-a599-42be-a096-1f572526da96`, deployed `2026-09-16T09:42:00.823Z` after [main run 35080356830](https://github.com/cqu-moe/auth/actions/runs/35080356830); Container returned to `ready` with 5 live instances.
- Schedule cookie-recovery commit `eec9f04`, Cloudflare 100% version `ee019c59-8e0b-4a96-acf6-934c7c4fff7f`, deployed `2026-09-16T09:20:08.199Z` through Git Connector build `ea7f6531-bdef-4461-879a-1bb94e20d57e`.
- Auth managed-proxy commits through `d7362de`, Cloudflare 100% version `cb076913-dea8-46ea-a43c-74c0847f8564`, deployed by [main run 35089543209](https://github.com/cqu-moe/auth/actions/runs/35089543209); Container application version 72 is `ready` with 5 instances on image tag `cb076913`.
- Schedule managed-proxy commits through `f83cd88`, Cloudflare 100% version `78403ed8-1e33-47a9-a9b5-b64af6e890de`, deployed with no pending D1 migrations.

The pre-change version IDs remain the tested rollback targets.

## Tool and account evidence

- `posthog-cli api --agent-help` was read in full. `posthog-cli api skill list` was run and matching official skills were installed/refreshed and read.
- Context7 IDs resolved and queried: `/posthog/posthog-js`, `/posthog/posthog-python`, and `/llmstxt/developers_cloudflare_workers_llms-full_txt`.
- Installed versions: `posthog-js@1.433.5`, `@posthog/react@1.11.0`, `posthog-node@5.52.4`, `@posthog/rollup-plugin@1.6.0`, Python `posthog==7.54.0`.
- The official Wizard was run for both Vite frontends. Its TUI requires at least 80x28 while the controlled PTY is fixed at 80x24; published `--ci` mode is disabled. The equivalent official SDK setup was applied manually.
- Authenticated CLI readback confirms US project ID `608620`, name `cqu.moe`, and administrator access. The public project token is deliberately omitted from this document.
- Auth and Schedule Cloudflare secret-name readback confirms `POSTHOG_PROJECT_TOKEN` is configured. Auth GitHub Actions and Schedule Git Connector build variables/secrets were written and read back without recording the management key.

## PostHog cookie / WAF incident and recovery

- Cloudflare event `a3bea295cb916827` was a normal `GET /dashboard` with JavaScript detection passed, but the OWASP inbound anomaly score reached 41 and rule 949110 blocked it. The contributing rules included invalid request-header characters, SQL/RCE patterns, and two cookie special-character anomaly rules.
- Installed `posthog-js@1.433.5` defaults were verified from the actual bundle: `persistence="localStorage+cookie"`, cross-subdomain cookies enabled for this hostname, and 365-day cookie lifetime. The emitted persistence cookie is `ph_<project-token>_posthog`. The Auth/Schedule initialization had not overridden these defaults, so the new `.cqu.moe` cookie reached every sibling hostname and was inspected as hostile Cookie input by the existing managed WAF.
- Both frontends now set `persistence="localStorage"` and `cross_subdomain_cookie=false`, and delete the legacy host/domain cookie before initialization. Auth/Schedule red→green tests assert the storage options and deletion behavior.
- Both Workers expose a no-store recovery redirect that expires only the legacy PostHog cookie: Auth `/api/v1/telemetry/reset`, Schedule `/api/v2/telemetry/reset`. It does not clear Better Auth/CQU cookies.
- Cloudflare custom rule `4be23cb49ad34cf3b7498f3d571e676d` was used temporarily to recover clients carrying the legacy cookie. After the new builds and proxy were deployed, the operator explicitly chose to remove the entire exception rather than retain a Managed WAF bypass.
- Isolated Chromium tests injected a synthetic `.cqu.moe` legacy cookie. Each recovery endpoint removed it, redirected to the normal app, and the new frontend did not recreate it. Auth and Schedule both rendered without the Cloudflare block page.
- A second production incident (`a3bf351a0a0bec38`; login POST `a3bf3f1a89f9ec38`) proved that an already-open old bundle could recreate the legacy cookie and make Cloudflare reject normal login before Auth ran. After the targeted rule update, a synthetic-cookie Auth page load deleted the cookie and a synthetic-cookie login POST reached Auth, returning its own `401 application/json` response instead of Cloudflare `403 text/html`.
- Final Cloudflare readback after deletion showed `1/20` custom rules, no recovery-rule row, and both the Cloudflare OWASP Core Ruleset and Cloudflare Managed Ruleset active. The reset endpoints no longer bypass WAF; a client that still carries the legacy cookie must remove it locally or close/reload every old Auth/Schedule tab before retrying.
- Schedule full verification after the fix: 39 Worker files, 401 passed / 21 skipped; 25 frontend files, 295 passed / 13 skipped. Auth branch and main CI passed all repository gates before production deployment.

## QuickLogin 0.3.0–0.3.2 incidents and 0.3.3 repair

- Chrome extension errors showed `connect-src 'self' https://*.posthog.com` blocking `https://auth.cqu.moe/api/v1/cqu/quicklogin/capabilities` and device reconcile before either request reached Auth. Host permissions were correct; the extension-page CSP added for PostHog had accidentally omitted the required Auth origin.
- QuickLogin `9631cf1` changes the exact CSP to `self`, `https://auth.cqu.moe`, and `https://us.i.posthog.com`. The package gate now rejects any CSP that omits Auth or broadens the approved destinations.
- Version 0.3.1 passed typecheck, 18 files / 83 tests, build, package checks and ZIP integrity. Artifact: `releases/cqu-quicklogin-0.3.1-canary.zip`, SHA-256 `0fd1e571c07c4e1bd400dc4e784276b6ebf3ba5e9ae1ac7b4a655cfd865dac92`.
- The exact unpacked directory loaded by Chrome was verified as 0.3.0, backed up, and replaced byte-for-byte with the 0.3.1 `dist`. Chrome Reload and live toggle/reconcile verification remain a distinct user action.
- After the 0.3.1 Reload, Chrome correctly reached Auth but rejected PostHog's `/array/<token>/config` request to `us-assets.i.posthog.com`. The installed SDK source confirmed that `advanced_disable_feature_flags` does not disable remote config; `advanced_disable_flags` is the current option that suppresses flags/config external calls.
- QuickLogin `1c7de1a` uses `advanced_disable_flags=true` without widening CSP. Version 0.3.2 passed typecheck, 18 files / 83 tests, build, package checks and ZIP integrity. Artifact: `releases/cqu-quicklogin-0.3.2-canary.zip`, SHA-256 `b8b16dc4c164dcfbeb0e9ac1ba90476818e3addd86fa6e82ebf8293314ea603a`.
- The loaded unpacked directory was backed up again and replaced byte-for-byte with 0.3.2. Chrome Reload and live toggle/reconcile verification remain pending.
- Direct 0.3.2 testing in Ego showed the extension background was alive and had a fresh protocol-v3 snapshot, but the build still allowed and retried the legacy PostHog ingest host. Version 0.3.3 routes ingestion through `https://p.cqu.moe`, keeps `ui_host=https://us.posthog.com` only for console links, and narrows host permissions/CSP to Auth, SSO and the managed proxy.
- QuickLogin now records expected state transitions such as reconnect-required, device-disabled, rate-limited and user-cancelled as operation outcomes without also creating runtime exception issues. WAF, container, contract, internal-state and unknown server failures remain reportable exceptions.
- Version 0.3.3 passed typecheck, 18 files / 84 tests, build, contract/package checks and ZIP integrity. Artifact: `releases/cqu-quicklogin-0.3.3-canary.zip`, SHA-256 `e60af524c917dd5478c48c3de5333c40648ee9d259500d9ed30dbab0d131cc21`; build provenance commit `27d76932abc807b5f9304e92c3a1341dce53e8e2`.
- Chrome and Ego loaded directories were backed up and replaced byte-for-byte with 0.3.3. Reload is intentionally pending explicit action-time confirmation; no Chrome Web Store upload was performed.

## Managed reverse proxy verification

- `api_host` for Auth Web/Worker/Container, Schedule Web/Worker and QuickLogin is `https://p.cqu.moe`; Auth/Schedule browser SDKs also set `asset_host` to the proxy. `ui_host` remains `https://us.posthog.com` for links only.
- Auth CI and the Schedule build script explicitly pin `VITE_POSTHOG_HOST=https://p.cqu.moe`; this prevents an older shell or repository variable from overriding the source fallback at build time.
- Schedule CSP allows only `p.cqu.moe` in `script-src` and `connect-src` in addition to its existing Cloudflare Analytics sources. Production browser capture returned 200 for proxy-hosted config, flags, error capture, Web Vitals, surveys, recorder and `/e/` event requests. Auth production returned 200 for the same applicable proxy paths. No direct `us.i.posthog.com` or `us-assets.i.posthog.com` request appeared in these final traces.
- Official Node SDK canary `posthog_proxy_canary` was sent through `p.cqu.moe` and read back from project 608620 with `service=verification`, `environment=production`, `transport=managed_proxy`, release `d7362de`. This proves managed-proxy ingestion for a synthetic event; it is not real-user acceptance.

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

- Version 0.3.3 in package, lockfile and manifest.
- Static `posthog-js/dist/module.no-external`; remote dependency loading disabled; memory persistence; no pageview/autocapture/replay/surveys/tours/flags; random installation ID in `chrome.storage.local`.
- Only `https://p.cqu.moe/*` is allowed for PostHog transport, alongside the existing exact Auth and SSO origins. No collector is injected into Auth/CQU pages.
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
| QuickLogin | typecheck/test/build/package | passed; 18 files/84 tests; package gate 8 files and 3 manifest references; 0.3.3 ZIP integrity passed |
| Managed proxy | browser + SDK canary | Auth/Schedule dynamic SDK resources and `/e/` returned 200 only through `p.cqu.moe`; `posthog_proxy_canary` was read back in project 608620 |
| PostHog ingestion | unique smoke event and `$exception` | both read back with service `auth-worker`, environment `preview`, release `ab2dd1c` |
| PostHog Error Tracking | issue grouping | one active medium issue, one occurrence, library `posthog-node` |
| PostHog privacy | forbidden property query | password, cookie, token, student ID, email, schedule and subscription URL absent from taxonomy and null on both smoke rows |
| PostHog dashboards | forced fresh read | all three dashboards returned zero/no production data; preview/smoke data is excluded by saved filters |
| PostHog project | settings readback | timezone, IP anonymization, exception capture, performance, replay, 100% sample, masking and heatmaps confirmed |
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
- [CQU PostHog rollout analysis](https://us.posthog.com/project/608620/notebooks/vxKsuNZN) — notebook version 2 with production releases, dashboards, key analyses, controlled resources and activation boundaries.

## Product/function coverage

| Function | Status | Evidence or blocker |
|---|---|---|
| Error Tracking | 已验证 | Auth/Schedule production-tagged Worker exceptions ingested with release/service properties; Auth/Schedule Web source maps are present. Python, real browser and QuickLogin exception symbolization still await natural/authorized paths. |
| Web/Product Analytics | 已配置待真实数据 | Production code and tokens are deployed. Synthetic Worker release events are verified, but real login/binding/sync/QuickLogin events and stable browser pageviews are not; existing WAF blocked the automated browser after health checks. |
| Session Replay | 已配置待真实数据 | Project enabled at 100% per operator request; inputs and all text masked; application safe-route controls deployed. No recording has yet been inspected because the safe Auth page was WAF-blocked. Reduce sampling after enough representative recordings accumulate. |
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
- replay enabled at `1.00` (100%, raised from 10% on 2026-09-16); `maskAllInputs=true`; `maskTextSelector="*"`; no network payload capture configuration.
- heatmaps enabled.

## Remaining external configuration

- Auth/Schedule Worker runtime, Auth GitHub Actions and Schedule Git Connector PostHog values are configured and were exercised by production builds.
- Create Cloudflare OTLP destinations only after release authorization and log-field audit; documented endpoints are `/i/v1/logs` and `/i/v1/traces` with the project token.
- Add an explicit alert/uptime recipient or integration before enabling alerts and recovery notifications.

## Release and acceptance boundary

- Auth commits now include `a4f2d0e` (managed proxy), `9d73f00` (`asset_host`) and `d7362de` (CI build host pin).
- Schedule commits now include `402d008` (managed proxy), `cd395f8` (proxy CSP), `3258e99` (`asset_host`) and `f83cd88` (build host pin).
- QuickLogin commit `27d7693` releases 0.3.3 with managed-proxy transport and expected-state exception suppression.
- QuickLogin tokenized local artifact: `releases/cqu-quicklogin-0.3.3-canary.zip`, SHA-256 `e60af524c917dd5478c48c3de5333c40648ee9d259500d9ed30dbab0d131cc21`, 8 files and 3 manifest references. `unzip -t` found no errors. Its files are staged in the loaded Chrome/Ego directories but have not been reloaded or uploaded to the Store.
- All three `codex/posthog-fresh` branches and all three `main` branches were pushed. Auth/Schedule production, managed-proxy browser assets and source maps were deployed. Extension Reload, Chrome Web Store action, alert notification, OTLP destination and uptime monitor were not performed.
- Auth and Schedule health/version/managed-proxy acceptance passed. Targeted synthetic-cookie Auth GET/POST acceptance passed. A real credential login, CQU binding, one real Schedule sync, QuickLogin 0.3.3 Reload/operation, replay inspection and failure/recovery alerts remain manual/traffic-dependent acceptance gates. No real password, OTP or CAPTCHA flow was exercised by the agent.
- Rollback begins by disabling telemetry/replay/export, then uses normal Git revert and release. The pre-change Cloudflare version IDs above are the current rollback references.
